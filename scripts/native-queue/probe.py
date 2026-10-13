"""Real ACP/native processes over stdio, with a scripted loopback Responses server.

Only the model is fake. Never read native rollout files, write ACP history, or
execute file tools in the test client. Invoke through ../native-queue.mjs so every
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


class Model:
    def __init__(self, wrong_reply=False):
        self.requests, self.title_requests, self.errors, self.blocked = [], [], [], []
        self.wrong_reply, self.injected = wrong_reply, False
        self.pending = queue.Queue()
        self.lock = threading.Lock()
        self.gates = []
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
                            raise AssertionError("Unsolicited model request (no queue input was armed)")
                    if isinstance(action, dict):
                        # Independent gates let a queued successor stay blocked while
                        # the preceding ordinary prompt completes and cleans up.
                        users = [item for item in body.get("input", []) if item.get("role") == "user"]
                        latest = "".join(part.get("text", "") for part in users[-1].get("content", [])
                                         if part.get("type") == "input_text") if users else ""
                        require(latest == action["input"],
                                f"Queue input/order mismatch: expected {action['input']!r}, received {latest!r}")
                        action["seen"].set()
                        require(action["release"].wait(TIMEOUT), "Queue gate was not released")
                    events = [{"type": "response.created", "response": {"id": f"resp-{number}"}}]
                    answer = '{"title":"Local native fixture"}' if title else action["answer"]
                    if not title and owner.wrong_reply and not owner.injected:
                        answer = "INJECTED_WRONG_REPLY"
                        owner.injected = True
                    if isinstance(action, dict):
                        events.extend([
                            {"type": "response.output_item.added", "item": {
                                "type": "message", "role": "assistant", "id": f"msg-{number}", "content": []}},
                            {"type": "response.output_text.delta", "item_id": f"msg-{number}",
                             "output_index": 0, "content_index": 0, "delta": answer},
                        ])
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
                    if isinstance(action, dict):
                        action["done"].set()
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
        for gate in self.gates:
            gate["release"].set()
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
            "protocolVersion": 1, "clientInfo": {"name": "isolated-native-queue", "version": "1"},
            "clientCapabilities": {}})

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
                # The queue fixture never requests client tools or approvals.
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
        git = shutil.which("git")
        paths = [str(Path(self.meta["node"]).parent)]
        if git:
            paths.append(str(Path(git).parent))
        paths += [str(Path(os.environ["SYSTEMROOT"]) / "System32")] if os.name == "nt" else ["/usr/bin", "/bin"]
        self.env["PATH"] = os.pathsep.join(dict.fromkeys(paths))
        proxy = f"http://127.0.0.1:{self.model.proxy.server_port}"
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            self.env[key] = proxy
        self.env.update(NO_PROXY="127.0.0.1,localhost,::1", no_proxy="127.0.0.1,localhost,::1")
        provider = {"name": "Native E2E loopback", "base_url": f"http://127.0.0.1:{self.model.server.server_port}/v1",
                    "wire_api": "responses", "requires_openai_auth": False,
                    "request_max_retries": 0, "stream_max_retries": 0}
        # A bundled model profile avoids discovery; all replies come from loopback.
        config = {"model": "gpt-5.5", "model_provider": "mock", "model_providers": {"mock": provider},
                  "approval_policy": "never", "sandbox_mode": "danger-full-access",
                  "features": {"shell_snapshot": False, "remote_models": False, "plugins": False, "code_mode": False}}
        self.env.update(CODEX_PATH=self.meta["native"], MODEL_PROVIDER="mock", CODEX_CONFIG=json.dumps(config),
                        INITIAL_AGENT_MODE="agent-full-access", NO_BROWSER="1",
                        NODE_OPTIONS='--require=' + json.dumps(str(self.repo / "scripts/native-queue/spawn-audit.cjs")),
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
        current_names.update(str(file.relative_to(self.repo))
                             for file in (self.repo / "scripts/native-queue").rglob("*") if file.is_file())
        current_names.update(str(Path(name)) for name in
                             ["package.json", "package-lock.json", "build.mjs", "scripts/native-queue.mjs"])
        require(current_names == set(self.meta["sources"]), "Source file set changed during probe; rerun")
        for name, expected in self.meta["sources"].items():
            require(sha(self.repo / name) == expected, f"Source changed during probe: {name}; rerun")

    def run_all(self):
        report = {"success": False, "build": self.meta, "steps": self.steps}
        try:
            self.verify_build()
            self.start()
            from queue_probe import run_queue_probe
            run_queue_probe(self)
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
            self.step("native_identity_and_cold_process_shutdown", clients=len(self.clients), spawnCount=len(spawns))
            report["success"] = True
        except Exception as error:
            report["error"] = {"type": type(error).__name__, "message": str(error)}
            (self.run / "failure.txt").write_text(traceback.format_exc(), encoding="utf8")
        finally:
            for gate in self.model.gates:
                gate["release"].set()
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
            queue_harness = self.repo / "scripts/native-queue/queue_probe.py"
            if queue_harness.exists():
                report["queueHarnessSha256"] = sha(queue_harness)
            save(self.run / "rpc-traces.json", [client.trace for client in self.clients])
            save(self.run / "model-requests.json", self.model.requests)
            save(self.run / "title-requests.json", self.model.title_requests)
            save(self.run / "report.json", report)
            print(json.dumps({"success": report["success"], "report": str(self.run / "report.json"),
                              "steps": len(self.steps), "error": report.get("error")}), flush=True)
        return 0 if report["success"] else 1


if __name__ == "__main__":
    require(len(sys.argv) == 2, "Use npm run test:native-queue (a fresh build manifest is required)")
    raise SystemExit(Probe(Path(sys.argv[1])).run_all())
