/**
 * Example: a dead-simple interactive ACP client for Codex ACP.
 *
 * Launches `dist/index.js` as a subprocess, speaks ACP over its stdio using
 * the SDK, and prints every JSON-RPC message in both directions. Each line
 * you type becomes a `session/prompt`; the agent's answer streams back as
 * `session/update` notifications.
 *
 * Every message is preceded by a header line naming its direction:
 *
 *   [agent] ◂   inbound  — everything the agent sends us
 *   [user]  ▸   outbound — everything we send the agent
 *
 * The JSON is printed flush left and undecorated — select it and you have
 * valid JSON on the clipboard. This exists to show you the protocol.
 *
 * Four ways to drive the agent (all reachable from the prompt):
 *
 *   <text>          `session/prompt`. Typed mid-turn it is *buffered* and
 *                   sent once the running turn responds.
 *   !steer <text>   `_session/steering` — injected into the turn that is
 *                   already running.
 *   !queue <text>   `session/prompt` sent mid-turn anyway.
 *   !cancel         `session/cancel` the running turn.
 *
 * Run (build the agent first):
 *
 *   npm run build
 *   node --import tsx examples/simple-client.ts
 *
 * or equivalently: `npm run example:simple-client`.
 *
 * To debug the agent, pass a port. The agent is rebuilt with source maps
 * and started under --inspect-brk=<port>, paused until a debugger attaches:
 *
 *   node --import tsx examples/simple-client.ts --debug-port=9229
 *
 * Auth: uses your existing Codex login in ~/.codex. Alternatively export
 * CODEX_API_KEY or OPENAI_API_KEY.
 *
 * Flags: --debug-port=<port>, --no-build, --help.
 * Env:   AGENT_ENTRY (default dist/index.js), CWD (default process.cwd()).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
    PROTOCOL_VERSION,
    client as acpClient,
    methods,
    ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------- steering

const STEERING_METHOD = "_session/steering";

type SteeringRequest = {
    sessionId: string;
    prompt: Array<{ type: "text"; text: string }>;
};

type SteeringResponse = {
    outcome: "injected" | "startedNewTurn";
};

// ---------------------------------------------------------------- arguments

const ARGV = process.argv.slice(2);

function flag(name: string): string | undefined {
    const index = ARGV.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (index === -1) return undefined;
    const [, ...rest] = ARGV[index]!.split("=");
    return rest.length > 0 ? rest.join("=") : (ARGV[index + 1] ?? "");
}

if (ARGV.includes("--help") || ARGV.includes("-h")) {
    process.stdout.write(
        [
            "Usage: node --import tsx examples/simple-client.ts [--debug-port=<port>] [--no-build]",
            "",
            "  --debug-port=<port>  rebuild with source maps and start the agent under",
            "                       --inspect-brk=<port>, paused until a debugger attaches",
            "  --no-build           skip the build and use dist/ as-is",
            "",
            "Env: AGENT_ENTRY (default dist/index.js), CWD (default process.cwd()).",
            "",
        ].join("\n"),
    );
    process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ENTRY = process.env["AGENT_ENTRY"] ?? path.join(repoRoot, "dist", "index.js");
const CWD = process.env["CWD"] ?? process.cwd();
const BUILD = !ARGV.includes("--no-build");

const debugPortArg = flag("debug-port");
const DEBUG_PORT = debugPortArg === undefined ? undefined : Number(debugPortArg);
if (
    DEBUG_PORT !== undefined &&
    (!Number.isInteger(DEBUG_PORT) || DEBUG_PORT < 1 || DEBUG_PORT > 65535)
) {
    process.stderr.write(`--debug-port expects a port between 1 and 65535, got "${debugPortArg}"\n`);
    process.exit(1);
}

const HELP = [
    "<text>          send it — as a new turn, or buffered until this turn ends",
    "!steer <text>   inject into the running turn (_session/steering)",
    "!queue <text>   send session/prompt now and let the agent queue it",
    "!cancel         session/cancel the running turn (same as Ctrl-C)",
    "!help           this list; !! sends a line that really starts with '!'",
];

const CANCEL_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- output

const COLOR = process.stderr.isTTY === true && !process.env["NO_COLOR"];
const paint = (code: string, text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text: string) => paint("2", text);

const TTY = process.stdin.isTTY === true && process.stderr.isTTY === true;
const startedAt = Date.now();

let rl: readline.Interface | null = null;
let shuttingDown = false;
let queue: string[] = [];
let inFlight = 0;
const turnRunning = () => inFlight > 0;
let cancelRequested = false;
let lastUpdateKind = "";
let agentReady = false;

function writeBlock(text: string) {
    if (TTY) {
        readline.cursorTo(process.stderr, 0);
        readline.clearLine(process.stderr, 0);
    }
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    if (TTY) rl?.prompt(true);
}

function log(message: string) {
    writeBlock(`${dim("[client]")} ${message}`);
}

function refreshPrompt() {
    if (!rl) return;
    const queued = queue.length > 0 ? `[${queue.length} queued] ` : "";
    const running = inFlight > 1 ? `[${inFlight} turns] ` : "";
    const busy = turnRunning() ? dim(`⋯ ${lastUpdateKind} `) : "";
    rl.setPrompt(`${busy}${running}${queued}› `);
    if (TTY) rl.prompt(true);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- wire log

type WireMessage = {
    id?: string | number | null;
    method?: string;
    params?: { update?: { sessionUpdate?: string } };
    result?: { stopReason?: string };
    error?: { code: number; message: string };
};

function describe(message: AnyMessage): string {
    const wire = message as WireMessage;
    const id = wire.id === undefined || wire.id === null ? "" : ` #${wire.id}`;
    if (wire.method !== undefined) {
        const kind = wire.params?.update?.sessionUpdate;
        return `${wire.method}${kind ? ` · ${kind}` : ""}${id}`;
    }
    if (wire.error !== undefined) {
        return `error${id} · ${wire.error.code} ${wire.error.message}`;
    }
    const stopReason = wire.result?.stopReason;
    return `result${id}${stopReason ? ` · ${stopReason}` : ""}`;
}

function logMessage(direction: "agent" | "user", message: AnyMessage) {
    const inbound = direction === "agent";
    const color = inbound ? "36" : "35";
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(3);
    const header = [
        dim(`+${elapsed}s`),
        paint(`1;${color}`, inbound ? "[agent]" : "[user] "),
        paint(color, inbound ? "◂" : "▸"),
        dim(describe(message)),
    ].join(" ");
    writeBlock(`${header}\n${JSON.stringify(message, null, 2)}`);
}

function tapStream(inner: Stream): Stream {
    const inbound = new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
            logMessage("agent", message);
            controller.enqueue(message);
        },
    });
    const outbound = new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
            logMessage("user", message);
            controller.enqueue(message);
        },
    });
    outbound.readable.pipeTo(inner.writable).catch((err) => {
        if (!shuttingDown) log(`transport write failed: ${err}`);
    });
    return { readable: inner.readable.pipeThrough(inbound), writable: outbound.writable };
}

// ---------------------------------------------------------------- build

async function build(sourceMaps: boolean) {
    log(`building agent (esbuild${sourceMaps ? " + source maps" : ""}) …`);
    const buildScript = path.join(repoRoot, "build.mjs");
    const env = { ...process.env };
    if (sourceMaps) env["SOURCE_MAPS"] = "1";
    const child = spawn(process.execPath, [buildScript], {
        cwd: repoRoot,
        stdio: ["ignore", 2, 2],
        env,
    });
    const [code] = (await once(child, "exit")) as [number | null];
    if (code !== 0) {
        log(`build failed (exit ${code}) — fix the errors above, or pass --no-build`);
        process.exit(1);
    }
}

// ---------------------------------------------------------------- main

async function main() {
    if (BUILD) {
        await build(DEBUG_PORT !== undefined);
    } else if (!existsSync(AGENT_ENTRY)) {
        log(`${AGENT_ENTRY} not found — run \`npm run build\` first, or unset --no-build`);
        process.exit(1);
    }

    const nodeArgs =
        DEBUG_PORT === undefined ? [AGENT_ENTRY] : [`--inspect-brk=${DEBUG_PORT}`, AGENT_ENTRY];
    const child = spawn(process.execPath, nodeArgs, {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
    });
    child.on("error", (err) => {
        log(`failed to spawn agent (${AGENT_ENTRY}): ${err}`);
        process.exit(1);
    });
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") log(`agent stdin error: ${err}`);
    });
    child.stdout?.on("error", () => {});
    process.stderr.on("error", () => {});

    pumpAgentStderr(child);

    child.on("exit", (code, signal) => {
        if (!shuttingDown) log(`agent exited (code ${code}, signal ${signal})`);
    });

    const stream = tapStream(
        ndJsonStream(
            Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        ),
    );

    const connection = acpClient({ name: "simple-client" })
        .onNotification(methods.client.session.update, (ctx) => {
            lastUpdateKind = ctx.params.update.sessionUpdate;
        })
        .onRequest(methods.client.session.requestPermission, (ctx) => {
            const options = ctx.params.options;
            const option = options.find((o) => o.kind === "allow_once") ?? options[0];
            if (!option) return { outcome: { outcome: "cancelled" } };
            log(`auto-approving permission: ${option.name} (${option.kind}/${option.optionId})`);
            return { outcome: { outcome: "selected", optionId: option.optionId } };
        })
        .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
        .onRequest(methods.client.fs.writeTextFile, () => ({}))
        .connect(stream);

    const agent = connection.agent;

    let sessionId: string;

    const onInterrupt = () => {
        if (turnRunning() && !cancelRequested) {
            cancelRequested = true;
            const dropped = queue.length;
            queue = [];
            void agent.notify(methods.agent.session.cancel, { sessionId });
            log(`sent session/cancel${dropped > 0 ? `, dropped ${dropped} queued line(s)` : ""}`);
            refreshPrompt();
            return;
        }
        void shutdown(turnRunning() ? "^C while cancelling" : "^C");
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    // 1. Initialize.
    let nudge: NodeJS.Timeout | undefined;
    if (DEBUG_PORT !== undefined) {
        log(`agent is PAUSED before its first line (--inspect-brk=${DEBUG_PORT})`);
        log(`attach a debugger to port ${DEBUG_PORT} and resume — breakpoints go in src/*.ts`);
        nudge = setInterval(
            () => log(`still waiting for a debugger on port ${DEBUG_PORT} … (Ctrl-C to give up)`),
            10_000,
        );
    }
    let init;
    try {
        init = await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: false,
            },
        });
    } finally {
        if (nudge) clearInterval(nudge);
    }
    agentReady = true;
    log(`connected to ${init.agentInfo?.name ?? "agent"} ${init.agentInfo?.version ?? ""}`.trim());

    const initMeta = init._meta as { steering?: { supported?: boolean } } | null | undefined;
    const steeringSupported = initMeta?.steering?.supported === true;
    log(`agent supports: steering=${steeringSupported}`);

    // 2. Open a session.
    try {
        const session = await agent.request(methods.agent.session.new, { cwd: CWD, mcpServers: [] });
        sessionId = session.sessionId;
    } catch (err) {
        log(`session/new failed: ${err}`);
        log("if this is an auth error, log in first: npx @openai/codex auth login");
        await shutdown("session/new failed", 1);
        return;
    }
    log(`session ${sessionId} in ${CWD}`);

    // 3. Turns.
    let draining = false;

    async function sendPrompt(text: string) {
        inFlight += 1;
        cancelRequested = false;
        refreshPrompt();
        try {
            const result = await agent.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: "text", text }],
            });
            log(`turn ended: ${result.stopReason}`);
        } catch (err) {
            log(`prompt failed: ${err}`);
            if (connection.signal.aborted) queue = [];
        } finally {
            inFlight -= 1;
            refreshPrompt();
            exitWhenIdle();
        }
    }

    async function drain() {
        if (draining) return;
        draining = true;
        try {
            while (queue.length > 0 && !shuttingDown) {
                await sendPrompt(queue.shift()!);
                if (connection.signal.aborted) break;
            }
        } finally {
            draining = false;
            refreshPrompt();
            exitWhenIdle();
        }
    }

    function exitWhenIdle() {
        if (inputClosed && !draining && queue.length === 0 && inFlight === 0) {
            void shutdown("input closed, queue drained");
        }
    }

    function handleCommand(line: string) {
        const word = line.split(/\s+/)[0] ?? "";
        const text = line.slice(word.length).trim();
        switch (word) {
            case "!steer":
                if (text.length === 0) {
                    log("usage: !steer <message> — injects into the turn that is running");
                    break;
                }
                if (!steeringSupported) log("agent did not advertise steering; trying anyway");
                void steer(text);
                break;
            case "!queue":
                if (text.length === 0) {
                    log("usage: !queue <message> — sends session/prompt now, agent queues it");
                    break;
                }
                void sendPrompt(text);
                break;
            case "!cancel":
                if (!turnRunning()) {
                    log("nothing to cancel");
                    break;
                }
                onInterrupt();
                break;
            case "!help":
                for (const entry of HELP) log(entry);
                break;
            default:
                log(`unknown command ${word} — try !help`);
                break;
        }
        refreshPrompt();
    }

    async function steer(text: string) {
        const params: SteeringRequest = { sessionId, prompt: [{ type: "text", text }] };
        try {
            const result = await agent.request<SteeringResponse>(STEERING_METHOD, params);
            log(
                result.outcome === "injected"
                    ? "steer outcome: injected into the running turn"
                    : "steer outcome: startedNewTurn — the turn had already finished",
            );
        } catch (err) {
            log(`steer rejected: ${err}`);
        }
    }

    let inputClosed = false;
    let steerHinted = false;

    rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: TTY,
        crlfDelay: Infinity,
        historySize: 200,
    });

    rl.on("line", (raw) => {
        const line = raw.trim();
        if (line.length === 0 || shuttingDown) {
            refreshPrompt();
            return;
        }
        if (line.startsWith("!") && !line.startsWith("!!")) {
            handleCommand(line);
            return;
        }
        queue.push(line.startsWith("!!") ? line.slice(1) : line);
        if (turnRunning()) {
            log(`buffered — will send when this turn ends (${queue.length} queued)`);
            if (!steerHinted) {
                steerHinted = true;
                log("…or use !steer <text> to inject into the running turn instead");
            }
        }
        refreshPrompt();
        void drain();
    });

    rl.on("SIGINT", onInterrupt);

    rl.on("close", () => {
        inputClosed = true;
        exitWhenIdle();
    });

    void connection.closed.then(() => {
        if (!shuttingDown) void shutdown("connection closed");
    });

    for (const entry of HELP) log(entry);
    log("Enter sends, Ctrl-C cancels a turn, Ctrl-D exits");
    refreshPrompt();

    async function shutdown(reason: string, exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        log(`shutting down (${reason})`);
        queue = [];
        rl?.removeAllListeners("close");
        rl?.close();

        if (turnRunning()) {
            if (!cancelRequested) {
                try {
                    await agent.notify(methods.agent.session.cancel, { sessionId });
                } catch {
                    // connection may already be gone
                }
            }
            const deadline = Date.now() + CANCEL_TIMEOUT_MS;
            while (turnRunning() && Date.now() < deadline) await delay(50);
        }

        child.stdin?.end();
        const exited = await Promise.race([
            once(child, "exit").then(() => true),
            delay(agentReady ? EXIT_TIMEOUT_MS : 250).then(() => false),
        ]);
        if (!exited) {
            log("agent did not exit on stdin EOF; sending SIGTERM");
            child.kill("SIGTERM");
            const stopped = await Promise.race([
                once(child, "exit").then(() => true),
                delay(2_000).then(() => false),
            ]);
            if (!stopped) child.kill("SIGKILL");
        }

        connection.close();
        process.exit(exitCode);
    }
}

function pumpAgentStderr(child: ReturnType<typeof spawn>) {
    let buffered = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
            if (line.length === 0) continue;
            if (line.includes("Debugger listening on")) {
                writeBlock(paint("1;33", `[agent] ${line.trim()}`));
            } else if (line.includes("address already in use")) {
                writeBlock(paint("1;31", `[agent] ${line.trim()}`));
                log("that inspector port is taken — pass a different --debug-port");
            } else {
                writeBlock(dim(`[agent:stderr] ${line}`));
            }
        }
    });
}

main().catch((err) => {
    if (shuttingDown) return;
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
});
