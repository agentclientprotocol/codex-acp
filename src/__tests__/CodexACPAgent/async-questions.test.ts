import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type {ThreadItem} from '../../app-server/v2';
import {
    connectSession,
    dump,
    itemCompleted,
    itemStarted,
    type PromptSession,
    settle,
    stateUpdates,
    sessionId,
    turnCompleted,
    turnStarted,
    userMessageItem,
} from './v2-prompt-harness';

const questionItem: ThreadItem = {
    type: "agentMessage",
    id: "call-question",
    text: "Which environment?\n- Staging\n- Production\n\nAnything else?",
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions: [
        {title: "Which environment?", options: ["Staging", "Production"]},
        {title: "Anything else?", options: null},
    ],
};

type Answer = (request: acpV2.CreateElicitationRequest, signal: AbortSignal) => Promise<acpV2.CreateElicitationResponse>;

describe.each([1, 2] as const)('async Codex questions over ACP v%i', (protocolVersion) => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        vi.clearAllMocks();
    });

    async function connect(onElicitation: Answer, steer: (params: unknown) => Promise<unknown> = async () => ({turnId: "turn-1"})) {
        const capabilities = {elicitation: {form: {}}};
        const client = await connectSession(protocolVersion, {
            clientCapabilities: capabilities,
            v1ClientCapabilities: {...capabilities, session: {notices: {}}},
            onElicitation,
        });
        closeClient = () => client.connection.close();
        const steers: unknown[] = [];
        client.setCodexResponse("turn/steer", async params => {
            steers.push({...(params as object), clientUserMessageId: "<id>"});
            return await steer(params);
        });
        return {client, steers};
    }

    /** Sends a prompt and lets Codex start its turn and ask the questions. */
    async function askDuringTurn(client: PromptSession) {
        const response = client.sendPrompt([{type: "text", text: "Hello"}]);
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        const clientUserMessageId = client.turnStartParams[0]!["clientUserMessageId"] as string;
        client.emit(turnStarted());
        client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
        // A v1 prompt responds only when its turn ends.
        if (protocolVersion === 2) await response;
        client.emit(itemStarted(questionItem));
        client.emit(itemCompleted(questionItem));
    }

    async function finishTurn(client: PromptSession) {
        client.emit(turnCompleted());
        await client.promptRunFinished();
        await settle();
    }

    function elicitationRequests(client: PromptSession) {
        return client.transcript.flatMap(entry => "elicitationRequest" in entry ? [entry.elicitationRequest] : []);
    }

    function notices(client: PromptSession) {
        return client.transcript.flatMap(entry => "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "notice"
            ? [entry.sessionUpdate] : []);
    }

    it('asks the questions and steers the answers into the turn that asked them', async () => {
        const {client, steers} = await connect(async () => ({
            action: "accept",
            content: {question_0: "Staging", question_0_note: "but only for now", question_1: "Use the new API"},
        }));
        await askDuringTurn(client);
        await vi.waitFor(() => expect(steers).toHaveLength(1));
        await finishTurn(client);

        await expect(dump({
            elicitationRequests: elicitationRequests(client),
            steers,
            notices: notices(client),
        })).toMatchFileSnapshot(`data/async-questions-v${protocolVersion}-answered.json`);
    });

    it('sends nothing to Codex when the user declines', async () => {
        const {client, steers} = await connect(async () => ({action: "decline"}));
        await askDuringTurn(client);
        await vi.waitFor(() => expect(elicitationRequests(client)).toHaveLength(1));
        await finishTurn(client);

        expect(steers).toEqual([]);
        expect(notices(client)).toEqual([]);
    });

    it('keeps the form open after completion and starts one turn for its answer', async () => {
        let answer!: (response: acpV2.CreateElicitationResponse) => void;
        let signal!: AbortSignal;
        const {client, steers} = await connect((_, pending) => {
            signal = pending;
            return new Promise(resolve => { answer = resolve; });
        });
        await askDuringTurn(client);
        await vi.waitFor(() => expect(elicitationRequests(client)).toHaveLength(1));
        await finishTurn(client);
        expect(signal.aborted).toBe(false);
        answer({action: "accept", content: {question_1: "After completion"}});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        const params = client.turnStartParams[1]!;
        client.emit(turnStarted("turn-2"));
        client.emit(itemCompleted(userMessageItem(params["clientUserMessageId"] as string), "turn-2"));
        client.emit(turnCompleted("turn-2"));
        await client.promptRunFinished(1);
        await settle();
        expect(steers).toEqual([]);
        expect(notices(client)).toEqual([]);
        if (protocolVersion === 2) {
            const users = client.transcript.filter(entry => "sessionUpdate" in entry
                && entry.sessionUpdate.sessionUpdate === "user_message_chunk");
            expect(users).toHaveLength(1);
        }
        await expect(dump({input: params["input"], states: stateUpdates(client.transcript)}))
            .toMatchFileSnapshot(`data/async-questions-v${protocolVersion}-continued.json`);
    });

    it('cancels an open form when its session closes and drops a stale answer', async () => {
        let cancelled = false;
        const {client, steers} = await connect((_, signal) => new Promise(resolve => {
            signal.addEventListener("abort", () => {
                cancelled = true;
                resolve({action: "accept", content: {question_1: "Too late"}});
            });
        }));
        await askDuringTurn(client);
        await vi.waitFor(() => expect(elicitationRequests(client)).toHaveLength(1));
        await finishTurn(client);
        await client.agent.closeSession({sessionId});
        await vi.waitFor(() => expect(cancelled).toBe(true));
        await settle();
        expect(steers).toEqual([]);
        expect(client.turnStartParams).toHaveLength(1);
    });

    it('reports an answer that Codex rejects while its turn still runs', async () => {
        const {client, steers} = await connect(
            async () => ({action: "accept", content: {question_1: "Rejected"}}),
            async () => { throw new Error("Invalid answer"); },
        );
        await askDuringTurn(client);
        await vi.waitFor(() => expect(notices(client)).toHaveLength(1));
        await finishTurn(client);
        expect(steers).toHaveLength(1);
        await expect(dump(notices(client))).toMatchFileSnapshot(`data/async-questions-v${protocolVersion}-rejected.json`);
    });

    if (protocolVersion === 2) {
        it('keeps valid answers when another property contains unsupported JSON', async () => {
            const {client, steers} = await connect(async () => ({action: "accept",
                content: {question_0: {unexpected: true}, question_0_note: [false], question_1: "Use the new API"}}));
            await askDuringTurn(client);
            await vi.waitFor(() => expect(steers).toHaveLength(1));
            await finishTurn(client);
            const input = (steers[0] as {input: Array<{text: string}>}).input[0]!.text;
            expect(input).toContain("Use the new API");
            expect(input).not.toContain("unexpected");
            expect(input).not.toContain("[object Object]");
            expect(input).not.toContain("false");
        });

        it('keeps the session running while the questions are open', async () => {
            const {client} = await connect((_, signal) => new Promise(resolve => {
                signal.addEventListener("abort", () => resolve({action: "cancel"}));
            }));
            await askDuringTurn(client);
            await vi.waitFor(() => expect(elicitationRequests(client)).toHaveLength(1));
            await settle();
            await finishTurn(client);

            expect(stateUpdates(client.transcript).map(update => update.state)).not.toContain("requires_action");
        });
    }
});
