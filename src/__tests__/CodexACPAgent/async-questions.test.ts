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

    it('cancels the questions when their turn ends, and reports an answer that arrives after that', async () => {
        let cancelled = false;
        const {client, steers} = await connect((_, signal) => new Promise(resolve => {
            // A client that still answers after the cancellation.
            signal.addEventListener("abort", () => {
                cancelled = true;
                resolve({action: "accept", content: {question_1: "Too late"}});
            });
        }));
        await askDuringTurn(client);
        await vi.waitFor(() => expect(elicitationRequests(client)).toHaveLength(1));
        await finishTurn(client);
        await vi.waitFor(() => expect(notices(client)).toHaveLength(1));

        expect(cancelled).toBe(true);
        expect(steers).toEqual([]);
        await expect(dump(notices(client))).toMatchFileSnapshot(`data/async-questions-v${protocolVersion}-dropped.json`);
    });

    it('reports an answer that Codex rejects because its turn has ended', async () => {
        const {client, steers} = await connect(
            async () => ({action: "accept", content: {question_1: "Late"}}),
            async () => { throw new Error("no active turn to steer"); },
        );
        await askDuringTurn(client);
        await vi.waitFor(() => expect(notices(client)).toHaveLength(1));
        await finishTurn(client);

        expect(steers).toHaveLength(1);
        await expect(dump(notices(client))).toMatchFileSnapshot(`data/async-questions-v${protocolVersion}-rejected.json`);
    });

    if (protocolVersion === 2) {
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
