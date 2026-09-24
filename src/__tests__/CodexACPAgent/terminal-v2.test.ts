import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type {ServerNotification} from '../../app-server';
import type {CommandAction, ThreadItem} from '../../app-server/v2';
import {
    connectSession,
    dump,
    itemCompleted,
    itemStarted,
    type PromptSession,
    sessionId,
    settle,
    turnCompleted,
    turnId,
    turnStarted,
    userMessageItem,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

async function startTurn(client: PromptSession): Promise<void> {
    const response = client.sendPrompt([{type: "text", text: "Run the tests"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    await response;
}

async function finishTurn(client: PromptSession) {
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

/** Tool call and terminal updates, in the order the client received them. */
function toolAndTerminalUpdates(client: PromptSession): acpV2.SessionUpdate[] {
    return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => ["tool_call_update", "terminal_update", "terminal_output_chunk"].includes(update.sessionUpdate));
}

/** Snapshot text with each base64 payload followed by its decoded text, for readability. */
function dumpDecoded(updates: acpV2.SessionUpdate[]): string {
    return dump(updates.map(update => {
        if (update.sessionUpdate === "terminal_output_chunk") {
            const {data} = update as acpV2.TerminalOutputChunk;
            return {...update, decoded: Buffer.from(data, "base64").toString("utf8")};
        }
        const {output} = update as acpV2.TerminalUpdate;
        if (update.sessionUpdate === "terminal_update" && output) {
            return {...update, decodedOutput: Buffer.from(output.data, "base64").toString("utf8")};
        }
        return update;
    }));
}

type CommandItem = Extract<ThreadItem, {type: "commandExecution"}>;

function commandItem(id: string, overrides: Partial<CommandItem> = {}): CommandItem {
    return {
        type: "commandExecution",
        id,
        pluginId: null,
        scriptPath: null,
        command: "/bin/zsh -lc 'npm test'",
        cwd: "/workspace",
        processId: "proc-1",
        source: "agent",
        status: "inProgress",
        commandActions: [{type: "unknown", command: "npm test"}],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
        ...overrides,
    };
}

function completed(item: CommandItem, aggregatedOutput: string, exitCode: number): CommandItem {
    return {...item, status: exitCode === 0 ? "completed" : "failed", aggregatedOutput, exitCode, durationMs: 12};
}

function outputDelta(itemId: string, delta: string): ServerNotification {
    return {method: "item/commandExecution/outputDelta", params: {threadId: sessionId, turnId, itemId, delta}};
}

const readAction: CommandAction = {type: "read", command: "cat src/a.ts", name: "a.ts", path: "/workspace/src/a.ts"};

describe('agent-owned terminals over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    async function connect(options: Parameters<typeof connectSession>[1] = {}): Promise<PromptSession> {
        const client = await connectSession(2, options);
        closeClient = () => client.connection.close();
        await startTurn(client);
        return client;
    }

    it('announces the terminal, streams output as base64 chunks and reports the exit', async () => {
        const client = await connect();
        const item = commandItem("item-shell");

        client.emit(itemStarted(item));
        client.emit(outputDelta("item-shell", "PASS a.test.ts\n"));
        client.emit(outputDelta("item-shell", "Tests: 1 passed ✓\n"));
        client.emit({
            method: "item/commandExecution/terminalInteraction",
            params: {threadId: sessionId, turnId, itemId: "item-shell", processId: "proc-1", stdin: "q"},
        });
        client.emit(itemCompleted(completed(item, "PASS a.test.ts\nTests: 1 passed ✓\n", 0)));
        await finishTurn(client);

        await expect(dumpDecoded(toolAndTerminalUpdates(client)))
            .toMatchFileSnapshot('data/terminal-v2-streamed.json');
    });

    it('sends the whole output as the final snapshot when nothing was streamed', async () => {
        const client = await connect();
        const item = commandItem("item-shell", {commandActions: []});

        client.emit(itemStarted(item));
        client.emit(itemCompleted(completed(item, "hello\n", 0)));
        await finishTurn(client);

        const updates = toolAndTerminalUpdates(client);
        // A generic shell command's first update creates the tool call with its title.
        expect(updates.find(update => update.sessionUpdate === "tool_call_update"))
            .toMatchObject({toolCallId: "item-shell", title: "npm test", content: [{type: "terminal", terminalId: "item-shell"}]});
        // The terminal shows the same text as the title; the raw input keeps the shell wrapper.
        expect(updates[0]).toMatchObject({sessionUpdate: "terminal_update", command: "npm test"});
        await expect(dumpDecoded(updates)).toMatchFileSnapshot('data/terminal-v2-snapshot.json');
    });

    it('reports a failed command with its exit code', async () => {
        const client = await connect();
        const item = commandItem("item-shell");

        client.emit(itemStarted(item));
        client.emit(outputDelta("item-shell", "npm ERR! Test failed.\n"));
        client.emit(itemCompleted(completed(item, "npm ERR! Test failed.\n", 1)));
        await finishTurn(client);

        await expect(dumpDecoded(toolAndTerminalUpdates(client)))
            .toMatchFileSnapshot('data/terminal-v2-failed.json');
    });

    it('keeps output of commands without a terminal in the tool call raw output', async () => {
        // The private v1 capability does not change the v2 output shape.
        const client = await connect({clientCapabilities: {_meta: {terminal_output_delta: true}}});
        const item = commandItem("item-read", {command: "cat src/a.ts", commandActions: [readAction]});

        client.emit(itemStarted(item));
        client.emit(outputDelta("item-read", "export {};\n"));
        client.emit(itemCompleted(completed(item, "export {};\n", 0)));
        await finishTurn(client);

        const updates = toolAndTerminalUpdates(client);
        expect(updates.map(update => update.sessionUpdate)).toEqual(["tool_call_update", "tool_call_update"]);
        await expect(dumpDecoded(updates)).toMatchFileSnapshot('data/terminal-v2-no-terminal.json');
    });

    it('streams a terminal command the same way when the client sends the private v1 capability', async () => {
        const client = await connect({clientCapabilities: {_meta: {terminal_output: true}}});
        const item = commandItem("item-shell");

        client.emit(itemStarted(item));
        client.emit(outputDelta("item-shell", "ok\n"));
        client.emit(itemCompleted(completed(item, "ok\n", 0)));
        await finishTurn(client);

        expect(toolAndTerminalUpdates(client).map(update => update.sessionUpdate)).toEqual([
            "terminal_update", "tool_call_update", "terminal_output_chunk", "terminal_update", "tool_call_update",
        ]);
    });
});
