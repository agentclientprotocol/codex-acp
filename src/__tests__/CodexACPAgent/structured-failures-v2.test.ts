import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {CodexErrorInfo} from "../../app-server/v2";
import {
    commandExecutionItem,
    connectSession,
    cwd,
    dump,
    itemCompleted,
    itemStarted,
    sessionId,
    settle,
    stateUpdates,
    turnCompleted,
    turnFinished,
    turnId,
    turnStarted,
    userMessageItem,
    type PromptSession,
} from "./v2-prompt-harness";
import {expectConformingV2SessionUpdates} from "./v2-session-update-guard";

function errorNotification(
    message: string,
    codexErrorInfo: CodexErrorInfo = "serverOverloaded",
    id = turnId,
    willRetry = false,
): Extract<ServerNotification, {method: "error"}> {
    return {
        method: "error",
        params: {
            threadId: sessionId, turnId: id, willRetry,
            error: {message, codexErrorInfo, additionalDetails: "private diagnostics", misalignment: null},
        },
    };
}

async function insert(client: PromptSession, index = 0, id = turnId) {
    const response = client.sendPrompt([{type: "text", text: "Hello"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
    const clientId = client.turnStartParams[index]!["clientUserMessageId"] as string;
    client.emit(turnStarted(id));
    client.emit(itemCompleted(userMessageItem(clientId), id));
    return await response;
}

function updates(client: PromptSession) {
    return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : []);
}

function lastIdle(client: PromptSession) {
    const idle = updates(client).filter(acpV2.SessionUpdate.isStateUpdate).filter(acpV2.StateUpdate.isIdle).at(-1);
    expect(idle).toBeDefined();
    return idle!;
}

describe("standard ACP v2 terminal failures", () => {
    let client: PromptSession;
    afterEach(() => {
        client?.connection.close();
        expectConformingV2SessionUpdates();
    });

    it.each([false, true])("reports provider failure independently of AIR support (%s) and does not replay it on resume", async air => {
        client = await connectSession(2, air ? {
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}},
        } : {});
        await insert(client);
        const message = JSON.stringify({
            type: "error", status: 429,
            error: {type: "rate_limit_error", message: "Try again later.", code: "rate_limited", param: null},
        });
        client.emit(errorNotification(message, "usageLimitExceeded"));
        client.emit(turnFinished("failed"));
        await client.promptRunFinished();
        await settle();

        const idle = lastIdle(client);
        expect(idle).toMatchObject({state: "idle", stopReason: "error", error: {code: -32603, message: "Try again later."}});
        expect(JSON.stringify(idle)).not.toContain("private diagnostics");
        if (air) expect(idle._meta).toHaveProperty("jetbrains.air.sessionFailure.severity", "error");
        else expect(idle._meta).not.toHaveProperty("jetbrains");
        await expect(dump(idle)).toMatchFileSnapshot(`data/structured-failure-v2-provider-${air ? "air" : "plain"}.json`);

        await client.request("session/resume", {sessionId, cwd});
        expect(lastIdle(client)).toEqual({sessionUpdate: "state_update", state: "idle"});
    });

    it.each([false, true])("reports auth failure before insertion through both the request and idle/error (%s)", async air => {
        client = await connectSession(2, air ? {
            clientCapabilities: {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionFailure"]}}}},
        } : {});
        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(errorNotification("private token-refresh diagnostic", "unauthorized"));
        client.emit(turnFinished("failed"));
        await expect(response).rejects.toMatchObject({code: -32000});
        await client.promptRunFinished();
        await settle();

        expect(updates(client).some(update => update.sessionUpdate === "user_message_chunk")).toBe(false);
        expect(lastIdle(client)).toMatchObject({
            state: "idle", stopReason: "error", error: {code: -32000, message: "Authentication required"},
        });
        expect(JSON.stringify(lastIdle(client))).not.toContain("private token-refresh diagnostic");
        await expect(dump(lastIdle(client))).toMatchFileSnapshot("data/structured-failure-v2-pre-insertion-auth.json");
    });

    it("does not turn a retried model error or a failed tool into terminal session failure", async () => {
        client = await connectSession();
        await insert(client);
        client.emit(errorNotification("Retrying", "serverOverloaded", turnId, true));
        client.emit(itemStarted(commandExecutionItem("failed-tool")));
        client.emit(itemCompleted(commandExecutionItem("failed-tool", "failed")));
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();

        expect(stateUpdates(client.transcript)).toEqual([{state: "running"}, {state: "idle", stopReason: "end_turn"}]);
        expect(lastIdle(client)).not.toHaveProperty("error");
    });

    it.each(["completed", "failed"] as const)("does not attribute another turn's error to current work (%s)", async status => {
        client = await connectSession();
        await insert(client);
        client.emit(errorNotification("Another turn's private error", "serverOverloaded", "other-turn"));
        client.emit(turnFinished(status));
        await client.promptRunFinished();
        await settle();

        expect(lastIdle(client)).toMatchObject({stopReason: status === "failed" ? "error" : "end_turn"});
        expect(JSON.stringify(lastIdle(client))).not.toContain("Another turn's private error");
        if (status === "failed") expect(lastIdle(client)).toHaveProperty("error.message", "Codex turn failed.");
    });

    it.each(["prompt", "agent"] as const)("fails unfinished tools before reporting failed %s work as idle/error", async owner => {
        client = await connectSession();
        if (owner === "prompt") await insert(client);
        else client.emit(turnStarted());
        client.emit(itemStarted(commandExecutionItem("unfinished-tool")));
        client.emit(errorNotification("Provider unavailable"));
        client.emit(turnFinished("failed"));
        if (owner === "prompt") await client.promptRunFinished();
        await settle();

        const rendered = updates(client);
        const failedTool = rendered.findIndex(update => update.sessionUpdate === "tool_call_update"
            && update.toolCallId === "unfinished-tool" && update.status === "failed");
        expect(failedTool).toBeGreaterThanOrEqual(0);
        expect(rendered.indexOf(lastIdle(client))).toBeGreaterThan(failedTool);
        expect(lastIdle(client)).toHaveProperty("error.message", "Provider unavailable");
        await expect(dump(lastIdle(client))).toMatchFileSnapshot(`data/structured-failure-v2-${owner}-idle.json`);
    });

    it("keeps cancellation authoritative when the runtime reports an error while aborting", async () => {
        client = await connectSession();
        await insert(client);
        await client.cancel();
        await vi.waitFor(() => expect(client.turnInterruptCalls()).toHaveLength(1));
        client.emit(errorNotification("Error while aborting"));
        client.emit(turnFinished("failed"));
        await client.promptRunFinished();
        await settle();

        expect(lastIdle(client)).toMatchObject({state: "idle", stopReason: "cancelled"});
        expect(lastIdle(client)).not.toHaveProperty("error");
    });

    it("reports a failed implementation turn within the original accepted prompt", async () => {
        client = await connectSession(2, {
            onRequestPermission: () => ({outcome: {outcome: "selected", optionId: "implement_plan"}}),
        });
        await client.sendPrompt([{type: "text", text: "/plan"}]);
        await client.promptRunFinished(0);
        await insert(client);
        client.emit(itemCompleted({type: "plan", id: "plan-item", text: "1. Implement the change."}));
        client.emit(turnCompleted());
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        client.emit(turnStarted("turn-2"));
        const implementationId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(itemCompleted(userMessageItem(implementationId, "Implement the approved plan."), "turn-2"));
        client.emit(errorNotification("Implementation failed", "serverOverloaded", "turn-2"));
        client.emit(turnFinished("failed", "turn-2"));
        await client.promptRunFinished(1);
        await settle();

        expect(lastIdle(client)).toMatchObject({stopReason: "error", error: {code: -32603, message: "Implementation failed"}});
        await expect(dump(lastIdle(client))).toMatchFileSnapshot("data/structured-failure-v2-implementation-idle.json");
    });

    it("does not send a terminal state for an idle background error", async () => {
        client = await connectSession();
        client.emit(errorNotification("Background failure", "serverOverloaded", "background-turn"));
        await settle();
        expect(stateUpdates(client.transcript)).toEqual([]);
    });
});
