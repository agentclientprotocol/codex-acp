"""Native durable queue checks, invoked by the isolated queue-only probe.

No native method replacement, synthetic ACP notifications, rollout edits, or
second scheduler. Scripted model responses only; all queue actions cross ACP.
"""
import threading
import time


def run_queue_probe(probe):
    # probe.py runs as __main__; use its helpers without importing a second copy.
    from __main__ import TIMEOUT, require, save

    model, c = probe.model, probe.rpc
    actions = ["list", "add", "update", "delete", "reorder", "start"]
    capability = c.init.get("_meta", {}).get("queue", {})
    require(capability.get("method") == "_session/queue", capability)
    require(capability.get("version") == 1 and capability.get("actions") == actions, capability)
    require(capability.get("changedNotification") == "_session/queue/changed"
            and capability.get("turnNotification") == "_session/queue/turn", capability)
    probe.step("queue_production_capabilities_six_actions", capability=capability)
    sid = c.new()
    evidence = {"sessionId": sid, "capability": capability}

    def q(action, **params):
        response = c.call("_session/queue", {"sessionId": sid, "action": action, **params})
        require(response.get("status") == "ok", response)
        return response["result"]

    def text(value):
        return [{"type": "text", "text": value, "text_elements": []}]

    def add(value):
        item = q("add", input=text(value), clientUserMessageId="client-" + value)["queuedSubmission"]
        require(item.get("id") and item.get("clientUserMessageId") == "client-" + value, item)
        return item

    def listed(session_id=None):
        page = q("list", sessionId=session_id or sid)
        require(page.get("nextCursor") is None, page)
        return page["data"]

    def gate(value, held=False):
        result = {"input": value, "answer": "ANSWER_" + value,
                  "seen": threading.Event(), "release": threading.Event(), "done": threading.Event()}
        if not held:
            result["release"].set()
        model.gates.append(result)
        return result

    def wait(predicate, label, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            require(not model.errors, model.errors)
            require(c.p.poll() is None, "ACP exited while waiting for " + label)
            if predicate():
                return
            time.sleep(0.02)
        raise AssertionError("Timed out waiting for " + label)

    def turns(start):
        return [entry["message"]["params"]["turn"] for entry in c.trace[start:]
                if entry["direction"] == "in" and entry["message"].get("method") == "_session/queue/turn"
                and entry["message"]["params"].get("sessionId") == sid]

    def completed(start, count):
        wait(lambda: len([t for t in turns(start) if t.get("status") == "completed"]) >= count,
             f"{count} completed queue turns")
        events = turns(start)
        ids = [t["id"] for t in events if t.get("status") == "completed"]
        require(len(ids) == count and len(set(ids)) == count, events)
        for ident in ids:
            require([t["status"] for t in events if t["id"] == ident] == ["inProgress", "completed"], events)
        return ids

    def live_answers(start, expected):
        chunks = [entry["message"]["params"]["update"].get("content", {}).get("text", "")
                  for entry in c.trace[start:] if entry["direction"] == "in"
                  and entry["message"].get("method") == "session/update"
                  and entry["message"]["params"].get("sessionId") == sid
                  and entry["message"]["params"]["update"].get("sessionUpdate") == "agent_message_chunk"]
        received = "".join(chunks)
        require(all(received.count(value) == 1 for value in expected), {"expected": expected, "received": received})
        require([received.index(value) for value in expected] == sorted(received.index(value) for value in expected), received)

    def refused_unchanged(label, action, *, session_id=None, error_code=None, deleted_false=False, **params):
        target = session_id or sid
        sessions = list(dict.fromkeys([sid, target]))
        before = {ident: listed(ident) for ident in sessions}
        count, marker = len(model.requests), len(c.trace)
        response = c.raw("_session/queue", {"sessionId": target, "action": action, **params})
        if deleted_false:
            require("error" not in response and response.get("result", {}).get("status") == "ok"
                    and response["result"].get("result", {}).get("deleted") is False, {"case": label, "response": response})
        else:
            error = response.get("error", {})
            require("result" not in response and error.get("code") in (-32600, -32602),
                    {"case": label, "response": response})
            if error_code is not None:
                require(error["code"] == error_code, {"case": label, "response": response})
        after = {ident: listed(ident) for ident in sessions}
        require(after == before, {"case": label, "before": before, "after": after})
        require(len(model.requests) == count and not model.errors, "Rejected operation generated: " + label)
        require(not any(entry["direction"] == "in" and entry["message"].get("method") == "_session/queue/turn"
                        and entry["message"].get("params", {}).get("sessionId") in sessions
                        for entry in c.trace[marker:]), "Rejected operation emitted a queue turn: " + label)
        evidence.setdefault("rejectedOperations", []).append({"case": label, "response": response, "preserved": after})

    # A brand-new session must own and stream queued work before any ordinary
    # prompt installs prompt-local handlers. No session/load replay is involved.
    early = gate("QUEUE_EARLY_IDLE")
    model.arm(early)
    marker = len(c.trace)
    add(early["input"])
    evidence["earlyIdleTurns"] = completed(marker, 1)
    live_answers(marker, [early["answer"]])
    require(listed() == [], "First idle add did not drain")
    require(not any(entry["direction"] == "out" and entry["message"].get("method") == "session/prompt"
                    for entry in c.trace), "Early idle test ran after an ordinary prompt")
    model.check()
    probe.step("queue_first_idle_add_streams_before_any_ordinary_prompt", turnIds=evidence["earlyIdleTurns"])

    # Ordinary prompt owns A; its completion must hand B to the durable owner
    # before A's finally block can erase B's state.
    initial = gate("QUEUE_INITIAL", held=True)
    model.arm(initial)
    marker = len(c.trace)
    prompt = c.send("session/prompt", {"sessionId": sid, "prompt": text(initial["input"])})
    wait(initial["seen"].is_set, "gated normal prompt")
    a, b, removed = add("QUEUE_A"), add("QUEUE_B"), add("QUEUE_DELETE")
    changed = q("update", queuedSubmissionId=a["id"], input=text("QUEUE_A_EDITED"))["queuedSubmission"]
    require(changed["id"] == a["id"] and changed["clientUserMessageId"] == a["clientUserMessageId"], changed)
    require(changed["input"] == text("QUEUE_A_EDITED"), changed)
    q("reorder", queuedSubmissionIds=[b["id"], a["id"], removed["id"]])
    require(q("delete", queuedSubmissionId=removed["id"]).get("deleted") is True, "Delete did not remove entry")
    require([i["id"] for i in listed()] == [b["id"], a["id"]], "Native reorder/list disagreed")
    # The ordinary turn is held, so rejected reorder calls cannot be confused
    # with successful consumption. Compare entire records, including order.
    refused_unchanged("reorder_missing_ids", "reorder", error_code=-32602)
    refused_unchanged("reorder_non_array", "reorder", error_code=-32602, queuedSubmissionIds=b["id"])
    refused_unchanged("reorder_malformed_id", "reorder", error_code=-32602, queuedSubmissionIds=[b["id"], None])
    refused_unchanged("reorder_duplicate_ids", "reorder", queuedSubmissionIds=[b["id"], b["id"]])
    refused_unchanged("reorder_stale_deleted_id", "reorder", queuedSubmissionIds=[b["id"], removed["id"]])
    refused_unchanged("reorder_missing_current_id", "reorder", queuedSubmissionIds=[b["id"]])
    refused_unchanged("reorder_extra_stale_id", "reorder", queuedSubmissionIds=[b["id"], a["id"], removed["id"]])
    probe.step("queue_invalid_reorders_preserve_entries_and_order")
    require(not any(t.get("status") == "inProgress" for t in turns(marker)), "Queued work started during gated prompt")
    first, second = gate("QUEUE_B", held=True), gate("QUEUE_A_EDITED")
    model.arm(first, second)
    initial["release"].set()
    response = c.response(prompt)
    require(response.get("result", {}).get("stopReason") == "end_turn", response)
    wait(first["seen"].is_set, "first auto queue turn")
    first["release"].set()
    evidence["autoTurns"] = completed(marker, 2)
    live_answers(marker, [initial["answer"], first["answer"], second["answer"]])
    require(listed() == [], "Auto-dispatched queue did not drain")
    require(any(e["direction"] == "in" and e["message"].get("method") == "_session/queue/changed"
                and e["message"].get("params", {}).get("sessionId") == sid
                for e in c.trace[marker:]), "Missing queue invalidation for this session")
    model.check()
    probe.step("queue_add_update_reorder_delete_then_auto_dispatch_live_output", turnIds=evidence["autoTurns"])

    marker = len(c.trace)
    blocked = gate("QUEUE_CANCEL", held=True)
    model.arm(blocked)
    add(blocked["input"])
    wait(blocked["seen"].is_set, "queue turn to cancel")
    wait(lambda: any(t.get("status") == "inProgress" for t in turns(marker)), "cancel target native start")
    pending_a, pending_b = add("QUEUE_REMAIN_A"), add("QUEUE_REMAIN_B")
    c.notify("session/cancel", {"sessionId": sid})
    wait(lambda: any(t.get("status") == "interrupted" for t in turns(marker)), "native interrupted queue notification")
    require([t["status"] for t in turns(marker)] == ["inProgress", "interrupted"], turns(marker))
    require(len({t["id"] for t in turns(marker)}) == 1, "Interrupted notification targeted another turn")
    require([i["id"] for i in listed()] == [pending_a["id"], pending_b["id"]], "Cancel lost remaining queue")
    count = len(model.requests)
    blocked["release"].set()
    wait(blocked["done"].is_set, "cancelled fixture response cleanup")
    # Exercise an idle native start, not the active-turn guard. No model reply
    # is armed: a fallback to the head entry must fail this fixture.
    preserved = listed()
    negative_marker = len(c.trace)
    refused_unchanged("start_unknown_id", "start", queuedSubmissionId="missing-native-queue-item")
    # A valid second session makes cross-session IDs meaningful. Deleting a
    # foreign entry is a native no-op (deleted:false), not a JSON-RPC error.
    other_sid = c.new()
    require(other_sid != sid and listed(other_sid) == [], "Expected a distinct empty session")
    refused_unchanged("update_wrong_session", "update", session_id=other_sid,
                      queuedSubmissionId=pending_a["id"], input=text("MUST_NOT_REPLACE_PENDING"))
    refused_unchanged("delete_wrong_session", "delete", session_id=other_sid,
                      queuedSubmissionId=pending_a["id"], deleted_false=True)
    refused_unchanged("reorder_wrong_session", "reorder", session_id=other_sid,
                      queuedSubmissionIds=[pending_b["id"], pending_a["id"]])
    refused_unchanged("start_wrong_session", "start", session_id=other_sid,
                      queuedSubmissionId=pending_a["id"])
    # Span the native external-queue watcher period. No queued model action is
    # armed: neither cancel nor a rejected start may permit a delayed restart.
    until = time.monotonic() + 10.5
    while time.monotonic() < until:
        require(len(model.requests) == count and not model.errors, "Queue advanced after cancel")
        require(c.p.poll() is None, "ACP exited during rejected-start observation")
        time.sleep(0.05)
    require(listed() == preserved and listed(other_sid) == [], "Rejected operations changed a queue after settling")
    require(not any(entry["direction"] == "in" and entry["message"].get("method") == "_session/queue/turn"
                    and entry["message"].get("params", {}).get("sessionId") in (sid, other_sid)
                    for entry in c.trace[negative_marker:]), "Rejected start emitted a delayed queue turn")
    model.check()
    probe.step("queue_unknown_start_and_cross_session_ids_preserve_both_queues")
    probe.step("queue_cancel_preserves_pending_and_suppresses_automatic_dispatch")

    marker = len(c.trace)
    selected, remaining = gate("QUEUE_REMAIN_B"), gate("QUEUE_REMAIN_A")
    model.arm(selected, remaining)
    start = q("start", queuedSubmissionId=pending_b["id"])
    ids = completed(marker, 2)
    require(start["turn"]["id"] == ids[0] and start["turn"]["status"] == "inProgress", start)
    live_answers(marker, [selected["answer"], remaining["answer"]])
    require(listed() == [], "Explicit non-head start did not drain remaining queue")
    model.check()
    probe.step("queue_explicit_non_head_start_then_drain", turnIds=ids)

    # Stop the entire owned ACP/native tree: a fresh client has no local session
    # and list/add/update must operate against persisted storage without resume.
    # session/close only unsubscribes; it is NOT evidence of native unload.
    # restart() waits for and verifies the old native process exit. Never replace
    # this barrier with a fixed sleep or an immediate add after session/close.
    closed_client = c
    c.call("session/close", {"sessionId": sid})
    c = probe.restart()
    require(closed_client.p.poll() == 0 and c is not closed_client,
            "Cold queue writes require verified previous process termination")
    evidence["coldWriteBarrier"] = {"oldClient": closed_client.number,
                                    "newClient": c.number, "oldExitCode": closed_client.p.returncode}
    count = len(model.requests)
    require(listed() == [], "Expected empty cold queue before persisted add")
    cold = add("QUEUE_PERSIST_ORIGINAL")
    cold = q("update", queuedSubmissionId=cold["id"], input=text("QUEUE_PERSIST_EDITED"))["queuedSubmission"]
    require(cold["clientUserMessageId"] == "client-QUEUE_PERSIST_ORIGINAL", cold)
    require(cold["input"] == text("QUEUE_PERSIST_EDITED"), cold)
    require(listed() == [cold] and len(model.requests) == count, "Closed-session operations resumed or changed persisted queue")
    c = probe.restart()
    require(listed() == [cold] and len(model.requests) == count, "Pending queue did not persist across native process restart")
    probe.step("queue_closed_session_add_update_list_persist_across_restart", queuedSubmission=cold)

    marker = len(c.trace)
    resumed = gate("QUEUE_PERSIST_EDITED")
    model.arm(resumed)
    # Public reload must install a queue owner and generate the persisted input.
    result = c.call("session/load", {"sessionId": sid, "cwd": str(probe.work), "mcpServers": []})
    require(result.get("sessionId", sid) == sid, result)
    ids = completed(marker, 1)
    live_answers(marker, [resumed["answer"]])
    require(listed() == [], "Reload did not consume persisted native queue")
    model.check()
    probe.step("queue_reload_installs_owner_and_auto_dispatches_persisted_input", turnIds=ids)
    evidence["reloadTurns"] = ids
    save(probe.run / "queue-evidence.json", evidence)
