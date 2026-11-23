import {afterEach, describe, expect, it, vi} from "vitest";
import {ResponseError} from "vscode-jsonrpc";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {
    connectSession, createTurn, itemCompleted, sessionId, settle, turnCompleted, turnStarted,
    userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

describe.each([1, 2] as const)("native non-steerable turns over ACP v%s", version => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    it.each(["review", "compact"])("waits for an external %s turn before starting input", async kind => {
        client = await connectSession(version);
        client.emit(turnStarted("external-turn"));
        await client.waitForNotifications();
        client.setTurnStart(async () => {
            if (client.appServer.runningTurnId(sessionId) === "external-turn") {
                throw new ResponseError(-32600, `cannot steer a ${kind} turn`);
            }
            return {turn: createTurn("inProgress", "next-turn")};
        });
        const response = client.sendPrompt([{type: "text", text: "After the native turn"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        await settle();
        expect(client.transcript.filter(entry => "promptError" in entry)).toEqual([]);
        client.emit(turnCompleted("external-turn"));
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const messageId = client.turnStartParams[1]!["clientUserMessageId"] as string;
        client.emit(turnStarted("next-turn"));
        client.emit(itemCompleted(userMessageItem(messageId), "next-turn"));
        if (version === 2) await expect(response).resolves.toEqual({messageId});
        client.emit(turnCompleted("next-turn"));
        await response;
        await client.promptRunFinished();
    });

    it.each(["review", "compact"])("cancels input waiting for an external %s turn without retrying", async kind => {
        client = await connectSession(version);
        client.emit(turnStarted("external-turn"));
        await client.waitForNotifications();
        client.setTurnStart(async () => {
            if (client.appServer.runningTurnId(sessionId) === "external-turn") {
                throw new ResponseError(-32600, `cannot steer a ${kind} turn`);
            }
            return {turn: createTurn("inProgress", "next-turn")};
        });
        const response = client.sendPrompt([{type: "text", text: "Do not submit this input"}])
            .then(result => ({result}), error => ({error}));
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        await settle();

        await client.cancel();
        if (version === 1) await expect(response).resolves.toMatchObject({result: {stopReason: "cancelled"}});
        else await expect(response).resolves.toMatchObject({error: {code: -32800}});
        await client.promptRunFinished();
        expect(client.turnStartParams).toHaveLength(1);

        client.emit(turnCompleted("external-turn"));
        await client.waitForNotifications();
        await settle();
        expect(client.turnStartParams).toHaveLength(1);
    });

    it("keeps an async answer until an adapter review turn finishes", async () => {
        let answer!: (response: {action: "accept"; content: Record<string, string>}) => void;
        client = await connectSession(version, {
            clientCapabilities: {elicitation: {form: {}}},
            v1ClientCapabilities: {elicitation: {form: {}}},
            onElicitation: () => new Promise(resolve => { answer = resolve; }),
        });
        const first = client.sendPrompt([{type: "text", text: "Ask a question"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!["clientUserMessageId"] as string)));
        client.emit(itemCompleted({type: "agentMessage", id: "question", text: "Which option?", phase: "final_answer",
            moderation: null, memoryCitation: null, delivery: "async", questions: [{title: "Which option?", options: null}]}));
        await vi.waitFor(() => expect(answer).toBeDefined());
        client.emit(turnCompleted());
        await first;
        await client.promptRunFinished();

        const start = vi.fn(async () => ({turn: createTurn("inProgress", "review-turn"), reviewThreadId: sessionId}));
        client.setCodexResponse("review/start", start);
        const steer = vi.fn(async () => { throw new Error("This review cannot accept steering"); });
        client.setCodexResponse("turn/steer", steer);
        const review = client.sendPrompt([{type: "text", text: "/review"}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        client.emit(turnStarted("review-turn"));
        await client.waitForNotifications();
        answer({action: "accept", content: {question_0: "Use SQLite"}});
        await settle();
        expect(steer).not.toHaveBeenCalled();
        expect(client.turnStartParams).toHaveLength(1);
        client.emit(turnCompleted("review-turn"));
        await review;
        await client.promptRunFinished(1);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const params = client.turnStartParams[1]!;
        expect(params["input"]).toEqual([expect.objectContaining({text: expect.stringContaining("Use SQLite")})]);
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(params["clientUserMessageId"] as string), "turn-2"));
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(2);
    });

    it("queues the steering extension behind an adapter review", async () => {
        client = await connectSession(version);
        const start = vi.fn(async () => ({turn: createTurn("inProgress", "review-turn"), reviewThreadId: sessionId}));
        client.setCodexResponse("review/start", start);
        const review = client.sendPrompt([{type: "text", text: "/review"}]);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        client.emit(turnStarted("review-turn"));
        await settle();
        const response = client.request(SESSION_STEERING_METHOD, {sessionId, prompt: [{type: "text", text: "After review"}]});
        await settle();
        expect(client.turnStartParams).toHaveLength(0);
        client.emit(turnCompleted("review-turn"));
        await review;
        await client.promptRunFinished();
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const messageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(messageId)));
        await expect(response).resolves.toEqual({outcome: "startedNewTurn"});
        client.emit(turnCompleted());
        await client.promptRunFinished(1);
    });
});
