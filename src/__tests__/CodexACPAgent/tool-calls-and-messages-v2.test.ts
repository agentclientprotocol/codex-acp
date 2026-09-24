import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type {ServerNotification} from '../../app-server';
import type {ThreadItem} from '../../app-server/v2';
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
import {expectConformingV2SessionUpdates, v2SessionUpdateViolation} from './v2-session-update-guard';

/** Sends a prompt and lets Codex record it, so the turn is running on the client side. */
async function startTurn(client: PromptSession): Promise<string> {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    const {messageId} = await response;
    return messageId;
}

async function finishTurn(client: PromptSession) {
    client.emit(turnCompleted());
    await client.promptRunFinished();
    await settle();
}

/** The session updates in the transcript with one of the given tags. */
function updatesTagged(client: PromptSession, ...tags: string[]): acpV2.SessionUpdate[] {
    return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
        .filter(update => tags.includes(update.sessionUpdate));
}

function commandItem(id: string, commandActions: Extract<ThreadItem, {type: "commandExecution"}>["commandActions"], status: "inProgress" | "completed" = "inProgress"): ThreadItem {
    return {
        type: "commandExecution",
        id,
        pluginId: null,
        scriptPath: null,
        command: commandActions[0]?.command ?? "npm test",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status,
        commandActions,
        aggregatedOutput: status === "completed" ? "export {};\n" : null,
        exitCode: status === "completed" ? 0 : null,
        durationMs: status === "completed" ? 5 : null,
    };
}

const readAction = {type: "read", command: "cat src/a.ts", name: "a.ts", path: "/workspace/src/a.ts"} as const;

describe('tool calls and messages over ACP v2', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('gives every agent and thought chunk a messageId shared by the chunks of one message', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await startTurn(client);

        const emitDelta = (method: "item/agentMessage/delta" | "item/reasoning/summaryTextDelta", itemId: string, delta: string) =>
            client.emit({method, params: {threadId: sessionId, turnId, itemId, delta, summaryIndex: 0}} as ServerNotification);
        emitDelta("item/reasoning/summaryTextDelta", "item-reasoning", "Thinking ");
        emitDelta("item/reasoning/summaryTextDelta", "item-reasoning", "hard");
        emitDelta("item/agentMessage/delta", "item-agent", "Hel");
        emitDelta("item/agentMessage/delta", "item-agent", "lo");
        // A turn error is reported as a one-off agent chunk with no Codex item behind it.
        client.emit({
            method: "error",
            params: {
                threadId: sessionId,
                turnId,
                willRetry: false,
                error: {message: "Something went wrong", codexErrorInfo: null, additionalDetails: null, misalignment: null},
            },
        });
        await finishTurn(client);

        const chunks = updatesTagged(client, "agent_message_chunk", "agent_thought_chunk") as Array<acpV2.SessionUpdate & {messageId: string}>;
        expect(chunks.map(chunk => chunk.messageId).slice(0, 4))
            .toEqual(["item-reasoning", "item-reasoning", "item-agent", "item-agent"]);
        const mintedId = chunks[4]!.messageId;
        expect(mintedId).toEqual(expect.any(String));
        expect(mintedId).not.toBe("");
        expect(["item-reasoning", "item-agent"]).not.toContain(mintedId);
        await expect(dump(chunks).replaceAll(mintedId, "<minted-messageId>"))
            .toMatchFileSnapshot('data/tool-calls-and-messages-v2-message-ids.json');
    });

    it('sends a tool call create as a tool_call_update upsert and passes later updates through', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await startTurn(client);

        client.emit(itemStarted(commandItem("item-read", [readAction])));
        client.emit(itemCompleted(commandItem("item-read", [readAction], "completed")));
        await finishTurn(client);

        const updates = updatesTagged(client, "tool_call", "tool_call_update");
        expect(updates.map(update => update.sessionUpdate)).toEqual(["tool_call_update", "tool_call_update"]);
        await expect(dump(updates)).toMatchFileSnapshot('data/tool-calls-and-messages-v2-tool-call-upsert.json');
    });

    it('still drops tool calls with diff or terminal content on v2', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        await startTurn(client);

        client.emit(itemStarted({
            type: "fileChange",
            id: "item-edit",
            status: "inProgress",
            changes: [{path: "/workspace/new.ts", kind: {type: "add"}, diff: "export {};\n"}],
        }));
        // No recognized command action: v1 reports this as a terminal.
        client.emit(itemStarted(commandItem("item-shell", [])));
        client.emit(itemStarted(commandItem("item-read", [readAction])));
        await finishTurn(client);

        // Only the read tool call reaches the client; the turn goes on to its `idle`.
        expect(updatesTagged(client, "tool_call", "tool_call_update").map(update => [update.sessionUpdate, (update as {toolCallId?: string}).toolCallId]))
            .toEqual([["tool_call_update", "item-read"]]);
        expect(client.transcript.at(-1)).toMatchObject({sessionUpdate: {sessionUpdate: "state_update", state: "idle", stopReason: "end_turn"}});
    });

    it('reports MCP server startup failures as tool_call_update upserts', async () => {
        const client = await connectSession(2, {
            mcpServers: [
                {type: "stdio", name: "docs", command: "/usr/bin/docs-mcp"},
                {type: "stdio", name: "slow", command: "/usr/bin/slow-mcp"},
            ],
            mcpStartup: {ready: [], failed: [{server: "docs", error: "exit code 1"}], cancelled: ["slow"]},
        });
        closeClient = () => client.connection.close();

        const startupUpdates = () => [
            ...client.setupUpdates,
            ...client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : []),
        ].filter(update => (update as {toolCallId?: string}).toolCallId?.startsWith("mcp_startup."));
        await vi.waitFor(() => expect(startupUpdates()).toHaveLength(2));

        await expect(dump(startupUpdates())).toMatchFileSnapshot('data/tool-calls-and-messages-v2-mcp-startup.json');
    });

    it('flags unknown unprefixed session update tags and v1-only shapes', () => {
        const violations = [
            {sessionUpdate: "_vendor/custom", value: 1},
            {sessionUpdate: "subagent_spawned", subagentSessionId: "child"},
            {sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run tests"},
            {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "no id"}},
            {sessionUpdate: "agent_message_chunk", messageId: "", content: {type: "text", text: "empty id"}},
            {sessionUpdate: "agent_message_chunk", messageId: "m-1", content: {type: "text", text: "ok"}},
            {sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed"},
        ].map(update => [update.sessionUpdate, v2SessionUpdateViolation(update as acpV2.SessionUpdate)]);

        expect(violations).toEqual([
            ["_vendor/custom", null],
            ["subagent_spawned", "unknown unprefixed sessionUpdate 'subagent_spawned'"],
            ["tool_call", "unknown unprefixed sessionUpdate 'tool_call'"],
            ["agent_message_chunk", expect.stringContaining("'agent_message_chunk' does not match its v2 schema")],
            ["agent_message_chunk", "'agent_message_chunk' has an empty messageId"],
            ["agent_message_chunk", null],
            ["tool_call_update", null],
        ]);
    });
});
