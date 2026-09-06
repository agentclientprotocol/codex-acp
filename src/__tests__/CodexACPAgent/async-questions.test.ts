import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import {ASYNC_QUESTION_REQUEST_METHOD} from "../../AsyncQuestionExtension";
import type {AsyncQuestionRequest, AsyncQuestionResponse} from "../../AsyncQuestionExtension";
import type {Turn, TurnCompletedNotification} from "../../app-server/v2";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return {promise, resolve};
}

function turn(id: string, status: Turn["status"]): Turn {
    return {id, status, items: [], itemsView: "notLoaded", error: null, startedAt: null, completedAt: null, durationMs: null};
}

function airCapabilities(version: unknown = 1, capabilities: unknown = ["asyncQuestions"]): acp.ClientCapabilities {
    return {_meta: {jetbrains: {air: {version, capabilities}}}};
}

async function setup(clientCapabilities: acp.ClientCapabilities = airCapabilities()) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const appServer = fixture.getCodexAppServerClient();
    const session = createTestSessionState({sessionId: "session-id"});
    vi.spyOn(agent, "getSessionState").mockReturnValue(session);
    const initialized = await agent.initialize({protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
    });
    const completion = deferred<TurnCompletedNotification>();
    const nextCompletion = deferred<TurnCompletedNotification>();
    const start = vi.spyOn(appServer, "turnStart")
        .mockResolvedValueOnce({turn: turn("turn-1", "inProgress")})
        .mockResolvedValue({turn: turn("turn-2", "inProgress")});
    vi.spyOn(appServer, "awaitTurnCompleted").mockReturnValueOnce(completion.promise).mockReturnValue(nextCompletion.promise);
    const steer = vi.spyOn(appServer, "turnSteer").mockResolvedValue({turnId: "turn-1"});
    const requestSignals: AbortSignal[] = [];
    fixture.onAcpConnectionEvent(event => {
        if (event.method === "request" && event.args[0] === ASYNC_QUESTION_REQUEST_METHOD) {
            requestSignals.push(event.args[2].cancellationSignal);
        }
    });
    const response = deferred<AsyncQuestionResponse>();
    fixture.setExtensionResponse(ASYNC_QUESTION_REQUEST_METHOD, response.promise);
    const prompt = agent.prompt({sessionId: session.sessionId, prompt: [{type: "text", text: "Do some work"}]});
    await vi.waitFor(() => expect(session.currentTurnId).toBe("turn-1"));
    const questions = [
        {title: "Есть номер YouTrack-задачи?", options: null},
        {title: "Which scope?", options: ["Platform", "Plugin"]},
    ];
    const item = {type: "agentMessage", id: "question-call", text: questions.map(q => q.title).join("\n"),
        phase: "final_answer", memoryCitation: null, delivery: "async", questions};
    async function sendQuestion() {
        fixture.sendServerNotification({method: "item/completed", params: {threadId: session.sessionId, turnId: "turn-1", item}});
        await fixture.getCodexAcpClient().waitForSessionNotifications(session.sessionId);
    }
    function requests() {
        return fixture.getAcpConnectionEvents([]).filter(e => e.method === "request" && e.args[0] === ASYNC_QUESTION_REQUEST_METHOD);
    }
    function answer() {
        const request = requests()[0]!.args[1] as AsyncQuestionRequest;
        response.resolve({status: "answered", answers: request.questions.map((q, i) => ({id: q.id,
            answer: i === 0 ? "давай создай задачу" : "A custom scope"}))});
    }
    async function finish() {
        completion.resolve({threadId: session.sessionId, turn: turn("turn-1", "completed")});
        await prompt;
    }
    return {fixture, agent, session, initialized, response, requestSignals, start, steer, sendQuestion, requests, answer, finish, nextCompletion};
}

describe("asynchronous user questions", () => {
    it("negotiates the extension, keeps streaming, deduplicates questions, and steers the answer", async () => {
        const f = await setup();
        await f.sendQuestion();
        await f.sendQuestion();
        f.fixture.sendServerNotification({method: "item/agentMessage/delta", params: {
            threadId: "session-id", turnId: "turn-1", itemId: "progress", delta: "Working while the question is open",
        }});
        await f.fixture.getCodexAcpClient().waitForSessionNotifications("session-id");
        expect(f.requests()).toHaveLength(1);
        expect(f.steer).not.toHaveBeenCalled();
        f.answer();
        await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(1));
        await expect(JSON.stringify({
            capability: f.initialized._meta?.["jetbrains"],
            request: f.requests()[0]!.args.slice(0, 2),
            updates: f.fixture.getAcpConnectionEvents([]).filter(e => e.method === "sessionUpdate"
                && e.args[0].update.sessionUpdate === "agent_message_chunk"),
            steer: f.steer.mock.calls[0],
        }, null, 2)).toMatchFileSnapshot("./snapshots/async-questions-active.json");
        await f.finish();
    });

    it("keeps the request alive after completion and starts a new turn with the answer", async () => {
        const f = await setup();
        await f.sendQuestion();
        await f.finish();
        expect(f.requestSignals[0]!.aborted).toBe(false);
        f.answer();
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
        expect(f.steer).not.toHaveBeenCalled();
        await expect(JSON.stringify(f.start.mock.calls[1]![0].input, null, 2))
            .toMatchFileSnapshot("./snapshots/async-questions-late-input.json");
        f.nextCompletion.resolve({threadId: "session-id", turn: turn("turn-2", "completed")});
        await vi.waitFor(() => expect(f.session.currentTurnId).toBeNull());
    });

    it.each([{}, airCapabilities(0), airCapabilities("1"), airCapabilities(1, []),
        {_meta: {"codex.asyncQuestions": {version: 1}}},
    ])("falls back to text without AIR negotiation: %j", async capabilities => {
        const f = await setup(capabilities);
        await f.sendQuestion();
        expect(f.requests()).toHaveLength(0);
        expect(f.fixture.getAcpConnectionEvents([]).some(e => e.method === "sessionUpdate"
            && e.args[0].update.content?.text === "Есть номер YouTrack-задачи?\nWhich scope?")).toBe(true);
        await f.finish();
    });

    it("uses the shared AIR version compatibility rule", async () => {
        const f = await setup(airCapabilities(2));
        await f.sendQuestion();
        expect(f.requests()).toHaveLength(1);
        f.response.resolve({status: "dismissed"});
        await f.finish();
    });

    it("does not repeat question text that already arrived as a delta", async () => {
        const f = await setup();
        f.fixture.sendServerNotification({method: "item/agentMessage/delta", params: {
            threadId: "session-id", turnId: "turn-1", itemId: "question-call", delta: "Already streamed question",
        }});
        await f.sendQuestion();
        const textEvents = f.fixture.getAcpConnectionEvents([]).filter(e => e.method === "sessionUpdate"
            && e.args[0].update.messageId === "question-call");
        expect(textEvents).toHaveLength(1);
        expect(textEvents[0]!.args[0].update.content.text).toBe("Already streamed question");
        expect(f.requests()).toHaveLength(1);
        f.response.resolve({status: "dismissed"});
        await f.finish();
    });

    it("uses a new turn if the active turn finishes during answer delivery", async () => {
        const f = await setup();
        f.steer.mockImplementationOnce(async () => {
            await f.finish();
            throw new Error("no active turn to steer");
        });
        await f.sendQuestion();
        f.answer();
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
        expect(f.steer).toHaveBeenCalledTimes(1);
        expect(f.start.mock.calls[1]![0].input).toEqual(f.steer.mock.calls[0]![0].input);
        f.nextCompletion.resolve({threadId: "session-id", turn: turn("turn-2", "completed")});
        await vi.waitFor(() => expect(f.session.currentTurnId).toBeNull());
    });

    it("cancels an answer waiting behind another steering request", async () => {
        const f = await setup();
        const blocked = deferred<{turnId: string}>();
        f.steer.mockReturnValueOnce(blocked.promise);
        const first = f.agent.executeOrQueueSteeringRequest({sessionId: "session-id",
            prompt: [{type: "text", text: "Other input"}]});
        await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(1));
        await f.sendQuestion();
        const enqueued = vi.spyOn(f.agent, "executeOrQueueSteeringRequest");
        f.answer();
        await vi.waitFor(() => expect(enqueued).toHaveBeenCalledTimes(1));
        await f.agent.cancel({sessionId: "session-id"});
        blocked.resolve({turnId: "turn-1"});
        await first;
        await enqueued.mock.results[0]!.value;
        expect(f.steer).toHaveBeenCalledTimes(1);
        expect(f.start).toHaveBeenCalledTimes(1);
        await f.finish();
    });

    it("reports a delivery failure without retrying the answer", async () => {
        const f = await setup();
        f.steer.mockRejectedValue(new Error("Transport failure"));
        await f.sendQuestion();
        f.answer();
        await vi.waitFor(() => expect(f.fixture.getAcpConnectionEvents([]).some(e => e.method === "sessionUpdate"
            && e.args[0].update.content?.text?.includes("Please send your answer in chat"))).toBe(true));
        expect(f.steer).toHaveBeenCalledTimes(1);
        expect(f.start).toHaveBeenCalledTimes(1);
        await f.finish();
    });

    it.each(["dismiss", "cancel", "close"])("does not submit input after %s", async action => {
        const f = await setup();
        await f.sendQuestion();
        await f.finish();
        if (action === "dismiss") {
            f.response.resolve({status: "dismissed"});
        } else {
            if (action === "cancel") await f.agent.cancel({sessionId: "session-id"});
            else await f.agent.closeSession({sessionId: "session-id"});
            expect(f.requestSignals[0]!.aborted).toBe(true);
            // A client may ignore RPC cancellation and still return a result.
            f.answer();
        }
        await new Promise(resolve => setImmediate(resolve));
        expect(f.steer).not.toHaveBeenCalled();
        expect(f.start).toHaveBeenCalledTimes(1);
    });

    it.each([
        {status: "answered", answers: []},
        {status: "answered", answers: [{id: "unknown", answer: "a"}, {id: "unknown", answer: "b"}]},
        {status: "unexpected"},
    ])("reports invalid responses without submitting input: %j", async response => {
        const f = await setup();
        await f.sendQuestion();
        f.response.resolve(response as AsyncQuestionResponse);
        await vi.waitFor(() => expect(f.fixture.getAcpConnectionEvents([]).some(e => e.method === "sessionUpdate"
            && e.args[0].update.content?.text?.includes("Please send your answer in chat"))).toBe(true));
        expect(f.steer).not.toHaveBeenCalled();
        await f.finish();
    });
});
