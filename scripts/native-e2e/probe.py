"""Real ACP/native processes over stdio, with a scripted loopback Responses server.

Only the model is fake. Never read native rollout files, write ACP history, or
execute file tools in the test client. Invoke through ../native-e2e.mjs so every
run is fresh and bound to a just-built artifact. Python 3 standard library only.
"""
import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback


PATCH = "*** Begin Patch\n*** Update File: changed.txt\n@@\n-old line\n+native edited line\n*** End Patch\n"
CALL_ID = "native-e2e-apply-patch"
TIMEOUT = 35
FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def require(condition, message):
    # Do not use assert: python -O must still fail a broken native test.
    if not condition:
        raise AssertionError(message)


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def save(file, value):
    Path(file).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def points(updates, kind="user_message_chunk"):
    grouped = {}
    for update in updates:
        if update.get("sessionUpdate") != kind:
            continue
        mid = update.get("messageId")
        content = update.get("content", {})
        require(mid and content.get("type") == "text", f"Missing native text identity: {update}")
        grouped[mid] = grouped.get(mid, "") + content["text"]
    seen, result = {}, []
    for mid, text in grouped.items():
        fingerprint = "sha256:" + hashlib.sha256(text.encode()).hexdigest()
        seen[fingerprint] = seen.get(fingerprint, 0) + 1
        result.append({"messageId": mid, "messageFingerprint": fingerprint,
                       "messageOccurrence": seen[fingerprint], "text": text})
    return result


def point(value):
    return {key: val for key, val in value.items() if key != "text"}


class Model:
    def __init__(self, wrong_reply=False):
        self.requests, self.title_requests, self.errors, self.blocked = [], [], [], []
        self.wrong_reply, self.injected, self.expected_answers = wrong_reply, False, []
        self.pending = queue.Queue()
        self.seen, self.release = threading.Event(), threading.Event()
        self.lock = threading.Lock()
        self.tool_route = None
        owner = self

        class Deny(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reject(self):
                owner.blocked.append({"method": self.command, "target": self.path})
                self.send_error(502, "Native E2E denies external HTTP egress")

            do_CONNECT = do_GET = do_POST = reject

        class Responses(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    require(self.path == "/v1/responses", f"Unexpected model path: {self.path}")
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    if self.headers.get("Content-Encoding") == "gzip":
                        raw = gzip.decompress(raw)
                    body = json.loads(raw)
                    require("Authorization" not in self.headers, "Unexpected model credentials")
                    # The adapter also makes ephemeral title turns. Recognize the
                    # actual schema AND title instruction, never just a model name
                    # or a sentinel that could appear in discarded user history.
                    schema = body.get("text", {}).get("format", {}).get("schema", {})
                    title = (schema.get("required") == ["title"]
                             and schema.get("properties") == {"title": {"type": "string"}}
                             and "Your task is to generate a very short title for a conversation" in json.dumps(body.get("input", [])))
                    with owner.lock:
                        target = owner.title_requests if title else owner.requests
                        target.append({"path": self.path, "body": body})
                        number = len(owner.requests) + len(owner.title_requests)
                    if title:
                        require(len(owner.title_requests) <= 8, "Unexpected title request loop")
                        action = "title"
                    else:
                        try:
                            action = owner.pending.get_nowait()
                        except queue.Empty:
                            raise AssertionError("Unsolicited model request (rewind/load must not resend)")
                    if action == "hold":
                        owner.seen.set()
                        require(owner.release.wait(TIMEOUT), "Held request was not released")
                    events = [{"type": "response.created", "response": {"id": f"resp-{number}"}}]
                    if action == "patch":
                        found = []

                        def inspect(tools, namespace=None):
                            for tool in tools:
                                if tool.get("type") == "namespace":
                                    inspect(tool.get("tools", []), tool.get("name"))
                                elif tool.get("name") == "apply_patch":
                                    found.append((tool, namespace))

                        inspect(body.get("tools", []))
                        require(len(found) == 1 and found[0][0].get("type") == "custom",
                                "Native must advertise one custom apply_patch tool")
                        tool, namespace = found[0]
                        owner.tool_route = {"name": tool["name"], "type": tool["type"], "namespace": namespace}
                        item = {"type": "custom_tool_call", "id": "fc-" + CALL_ID, "call_id": CALL_ID,
                                "name": "apply_patch", "input": PATCH}
                        if namespace:
                            item["namespace"] = namespace
                        events.extend([
                            {"type": "response.output_item.added", "item": {**item, "input": "", "status": "in_progress"}},
                            {"type": "response.custom_tool_call_input.delta", "item_id": item["id"], "call_id": CALL_ID, "delta": PATCH},
                            {"type": "response.output_item.done", "item": item},
                        ])
                    else:
                        answer = '{"title":"Local native fixture"}' if title else f"LOCAL_ANSWER_{number}"
                        if not title:
                            owner.expected_answers.append(answer)
                            if owner.wrong_reply and not owner.injected:
                                answer = "INJECTED_WRONG_REPLY"
                                owner.injected = True
                        events.append({"type": "response.output_item.done", "item": {
                            "type": "message", "role": "assistant", "id": f"msg-{number}",
                            "content": [{"type": "output_text", "text": answer}]}})
                    events.append({"type": "response.completed", "response": {
                        "id": f"resp-{number}", "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}}})
                    data = "".join("data: " + json.dumps(event) + "\n\n" for event in events).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass  # Expected after cancellation of the held native turn.
                except Exception as error:
                    owner.errors.append(str(error))
                    self.send_error(500, "Local fixture failed; see report.json")

        self.proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Deny)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Responses)
        for server in (self.proxy, self.server):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def arm(self, *actions):
        require(self.pending.empty(), "Previous prompt did not consume its expected model calls")
        for action in actions:
            self.pending.put(action)

    def check(self):
        require(not self.errors, f"Local model errors: {self.errors}")
        require(self.pending.empty(), "Missing expected model call")

    def close(self):
        self.release.set()
        for server in (self.proxy, self.server):
            server.shutdown()
            server.server_close()


class Rpc:
    def __init__(self, probe):
        self.probe = probe
        self.seq, self.stash, self.trace = 0, {}, []
        self.incoming = queue.Queue()
        self.closed = False
        self.number = len(probe.clients)
        probe.clients.append(self)
        self.stderr = (probe.run / f"stderr-{self.number}.log").open("w", encoding="utf8")
        self.p = subprocess.Popen(
            [probe.meta["node"], str(probe.repo / "dist/index.js")], cwd=probe.work, env=probe.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, encoding="utf8", creationflags=FLAGS, start_new_session=os.name != "nt")
        self.reader_thread = threading.Thread(target=self.reader, daemon=True)
        self.reader_thread.start()
        self.init = self.call("initialize", {
            "protocolVersion": 1, "clientInfo": {"name": "isolated-native-e2e", "version": "1"},
            "clientCapabilities": {"_meta": {"jetbrains": {"air": {
                "version": 1, "capabilities": [] if probe.meta["mode"] == "rewind-only" else ["diffPatch"]}}}}})

    def reader(self):
        try:
            for line in self.p.stdout:
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self.incoming.put(RuntimeError(f"Non-JSON ACP stdout: {line[:200]}"))
                    continue
                self.trace.append({"direction": "in", "message": message})
                self.incoming.put(message)
        finally:
            self.incoming.put(RuntimeError("ACP stdout closed before requested response"))

    def write(self, message):
        self.trace.append({"direction": "out", "message": message})
        self.p.stdin.write(json.dumps(message) + "\n")
        self.p.stdin.flush()

    def send(self, method, params):
        self.seq += 1
        self.write({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params})
        return self.seq

    def notify(self, method, params):
        self.write({"jsonrpc": "2.0", "method": method, "params": params})

    def response(self, ident):
        if ident in self.stash:
            return self.stash.pop(ident)
        deadline = time.monotonic() + TIMEOUT
        while True:
            try:
                message = self.incoming.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise TimeoutError(f"ACP response {ident} timed out; inspect stderr-{self.number}.log")
            if isinstance(message, Exception):
                raise message
            if "id" in message and "method" in message:
                # Never emulate native apply_patch or other host tools.
                self.write({"jsonrpc": "2.0", "id": message["id"], "error": {
                    "code": -32601, "message": "Native E2E client tools disabled"}})
                self.probe.client_requests.append(message)
            elif "id" in message:
                if message["id"] == ident:
                    return message
                self.stash[message["id"]] = message
            require(time.monotonic() < deadline, f"ACP response {ident} timed out")

    def raw(self, method, params):
        return self.response(self.send(method, params))

    def call(self, method, params):
        message = self.raw(method, params)
        require("error" not in message, f"{method}: {message}")
        return message["result"]

    def new(self):
        return self.call("session/new", {"cwd": str(self.probe.work), "mcpServers": []})["sessionId"]

    def prompt(self, sid, text, patch=False):
        self.probe.model.arm(*(["patch", "answer"] if patch else ["answer"]))
        result = self.call("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
        require(result.get("stopReason") == "end_turn", result)
        self.probe.model.check()
        # The scripted SSE emits a completed item rather than text deltas.
        # Verify the persisted native answer through the real ACP replay route.
        answers = points(self.load(sid), "agent_message_chunk")
        actual = answers[-1]["text"] if answers else ""
        expected = self.probe.model.expected_answers[-1]
        require(actual == expected, f"Assistant reply mismatch: expected {expected!r}, received {actual!r}")
        return result

    def load(self, sid):
        start = len(self.trace)
        count = len(self.probe.model.requests)
        result = self.call("session/load", {"sessionId": sid, "cwd": str(self.probe.work), "mcpServers": []})
        updates = [entry["message"]["params"] for entry in self.trace[start:]
                   if entry["direction"] == "in" and entry["message"].get("method") == "session/update"]
        require(all(value["sessionId"] == sid for value in updates), "Load changed session ID")
        require(result.get("sessionId", sid) == sid, "Load returned another session ID")
        require(len(self.probe.model.requests) == count, "Load resent a prompt")
        self.probe.model.check()
        return [value["update"] for value in updates]

    def rewind(self, sid, before, resume=None):
        request = {"sessionId": sid, "beforeMessage": point(before)}
        if resume:
            request["resumeAtMessage"] = point(resume)
        count = len(self.probe.model.requests)
        result = self.call("_session/rewind", request)
        require(result.get("rewound") is True, result)
        require(result.get("sessionId", sid) == sid, result)
        require(len(self.probe.model.requests) == count, "Rewind resent a prompt")
        return result

    def stop(self):
        if self.closed:
            return
        self.closed = True
        forced = False
        try:
            self.p.stdin.close()
            try:
                self.p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                forced = True
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(self.p.pid), "/T", "/F"],
                                   env=self.probe.env, capture_output=True, timeout=6, creationflags=FLAGS)
                else:
                    os.killpg(self.p.pid, signal.SIGKILL)
                self.p.wait(timeout=5)
            self.reader_thread.join(timeout=2)
        finally:
            self.stderr.close()
            self.probe.exits.append({"client": self.number, "pid": self.p.pid,
                                     "exitCode": self.p.returncode, "forced": forced})
        require(not forced and self.p.returncode == 0, f"ACP did not shut down cleanly: {self.probe.exits[-1]}")
        # Confirm the old provider exited before opening a replacement ACP
        # process. A later final check alone could miss overlapping providers.
        entries = [json.loads(line) for line in (self.probe.run / "spawns.jsonl").read_text(encoding="utf8").splitlines()]
        owned = {self.p.pid}
        while True:
            children = {entry.get("pid") for entry in entries
                        if entry["event"] == "spawn" and entry.get("parentPid") in owned}
            expanded = owned | (children - {None})
            if expanded == owned:
                break
            owned = expanded
        native = [entry for entry in entries if entry["event"] == "spawn" and entry.get("pid") in owned
                  and Path(entry["file"]).resolve() == Path(self.probe.meta["native"]).resolve()]
        exited = {entry["pid"] for entry in entries if entry["event"] == "exit"}
        require(len(native) == 1 and native[0]["pid"] in exited, "Owned native must exit before cold restart")


class Probe:
    def __init__(self, manifest):
        self.meta = json.loads(manifest.read_text(encoding="utf8"))
        self.repo, self.run = Path(self.meta["repo"]), Path(self.meta["run"])
        self.home, self.work = self.run / "home", self.run / "workspace"
        self.clients, self.exits, self.steps, self.client_requests = [], [], [], []
        self.model = Model(self.meta.get("wrongReply", False))
        self.env = dict(os.environ)  # Launcher already replaced, not merged, the user's environment.
        # Narrow runtime PATH to required programs and OS utilities.
        self.git = shutil.which("git")
        require(self.git or self.meta["mode"] == "rewind-only", "Git is required for file revert")
        paths = [str(Path(self.meta["node"]).parent)]
        if self.git:
            paths.append(str(Path(self.git).parent))
        paths += [str(Path(os.environ["SYSTEMROOT"]) / "System32")] if os.name == "nt" else ["/usr/bin", "/bin"]
        self.env["PATH"] = os.pathsep.join(dict.fromkeys(paths))
        proxy = f"http://127.0.0.1:{self.model.proxy.server_port}"
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            self.env[key] = proxy
        self.env.update(NO_PROXY="127.0.0.1,localhost,::1", no_proxy="127.0.0.1,localhost,::1")
        provider = {"name": "Native E2E loopback", "base_url": f"http://127.0.0.1:{self.model.server.server_port}/v1",
                    "wire_api": "responses", "requires_openai_auth": False,
                    "request_max_retries": 0, "stream_max_retries": 0}
        # This installed model profile advertises the freeform native apply_patch.
        # The profile name selects tool metadata only; no real model is contacted.
        config = {"model": "gpt-5.5", "model_provider": "mock", "model_providers": {"mock": provider},
                  "approval_policy": "never", "sandbox_mode": "danger-full-access",
                  "features": {"shell_snapshot": False, "remote_models": False, "plugins": False, "code_mode": False}}
        self.env.update(CODEX_PATH=self.meta["native"], MODEL_PROVIDER="mock", CODEX_CONFIG=json.dumps(config),
                        INITIAL_AGENT_MODE="agent-full-access", NO_BROWSER="1",
                        NODE_OPTIONS='--require=' + json.dumps(str(self.repo / "scripts/native-e2e/spawn-audit.cjs")),
                        NATIVE_E2E_SPAWN_LOG=str(self.run / "spawns.jsonl"))
        (self.home / "config.toml").write_text(
            'model = "gpt-5.5"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
            '[features]\nshell_snapshot = false\nremote_models = false\nplugins = false\ncode_mode = false\n'
            '[model_providers.mock]\n' + "\n".join(f"{key} = {json.dumps(value)}" for key, value in provider.items()) + "\n",
            encoding="utf8")
        self.rpc = None

    def step(self, name, **details):
        self.steps.append({"name": name, "passed": True, **details})
        print("PASS " + name, flush=True)

    def start(self):
        self.rpc = Rpc(self)
        return self.rpc

    def restart(self):
        self.rpc.stop()
        self.verify_build()
        return self.start()

    def verify_build(self):
        require(sha(self.repo / "dist/index.js") == self.meta["distSha256"], "Build changed during probe; rerun")
        require(sha(self.meta["native"]) == self.meta["nativeSha256"], "Native changed during probe; rerun")
        current_names = {str(file.relative_to(self.repo)) for file in (self.repo / "src").rglob("*") if file.is_file()}
        current_names.update(["package.json", "package-lock.json", "build.mjs"])
        require(current_names == set(self.meta["sources"]), "Source file set changed during probe; rerun")
        for name, expected in self.meta["sources"].items():
            require(sha(self.repo / name) == expected, f"Source changed during probe: {name}; rerun")

    def context(self, present, absent=()):
        body = json.dumps(self.model.requests[-1]["body"].get("input", []))
        require(all(text in body for text in present), f"Missing model context: {present}")
        require(all(text not in body for text in absent), f"Discarded context sent to model: {absent}")
        return body

    def history(self):
        c = self.start()
        capabilities = c.init.get("_meta", {}).get("jetbrains", {}).get("air", {}).get("capabilities", [])
        require("sessionRewind" in capabilities, "AIR rewind capability not advertised")
        sid = c.new()
        for text in ("KEEP_FIRST", "DROP_SECOND", "DROP_THIRD"):
            c.prompt(sid, text)
        updates = c.load(sid)
        users, agents = points(updates), points(updates, "agent_message_chunk")
        require([u["text"] for u in users] == ["KEEP_FIRST", "DROP_SECOND", "DROP_THIRD"], users)
        self.step("native_history_identities", sessionId=sid, users=users)
        bad = {**point(users[1]), "messageFingerprint": "sha256:" + "0" * 64}
        count = len(self.model.requests)
        for request in ({"sessionId": sid, "beforeMessage": bad},
                        {"sessionId": "unknown-session", "beforeMessage": point(users[1])},
                        {"sessionId": sid, "beforeMessage": {**point(users[1]), "messageId": "missing-id", "messageFingerprint": bad["messageFingerprint"]}}):
            result = c.raw("_session/rewind", request)
            require("error" in result, result)
        require(points(c.load(sid)) == users and len(self.model.requests) == count, "Bad target mutated history")
        self.step("bad_targets_preserve_history_and_do_not_resend")
        c.rewind(sid, users[1], agents[0])
        c = self.restart()
        retained = points(c.load(sid))
        require([u["text"] for u in retained] == ["KEEP_FIRST"], retained)
        require(len(self.model.requests) == count, "Historical cold restart resent prompt")
        self.step("historical_same_id_cold_restart_no_resend", sessionId=sid, retained=retained)
        c.prompt(sid, "EDITED_SECOND")
        self.context(["KEEP_FIRST", "EDITED_SECOND"], ["DROP_SECOND", "DROP_THIRD"])
        self.step("historical_resend_model_context")
        updates = c.load(sid)
        users, agents = points(updates), points(updates, "agent_message_chunk")
        count = len(self.model.requests)
        stale_latest = point(users[-1])
        c.rewind(sid, users[-1], agents[-2])
        c = self.restart()
        require([u["text"] for u in points(c.load(sid))] == ["KEEP_FIRST"] and len(self.model.requests) == count,
                "Latest rewind/cold restart did not retain exactly the prefix without resend")
        self.step("latest_same_id_cold_restart_no_resend", sessionId=sid)
        stale = c.raw("_session/rewind", {"sessionId": sid, "beforeMessage": stale_latest})
        require("error" in stale, stale)
        require([u["text"] for u in points(c.load(sid))] == ["KEEP_FIRST"] and len(self.model.requests) == count,
                "Stale removed target mutated/resubmitted history")
        self.step("stale_removed_target_rejected_after_cold_restart")
        c.prompt(sid, "EDITED_LATEST")
        self.context(["KEEP_FIRST", "EDITED_LATEST"], ["EDITED_SECOND", "DROP_SECOND", "DROP_THIRD"])
        self.step("latest_resend_model_context")
        users = points(c.load(sid))
        count = len(self.model.requests)
        c.rewind(sid, users[0])
        c = self.restart()
        require(points(c.load(sid)) == [] and len(self.model.requests) == count, "First rewind retained/resubmitted history")
        self.step("first_same_id_cold_restart_no_resend", sessionId=sid)
        c.prompt(sid, "EDITED_FIRST")
        self.context(["EDITED_FIRST"], ["KEEP_FIRST", "EDITED_SECOND", "EDITED_LATEST", "DROP_SECOND", "DROP_THIRD"])
        self.step("first_resend_model_context")
        target = points(c.load(sid))[0]
        self.model.seen.clear()
        self.model.release.clear()
        self.model.arm("hold")
        prompt_id = c.send("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "ACTIVE_TURN"}]})
        require(self.model.seen.wait(10), "Active prompt did not reach local model")
        c.rewind(sid, target)
        interrupted = c.response(prompt_id)
        require(interrupted.get("result", {}).get("stopReason") == "cancelled", interrupted)
        self.model.release.set()
        self.model.check()
        c = self.restart()
        require(points(c.load(sid)) == [], "Busy rewind did not persist empty history")
        c.prompt(sid, "AFTER_CANCEL")
        self.context(["AFTER_CANCEL"], ["ACTIVE_TURN", "EDITED_FIRST"])
        self.step("active_rewind_cancels_native_turn_and_cold_resumes_same_id")
        # Repeated text must use occurrence/native identity, not substring matching.
        c.prompt(sid, "REPEATED_TARGET")
        c.prompt(sid, "REPEATED_TARGET")
        updates = c.load(sid)
        users, agents = points(updates), points(updates, "agent_message_chunk")
        c.rewind(sid, users[-1], agents[-2])
        c = self.restart()
        require([u["text"] for u in points(c.load(sid))] == ["AFTER_CANCEL", "REPEATED_TARGET"], "Repeated target boundary lost")
        c.prompt(sid, "REPLACED_DUPLICATE")
        require(self.context(["AFTER_CANCEL", "REPEATED_TARGET", "REPLACED_DUPLICATE"]).count("REPEATED_TARGET") == 1,
                "Duplicate target survived rewind")
        self.step("duplicate_exact_identity_cold_restart_resend")
        self.model.seen.clear()
        self.model.release.clear()
        self.model.arm("hold")
        prompt_id = c.send("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "EXPLICIT_CANCEL"}]})
        require(self.model.seen.wait(10), "Cancel fixture did not reach model")
        c.notify("session/cancel", {"sessionId": sid})
        interrupted = c.response(prompt_id)
        require(interrupted.get("result", {}).get("stopReason") == "cancelled", interrupted)
        self.model.release.set()
        c.prompt(sid, "AFTER_EXPLICIT_CANCEL")
        self.context(["AFTER_EXPLICIT_CANCEL"])
        self.step("explicit_cancel_and_same_session_continue")

    def git_command(self, *args):
        result = subprocess.run([self.git, *args], cwd=self.work, env=self.env,
                                capture_output=True, timeout=30, creationflags=FLAGS)
        require(result.returncode == 0, result.stderr.decode("utf8", errors="replace"))
        return result.stdout

    def files(self):
        return {name: sha(self.work / name) for name in ("changed.txt", "user.txt", "untracked.txt", ".git/index")}

    def file_revert(self):
        self.git_command("init", "-q")
        self.git_command("config", "core.autocrlf", "false")
        (self.work / "changed.txt").write_bytes(b"old line\n")
        (self.work / "user.txt").write_bytes(b"tracked original\n")
        self.git_command("add", "--", "changed.txt", "user.txt")
        self.git_command("-c", "user.name=Native E2E", "-c", "user.email=fixture@invalid",
                         "-c", "commit.gpgsign=false", "commit", "-qm", "isolated fixture")
        (self.work / "user.txt").write_bytes(b"unrelated staged user content\n")
        self.git_command("add", "--", "user.txt")
        (self.work / "user.txt").write_bytes(b"unrelated unstaged user content\n")
        (self.work / "untracked.txt").write_bytes(b"unrelated untracked user content\n")
        initial = self.files()
        c = self.rpc
        capability = c.init.get("_meta", {}).get("fileRevert", {})
        require(capability.get("method") == "_session/files/revert" and capability.get("previewTokenRequired"), capability)
        sid = c.new()
        start = len(self.model.requests)
        c.prompt(sid, "APPLY_SYNTHETIC_PATCH", patch=True)
        require(len(self.model.requests) == start + 2, "Patch must issue tool call then consume native result")
        require((self.work / "changed.txt").read_bytes() == b"native edited line\n", "Native patch did not edit bytes")
        outputs = [item for item in self.model.requests[-1]["body"].get("input", [])
                   if item.get("type") == "custom_tool_call_output" and item.get("call_id") == CALL_ID]
        require(outputs, "Native apply_patch output did not reach model")
        save(self.run / "native-tool-output.json", outputs)
        live = [entry["message"]["params"]["update"] for entry in c.trace
                if entry["direction"] == "in" and entry["message"].get("method") == "session/update"
                and entry["message"]["params"]["sessionId"] == sid]

        def verify_patch_events(updates):
            edits = [value for value in updates if value.get("toolCallId") == CALL_ID]
            require(any(value.get("kind") == "edit" for value in edits), edits)
            require(any(value.get("status") == "completed" for value in edits), edits)
            require("changed.txt" in json.dumps(edits), edits)
            return edits

        live = verify_patch_events(live)
        c = self.restart()
        replay = verify_patch_events(c.load(sid))
        save(self.run / "file-change-events.json", {"live": live, "coldReplay": replay})
        self.step("real_apply_patch_bytes_native_output_and_cold_file_change_replay", sessionId=sid,
                  toolRoute=self.model.tool_route, hashes=self.files())
        request = {"sessionId": sid, "toolCallId": CALL_ID, "dryRun": True}
        count = len(self.model.requests)
        before = self.files()
        preview = c.call("_session/files/revert", request)
        require(preview.get("canRevert") and not preview.get("reverted") and preview.get("previewToken"), preview)
        require(self.files() == before, "Preview mutated files/index")
        missing = c.raw("_session/files/revert", {**request, "dryRun": False})
        require("error" in missing and self.files() == before, missing)
        wrong = c.call("_session/files/revert", {**request, "dryRun": False, "previewToken": "sha256:" + "0" * 64})
        require(wrong.get("reason") == "stale_preview" and not wrong.get("reverted") and self.files() == before, wrong)
        unknown = c.call("_session/files/revert", {**request, "toolCallId": "unknown-tool"})
        require(unknown.get("reason") == "completed_patch_not_found" and self.files() == before, unknown)
        self.step("preview_is_read_only_and_missing_wrong_tokens_and_unknown_tool_refused", preview=preview)
        # A deliberate same-line conflict is deterministic on both Git platforms.
        # Restore only these fixture-owned bytes after verifying refusal.
        (self.work / "changed.txt").write_bytes(b"synthetic conflicting external edit\n")
        conflict_before = self.files()
        stale = c.call("_session/files/revert", {**request, "dryRun": False, "previewToken": preview["previewToken"]})
        require(stale.get("reason") == "stale_preview" and not stale.get("reverted"), stale)
        conflict = c.call("_session/files/revert", request)
        require(conflict.get("reason") == "patch_conflict" and not conflict.get("canRevert") and not conflict.get("reverted"), conflict)
        require(self.files() == conflict_before, "Conflict/stale token mutated files/index")
        self.step("external_edit_invalidates_token_and_conflict_is_non_mutating", stale=stale, conflict=conflict)
        (self.work / "changed.txt").write_bytes(b"native edited line\n")
        before = self.files()
        fresh = c.call("_session/files/revert", request)
        require(fresh.get("canRevert") and fresh.get("previewToken") and self.files() == before, fresh)
        restored = c.call("_session/files/revert", {**request, "dryRun": False, "previewToken": fresh["previewToken"]})
        require(restored.get("canRevert") and restored.get("reverted"), restored)
        require(self.files() == initial, "Restore must recover changed.txt while preserving unrelated files/index bytes")
        require(len(self.model.requests) == count, "File preview/revert called the model")
        require([u["text"] for u in points(c.load(sid))] == ["APPLY_SYNTHETIC_PATCH"], "File revert changed conversation")
        self.step("fresh_token_reverts_only_native_patch_preserving_index_and_independent_files", hashes=self.files())
        c.prompt(sid, "AFTER_FILE_RESTORE")
        self.context(["APPLY_SYNTHETIC_PATCH", "AFTER_FILE_RESTORE"])
        require(self.files() == initial, "Continuing changed independent files/index")
        self.step("file_restore_same_session_continues_with_conversation_intact")

    def run_all(self):
        report = {"success": False, "build": self.meta, "steps": self.steps}
        try:
            self.verify_build()
            self.history()
            if self.meta["mode"] != "rewind-only":
                self.file_revert()
            self.rpc.stop()
            self.verify_build()
            self.model.check()
            require(not self.client_requests, "Native unexpectedly requested host/client tools")
            entries = [json.loads(line) for line in (self.run / "spawns.jsonl").read_text(encoding="utf8").splitlines()]
            spawns = [entry for entry in entries if entry["event"] == "spawn"]
            exits = {entry["pid"] for entry in entries if entry["event"] == "exit"}
            native = [entry for entry in spawns if Path(entry["file"]).resolve() == Path(self.meta["native"]).resolve()]
            require(len(native) == len(self.clients), "Each ACP process must launch the resolved real native binary once")
            require(all(entry.get("pid") in exits for entry in native), "Native child did not exit before cold restart/cleanup")
            if os.name == "nt":
                require(all(entry.get("windowsHide") is True for entry in spawns), "Runtime spawn missing windowsHide: inspect spawns.jsonl")
            require(not any(entry.get("shell") for entry in native), "Direct native executable must not use a shell")
            self.step("runtime_native_identity_windowsHide_and_clean_process_shutdown", clients=len(self.clients), spawnCount=len(spawns))
            report["success"] = True
        except Exception as error:
            report["error"] = {"type": type(error).__name__, "message": str(error)}
            (self.run / "failure.txt").write_text(traceback.format_exc(), encoding="utf8")
        finally:
            self.model.release.set()
            for client in self.clients:
                try:
                    client.stop()
                except Exception as error:
                    report["success"] = False
                    report.setdefault("cleanupErrors", []).append(str(error))
            self.model.close()
            try:
                self.verify_build()
            except Exception as error:
                report["success"] = False
                report["finalBuildError"] = str(error)
            if self.model.errors or not self.model.pending.empty():
                report["success"] = False
                report.setdefault("error", {"type": "ModelFixtureError", "message": "Late or missing model request; inspect providerErrors"})
            report.update(modelRequests=len(self.model.requests), titleRequests=len(self.model.title_requests), providerErrors=self.model.errors,
                          wrongReplyInjected=self.model.injected,
                          blockedExternalRequests=self.model.blocked, processExits=self.exits,
                          clientRequests=self.client_requests,
                          networkBoundary="Loopback provider and deny HTTP(S) proxy; not an OS egress firewall",
                          harnessSha256=sha(__file__))
            save(self.run / "rpc-traces.json", [client.trace for client in self.clients])
            save(self.run / "model-requests.json", self.model.requests)
            save(self.run / "title-requests.json", self.model.title_requests)
            save(self.run / "report.json", report)
            print(json.dumps({"success": report["success"], "report": str(self.run / "report.json"),
                              "steps": len(self.steps), "error": report.get("error")}), flush=True)
        return 0 if report["success"] else 1


if __name__ == "__main__":
    require(len(sys.argv) == 2, "Use npm run test:native (a fresh build manifest is required)")
    raise SystemExit(Probe(Path(sys.argv[1])).run_all())
