#!/usr/bin/env tsx

/**
 * Steering demo — mid-turn edition.
 *
 * The plain `steering.ts` example steers a single-message answer ("count to
 * 30"). There the injected prompt can only take effect *after* that message is
 * finished: a turn made of one model step has no earlier boundary for Codex to
 * inject at, so `turn/steer` appends the message and the model reads it on its
 * next step — which is the end.
 *
 * This example instead gives Codex a genuinely multi-step task: a "treasure
 * hunt" where each clue file only reveals the *name of the next clue*. Because
 * the reads are sequential and dependent, the agent cannot batch them or read
 * ahead — the turn contains several model steps. A steering message injected
 * part-way through is therefore picked up *between* steps and visibly changes
 * what the agent does next (it stops the hunt early).
 *
 * Run it with:
 *     node --import tsx examples/steering.ts
 *     # or: npm run example:steering:multistep
 *
 * Auth: uses your existing Codex login in ~/.codex. If you instead export
 * CODEX_API_KEY / OPENAI_API_KEY it will authenticate with that.
 *
 * Knobs (env):
 *     STEERING_EXAMPLE_MODEL   model id (default gpt-5.6-sol)
 *     STEER_AFTER_TOOL_CALLS   inject the steer after N clue reads (default 2)
 *     NO_COLOR                 disable ANSI colors
 */

import * as acp from "@agentclientprotocol/sdk";
import {type ChildProcess, spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Readable, Writable} from "node:stream";

const STEERING_METHOD = "_session/steering";
const EXAMPLE_TIMEOUT_MS = 60_000;
const DEFAULT_EXAMPLE_MODEL = "gpt-5.6-sol";
const exampleModel = process.env["STEERING_EXAMPLE_MODEL"] ?? DEFAULT_EXAMPLE_MODEL;

const parsedSteerAfter = Number(process.env["STEER_AFTER_TOOL_CALLS"] ?? "2");
const STEER_AFTER_TOOL_CALLS = Number.isFinite(parsedSteerAfter) && parsedSteerAfter > 0
    ? Math.floor(parsedSteerAfter)
    : 2;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// One note per clue file. The hunt is CLUE_NOTES.length steps long.
const CLUE_NOTES = ["compass", "lantern", "map", "brass key", "torch", "rope", "chart", "chest"];

const initialPrompt = [
    "You're solving a treasure hunt inside this folder.",
    "Start by reading the file `clue-1.txt`.",
    "Each clue holds one note to remember and tells you the exact filename of the next clue.",
    "Follow the trail, reading EXACTLY ONE clue per step — use a separate read for each file,",
    "and do NOT list the folder or read several files at once.",
    "Keep going until a clue tells you to STOP, then reply with the full ordered list of notes you collected.",
].join(" ");

const steeringPrompt = [
    "Change of plan — stop the treasure hunt immediately.",
    "Do not open any more clues.",
    "Just tell me the notes you've collected so far and which clue number you stopped on.",
].join(" ");

type SteeringRequest = {
    sessionId: acp.SessionId;
    prompt: acp.ContentBlock[];
};

type SteeringResponse = {
    outcome: "injected" | "startedNewTurn";
};

type ThreadStatusType = "active" | "idle" | "systemError";
type StateListener = () => void;

let trackedSessionId: acp.SessionId | null = null;
const toolCallsSeen = new Set<string>();
let finishedTransitions = 0;
let lastChannel: string | null = null;
const stateListeners = new Set<StateListener>();

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (no dependencies). Honors NO_COLOR and non-TTY output.
// ---------------------------------------------------------------------------
const useColor = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const paint = (code: string) => (text: string): string => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const c = {
    bold: paint("1"),
    dim: paint("2"),
    red: paint("31"),
    green: paint("32"),
    yellow: paint("33"),
    magenta: paint("35"),
    cyan: paint("36"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAgentEnvironment(): NodeJS.ProcessEnv {
    const configString = process.env["CODEX_CONFIG"];
    let config: Record<string, unknown> = {};
    if (configString) {
        const parsedConfig: unknown = JSON.parse(configString);
        if (!isRecord(parsedConfig)) {
            throw new Error("CODEX_CONFIG must contain a JSON object");
        }
        config = parsedConfig;
    }
    return {
        ...process.env,
        CODEX_CONFIG: JSON.stringify({
            ...config,
            model: exampleModel,
        }),
    };
}

function supportsSteering(response: acp.InitializeResponse): boolean {
    const steering = response._meta?.["steering"];
    return isRecord(steering) && steering["supported"] === true;
}

function readThreadStatus(update: acp.SessionUpdate): ThreadStatusType | undefined {
    if (update.sessionUpdate !== "session_info_update") {
        return undefined;
    }
    const codex = update._meta?.["codex"];
    if (!isRecord(codex)) {
        return undefined;
    }
    const threadStatus = codex["threadStatus"];
    if (!isRecord(threadStatus)) {
        return undefined;
    }
    const type = threadStatus["type"];
    return type === "active" || type === "idle" || type === "systemError" ? type : undefined;
}

function notifyStateListeners(): void {
    for (const listener of stateListeners) {
        listener();
    }
}

// ---------------------------------------------------------------------------
// Streaming output: group consecutive chunks of the same kind under a header
// so thinking / agent text / tool calls stay visually separated.
// ---------------------------------------------------------------------------
function writeChannel(channel: string, label: string, text: string): void {
    if (lastChannel !== channel) {
        process.stdout.write(`\n${label}\n`);
        lastChannel = channel;
    }
    process.stdout.write(text);
}

function writeEvent(line: string): void {
    process.stdout.write(`\n${line}\n`);
    lastChannel = null;
}

function recordSessionUpdate(params: acp.SessionNotification): void {
    if (params.sessionId !== trackedSessionId) {
        return;
    }

    const update = params.update;
    switch (update.sessionUpdate) {
        case "agent_message_chunk":
            if (update.content.type === "text") {
                writeChannel("message", c.bold(c.cyan("🤖 agent")), update.content.text);
            }
            break;
        case "agent_thought_chunk":
            if (update.content.type === "text") {
                writeChannel("thought", c.dim("💭 thinking"), c.dim(update.content.text));
            }
            break;
        case "tool_call": {
            const isNew = !toolCallsSeen.has(update.toolCallId);
            toolCallsSeen.add(update.toolCallId);
            writeEvent(c.yellow(`🔧 tool call #${toolCallsSeen.size}: ${update.title} [${update.status}]`));
            if (isNew) {
                notifyStateListeners();
            }
            break;
        }
        case "tool_call_update":
            if (update.status) {
                writeEvent(c.dim(`   ↳ ${update.toolCallId} [${update.status}]`));
            }
            break;
    }

    const threadStatus = readThreadStatus(update);
    if (threadStatus === "idle" || threadStatus === "systemError") {
        finishedTransitions += 1;
        notifyStateListeners();
    }
}

async function waitForState(
    predicate: () => boolean,
    description: string,
    timeoutMs = EXAMPLE_TIMEOUT_MS,
): Promise<void> {
    if (predicate()) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            stateListeners.delete(checkState);
            reject(new Error(`Timed out waiting for ${description}`));
        }, timeoutMs);
        const checkState = (): void => {
            if (!predicate()) {
                return;
            }
            clearTimeout(timeout);
            stateListeners.delete(checkState);
            resolve();
        };
        stateListeners.add(checkState);
    });
}

async function createTreasureHunt(): Promise<{workspaceDir: string; clueCount: number}> {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "codex-steering-"));
    const clueCount = CLUE_NOTES.length;
    for (let index = 0; index < clueCount; index += 1) {
        const step = index + 1;
        const note = CLUE_NOTES[index];
        const isLast = step === clueCount;
        const nextInstruction = isLast
            ? "This is the final clue. STOP here — do not open any more files. Report every note you collected, in order."
            : `When ready, read the next clue in the file named "clue-${step + 1}.txt".`;
        const body =
            `Treasure hunt — clue ${step} of ${clueCount}\n\n` +
            `Note to remember #${step}: ${note}\n\n` +
            `${nextInstruction}\n`;
        await writeFile(path.join(workspaceDir, `clue-${step}.txt`), body, "utf8");
    }
    return {workspaceDir, clueCount};
}

function printHeader(workspaceDir: string, clueCount: number): void {
    const line = "─".repeat(66);
    console.log(c.bold(`\n${line}`));
    console.log(c.bold("  Codex ACP — mid-turn steering demo"));
    console.log(line);
    console.log(`  model        : ${c.cyan(exampleModel)}`);
    console.log(`  workspace    : ${c.dim(workspaceDir)}`);
    console.log(`  clue files   : ${clueCount}  (clue-1.txt … clue-${clueCount}.txt)`);
    console.log(`  steer after  : ${STEER_AFTER_TOOL_CALLS} tool call(s)`);
    console.log(line);
    console.log(c.dim("  Task: follow the treasure-hunt chain, one clue at a time."));
    console.log(c.dim("  Mid-turn we inject a steering message telling it to stop early."));
    console.log(`${line}\n`);
}

function printBanner(text: string): void {
    const line = "═".repeat(66);
    process.stdout.write(`\n${c.magenta(line)}\n${c.magenta(c.bold(`  ${text}`))}\n${c.magenta(line)}\n`);
    lastChannel = null;
}

function printSummary(clueCount: number, cluesAtSteer: number, stopReason: string, steered: boolean): void {
    const line = "─".repeat(66);
    const stoppedEarly = toolCallsSeen.size < clueCount;
    console.log(`\n\n${c.bold(line)}`);
    console.log(c.bold("  Summary"));
    console.log(line);
    console.log(`  tool calls total : ${toolCallsSeen.size} of up to ${clueCount} clues`);
    console.log(`  steered after    : ${steered ? `${cluesAtSteer} clue(s)` : "not steered"}`);
    console.log(`  stop reason      : ${stopReason}`);
    console.log(line);
    if (!steered) {
        console.log(c.yellow("  • The turn finished before we could steer. Lower STEER_AFTER_TOOL_CALLS"));
        console.log(c.yellow("    or use a slower model to catch the turn while it is still running."));
    } else if (stoppedEarly) {
        console.log(c.green("  ✔ The agent stopped BEFORE reading every clue — the steering message"));
        console.log(c.green("    was picked up mid-turn and changed its course."));
    } else {
        console.log(c.yellow("  • The agent read every clue. Steering still applied, but the turn was"));
        console.log(c.yellow("    short — try a longer chain (add CLUE_NOTES) or steer earlier."));
    }
    console.log(`${line}\n`);
}

async function stopAgent(agentProcess: ChildProcess): Promise<void> {
    if (agentProcess.stdin && !agentProcess.stdin.destroyed && !agentProcess.stdin.writableEnded) {
        agentProcess.stdin.end();
    }
    if (agentProcess.exitCode !== null || agentProcess.signalCode !== null) {
        return;
    }

    await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        agentProcess.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
    if (agentProcess.exitCode === null && agentProcess.signalCode === null) {
        agentProcess.kill();
    }
}

async function main(): Promise<void> {
    const {workspaceDir, clueCount} = await createTreasureHunt();
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const agentProcess = spawn(npmCommand, ["run", "--silent", "start"], {
        cwd: repositoryRoot,
        env: createAgentEnvironment(),
        stdio: ["pipe", "pipe", "inherit"],
    });
    if (!agentProcess.stdin || !agentProcess.stdout) {
        throw new Error("Failed to open stdio pipes for the ACP agent");
    }
    const stream = acp.ndJsonStream(
        Writable.toWeb(agentProcess.stdin),
        Readable.toWeb(agentProcess.stdout) as ReadableStream<Uint8Array>,
    );

    try {
        await acp.client({name: "steering-multistep-example"})
            .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
                // A real client would prompt the user here. To keep the demo
                // hands-free we auto-approve each read once.
                const {toolCall, options} = ctx.params;
                const allow = options.find((option) => option.kind === "allow_once") ?? options[0];
                if (!allow) {
                    return {outcome: {outcome: "cancelled"}};
                }
                writeEvent(c.green(`   ✔ auto-approving: ${toolCall.title ?? toolCall.toolCallId} → "${allow.name}"`));
                return {outcome: {outcome: "selected", optionId: allow.optionId}};
            })
            .onNotification(acp.methods.client.session.update, (ctx) => {
                recordSessionUpdate(ctx.params);
            })
            .connectWith(stream, async (agent) => {
                const initializeResponse = await agent.request(acp.methods.agent.initialize, {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientInfo: {
                        name: "steering-multistep-example",
                        version: "1.0.0",
                    },
                });
                if (!supportsSteering(initializeResponse)) {
                    throw new Error("The agent did not advertise steering support");
                }

                const apiKey = process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
                if (apiKey && initializeResponse.authMethods?.some((method) => method.id === "api-key")) {
                    await agent.request(acp.methods.agent.authenticate, {
                        methodId: "api-key",
                        _meta: {
                            "api-key": {apiKey},
                        },
                    });
                }

                const session = await agent.request(acp.methods.agent.session.new, {
                    cwd: workspaceDir,
                    mcpServers: [],
                });
                trackedSessionId = session.sessionId;

                printHeader(workspaceDir, clueCount);
                process.stdout.write(c.dim(`📤 prompt → ${initialPrompt}\n`));

                let promptDone = false;
                const promptPromise = agent.request(acp.methods.agent.session.prompt, {
                    sessionId: trackedSessionId,
                    prompt: [{type: "text", text: initialPrompt}],
                }).finally(() => {
                    promptDone = true;
                    notifyStateListeners();
                });
                promptPromise.catch(() => {});

                // Let the agent work through a couple of clues, then steer mid-turn.
                await Promise.race([
                    waitForState(
                        () => toolCallsSeen.size >= STEER_AFTER_TOOL_CALLS || promptDone,
                        `the agent to open ${STEER_AFTER_TOOL_CALLS} clue(s)`,
                    ).catch(() => {}),
                    promptPromise.then(() => undefined, () => undefined),
                ]);

                const cluesAtSteer = toolCallsSeen.size;
                const turnAlreadyFinished = promptDone || finishedTransitions > 0;
                let steered = false;

                if (turnAlreadyFinished) {
                    writeEvent(c.red("⚠ The turn finished before we could steer — skipping the steering step."));
                } else {
                    steered = true;
                    printBanner(`Injecting steering message after ${cluesAtSteer} clue(s)`);
                    process.stdout.write(`${c.magenta(`✋ steer → ${steeringPrompt}`)}\n`);
                    lastChannel = null;

                    const steeringResponse = await agent.request<SteeringResponse, SteeringRequest>(STEERING_METHOD, {
                        sessionId: trackedSessionId,
                        prompt: [{type: "text", text: steeringPrompt}],
                    });
                    if (steeringResponse.outcome !== "injected" && steeringResponse.outcome !== "startedNewTurn") {
                        throw new Error(`Unexpected steering response: ${JSON.stringify(steeringResponse)}`);
                    }
                    writeEvent(c.magenta(c.bold(`   outcome: ${steeringResponse.outcome}`)));
                    if (steeringResponse.outcome === "injected") {
                        writeEvent(c.dim("   → injected into the running turn; the agent picks it up at its next step."));
                    } else {
                        writeEvent(c.dim("   → the turn had already ended, so this started a fresh turn."));
                    }
                }

                const promptResponse = await promptPromise;
                printSummary(clueCount, cluesAtSteer, promptResponse.stopReason, steered);

                await agent.request(acp.methods.agent.session.close, {
                    sessionId: trackedSessionId,
                });
            });
    } finally {
        await stopAgent(agentProcess);
        await rm(workspaceDir, {recursive: true, force: true});
    }
}

main().catch((error: unknown) => {
    console.error("Steering multistep example failed:", error);
    process.exitCode = 1;
});
