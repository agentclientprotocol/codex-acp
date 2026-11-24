import {afterEach, describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {Thread, ThreadItem, Turn, TurnStatus} from "../../app-server/v2";
import {OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import {stubGatewayModelListing} from "../acp-test-utils";
import {
    agentMessageDelta, connectSession, createReplacementCodexAcpClient, createThread, createTurn, dump, sessionId, settle,
    turnFinished, turnStarted, userMessageItem, type PromptSession,
} from "./v2-prompt-harness";

stubGatewayModelListing(["gpt-5"]);

const REWIND = "_session/rewind";
const airCapabilities = (capabilities: string[]) => ({_meta: {jetbrains: {air: {version: 1, capabilities}}}});
const rewindClient = {session: {cursors: {}}, ...airCapabilities(["sessionRewind"])};

function turn(id: string, status: TurnStatus, items: ThreadItem[]): Turn {
    return {...createTurn(status, id), itemsView: "summary", items};
}

const planImplementationClientId = "codex-acp:plan-implementation:test";

const agentItem: ThreadItem = {type: "agentMessage", id: "agent-1", text: "Steered", phase: null, memoryCitation: null, moderation: null, delivery: null, questions: null};

const initialTurns = (): Turn[] => [
    turn("turn-1", "completed", [userMessageItem("c1", "First")]),
    turn("turn-2", "completed", [userMessageItem("c2", "Second")]),
    turn("turn-steer", "completed", [agentItem]),
    turn("turn-3", "completed", [userMessageItem("c3", "Third")]),
    turn("turn-hidden", "completed", [userMessageItem(planImplementationClientId, "Implement the plan")]),
    turn("turn-running", "inProgress", [userMessageItem("c5", "Fifth")]),
    turn("turn-after-running", "completed", [userMessageItem("c6", "Sixth")]),
];

type Update = {sessionUpdate: string} & Record<string, unknown>;

function updates(client: PromptSession): Update[] {
    return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate as unknown as Update] : []);
}

/** The cursors as they went over the wire: the client SDK drops the `rewind` capability that it does not know. */
function wireCursors(client: PromptSession): Update[] {
    return client.wireMessages.flatMap(message => {
        const params = (message as {method?: string; params?: {update?: Update}}).params;
        return (message as {method?: string}).method === "session/update" && params?.update?.sessionUpdate === "cursor_update"
            ? [params.update] : [];
    });
}

describe("_session/rewind", () => {
    let client: PromptSession;
    let turns: Turn[];
    let revertParams: Array<{threadId: string; beforeTurnId: string}>;
    let revert: (params: {threadId: string; beforeTurnId: string}) => Promise<unknown>;
    afterEach(() => client?.connection.close());

    /** Codex cuts the turn and everything after it. */
    const cut = (beforeTurnId: string) => {
        turns = turns.slice(0, turns.findIndex(candidate => candidate.id === beforeTurnId));
    };

    async function connect(options: {capabilities?: Record<string, unknown>; historyMode?: Thread["historyMode"]; ephemeral?: boolean} = {}) {
        turns = initialTurns();
        revertParams = [];
        revert = async params => {
            cut(params.beforeTurnId);
            return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
        };
        client = await connectSession(1, {
            v1ClientCapabilities: (options.capabilities ?? rewindClient) as never,
            codexResponses: {
                "thread/start": async () => ({
                    thread: {...createThread(), historyMode: options.historyMode ?? "paginated", ephemeral: options.ephemeral ?? false},
                    model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
                }),
                "thread/turns/list": async () => ({data: turns, nextCursor: null}),
                "thread/revert": async params => {
                    revertParams.push(params as never);
                    return await revert(params as never);
                },
            },
        });
    }

    const rewind = (cursorId: string, id = sessionId) => client.request(REWIND, {sessionId: id, cursorId});

    it("reverts before the cursor's turn, and the cut cursor is gone", async () => {
        await connect();

        await expect(rewind("before:turn-2")).resolves.toEqual({rewound: true});

        expect(revertParams).toEqual([{threadId: sessionId, beforeTurnId: "turn-2"}]);
        await expect(rewind("before:turn-3")).rejects.toMatchObject({code: -32602});
        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32602});
    });

    it("keeps the session usable, with no update from the reload of the thread", async () => {
        await connect();
        revert = async params => {
            cut(params.beforeTurnId);
            // What Codex reports while `thread/revert` reloads the thread.
            const status = (type: "notLoaded" | "idle") => ({method: "thread/status/changed", params: {threadId: sessionId, status: {type}}}) as ServerNotification;
            client.emit(status("notLoaded"));
            client.emit({method: "mcpServer/startupStatus/updated", params: {name: "x", status: "starting", error: null}} as ServerNotification);
            client.emit(status("idle"));
            return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
        };

        await expect(rewind("before:turn-2")).resolves.toEqual({rewound: true});
        await settle();

        expect(updates(client)).toEqual([]);
    });

    describe("refuses before it calls thread/revert", () => {
        it("while a prompt runs", async () => {
            await connect();
            client.setTurnStart(async () => ({turn: createTurn("inProgress", "turn-run")}));
            const prompt = client.sendPrompt([{type: "text", text: "Work"}]);
            await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
            client.emit(turnStarted("turn-run"));

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "busy"});

            expect(revertParams).toEqual([]);
            client.emit(turnFinished("completed", "turn-run"));
            await prompt;
        });

        it("while Codex runs a turn that no prompt started", async () => {
            await connect();
            client.emit(turnStarted("goal-turn"));
            await settle();

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "busy"});

            expect(revertParams).toEqual([]);
        });

        it("while a steering request is queued", async () => {
            await connect();
            const queues = (client.agent as unknown as {steeringQueues: Map<string, {isIdle: boolean}>}).steeringQueues;
            queues.set(sessionId, {isIdle: false});

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "busy"});

            queues.delete(sessionId);
            expect(revertParams).toEqual([]);
        });

        it("while a system prompt update is pending", async () => {
            await connect();
            const updating = (client.agent as unknown as {instructionUpdates: Set<string>}).instructionUpdates;
            updating.add(sessionId);

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "busy"});

            updating.delete(sessionId);
            expect(revertParams).toEqual([]);
        });

        it("while a background terminal runs", async () => {
            await connect();
            client.setCodexResponse("thread/backgroundTerminals/list", async () => ({
                data: [{itemId: "cmd-1", processId: "1", command: "sleep 100", cwd: "/workspace"}],
                nextCursor: null,
            }));

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "backgroundWork"});

            expect(revertParams).toEqual([]);
        });

        it.each([
            ["thread/backgroundTerminals/list", {data: [], nextCursor: null}],
            ["thread/turns/list", null],
        ] as const)("when Codex starts a turn during %s", async (method, response) => {
            await connect();
            client.setCodexResponse(method, async () => {
                client.emit(turnStarted("goal-turn"));
                await settle();
                return response ?? {data: turns, nextCursor: null};
            });

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "busy"});

            expect(revertParams).toEqual([]);
        });

        it("when a native subagent starts during the awaits", async () => {
            await connect();
            const subagents = (client.agent as unknown as {sessions: Map<string, {subagents: {hasOutstanding(): boolean}}>}).sessions.get(sessionId)!.subagents;
            let running = false;
            vi.spyOn(subagents, "hasOutstanding").mockImplementation(() => running);
            client.setCodexResponse("thread/turns/list", async () => {
                running = true;
                return {data: turns, nextCursor: null};
            });

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "backgroundWork"});

            expect(revertParams).toEqual([]);
        });

        it("while a native subagent runs", async () => {
            await connect();
            vi.spyOn((client.agent as unknown as {sessions: Map<string, {subagents: {hasOutstanding(): boolean}}>}).sessions.get(sessionId)!.subagents, "hasOutstanding").mockReturnValue(true);

            await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "backgroundWork"});

            expect(revertParams).toEqual([]);
        });
    });

    it("answers providerRefused when Codex refuses and the turn stays", async () => {
        await connect();
        revert = async () => { throw new Error("turn not found: turn-2"); };

        await expect(rewind("before:turn-2")).resolves.toEqual({rewound: false, reason: "providerRefused"});

        expect(revertParams).toHaveLength(1);
    });

    it("counts a failed thread/revert as the cut when the turn is gone", async () => {
        await connect();
        revert = async params => {
            cut(params.beforeTurnId);
            throw new Error("the response got lost");
        };

        await expect(rewind("before:turn-2")).resolves.toEqual({rewound: true});
    });

    it("fails with the revert error when the thread cannot be read to check it", async () => {
        await connect();
        revert = async () => { throw new Error("revert exploded"); };
        client.setCodexResponse("thread/turns/list", async () => {
            if (revertParams.length > 0) throw new Error("list exploded");
            return {data: turns, nextCursor: null};
        });

        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32603, data: {details: "revert exploded"}});
    });

    it("clears the prediction that the client holds", async () => {
        await connect();
        client.setCodexResponse("thread/sample", async params => ({
            sourceTurnId: (params as {expectedTurnId: string}).expectedTurnId, responseId: "r",
            text: JSON.stringify({suggestion: "Run the tests"}),
            inputTokens: null, cachedInputTokens: null, outputTokens: null,
        }));
        const suggestions = () => client.scopedUpdates.flatMap(({update}) => {
            const meta = (update as {_meta?: Record<string, unknown>})._meta;
            return update.sessionUpdate === "session_info_update" && meta?.["promptSuggestions"] !== undefined ? [meta["promptSuggestions"]] : [];
        });
        client.agent.getSessionState(sessionId).promptSuggestions?.onTurnCompleted(sessionId, "turn-3");
        await vi.waitFor(() => expect(suggestions()).toEqual([{suggestions: [{text: "Run the tests"}]}]));

        await expect(rewind("before:turn-2")).resolves.toEqual({rewound: true});

        expect(suggestions()).toEqual([{suggestions: [{text: "Run the tests"}]}, {suggestions: []}]);
    });

    it("is not found for a client that did not declare sessionRewind", async () => {
        await connect({capabilities: {session: {cursors: {}}, ...airCapabilities(["diffPatch"])}});

        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32601});

        expect(revertParams).toEqual([]);
    });

    it("is not found on ACP v2", async () => {
        client = await connectSession(2, {clientCapabilities: airCapabilities(["sessionRewind"]) as never});

        await expect(client.request(REWIND, {sessionId, cursorId: "before:turn-2"})).rejects.toMatchObject({code: -32601});
    });

    it("is not found for a client that is not AIR", async () => {
        await connect({capabilities: {session: {cursors: {}}}});

        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32601});
    });

    it("fails with resource not found for a session the agent does not hold", async () => {
        await connect();

        await expect(rewind("before:turn-2", "thread-unknown")).rejects.toMatchObject({code: -32002});
    });

    it.each([
        ["an unknown cursor", "before:turn-nope"],
        ["an id that is no cursor", "turn-2"],
        ["the cursor of the first turn", "before:turn-1"],
        ["the cursor of a steer-only turn", "before:turn-steer"],
        ["the cursor of a turn whose first message is hidden", "before:turn-hidden"],
        ["the cursor of a turn that still runs", "before:turn-running"],
        ["the cursor of the turn after one that still runs", "before:turn-after-running"],
    ])("rejects %s", async (_name, cursorId) => {
        await connect();

        await expect(rewind(cursorId)).rejects.toMatchObject({code: -32602});

        expect(revertParams).toEqual([]);
    });

    it("rejects a subagent session", async () => {
        await connect();
        vi.spyOn(client.agent as unknown as {isRestrictedChild(id: string): boolean}, "isRestrictedChild").mockReturnValue(true);

        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32602});

        expect(revertParams).toEqual([]);
    });

    it.each([
        ["legacy history", {historyMode: "legacy"}],
        ["an ephemeral thread", {ephemeral: true}],
    ] as const)("rejects a session whose history Codex cannot revert: %s", async (_name, options) => {
        await connect(options);

        await expect(rewind("before:turn-2")).rejects.toMatchObject({code: -32602});

        expect(revertParams).toEqual([]);
    });

    it.each([
        ["set", {action: "set", objective: "Ship"}, "setGoal", false],
        ["resume", {action: "resume"}, "resumeGoal", false],
        ["pause", {action: "pause"}, "setGoalStatus", true],
        ["clear", {action: "clear"}, "clearGoal", true],
    ] as const)("goal action %s during the rewind", async (_name, params, method, allowed) => {
        await connect();
        let finishRevert: () => void = () => {};
        const reverting = new Promise<void>(resolve => { finishRevert = resolve; });
        revert = async revertRequest => {
            await reverting;
            cut(revertRequest.beforeTurnId);
            return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
        };
        const codexAcpClient = (client.agent as unknown as {codexAcpClient: Record<string, () => Promise<unknown>>}).codexAcpClient;
        const goalCalls = vi.spyOn(codexAcpClient, method).mockResolvedValue(
            method === "setGoalStatus"
                ? {threadId: sessionId, objective: "Ship", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1}
                : undefined,
        );
        const rewinding = rewind("before:turn-2");
        await vi.waitFor(() => expect(revertParams).toHaveLength(1));

        const goal = client.request("_session/goal", {sessionId, ...params});
        if (allowed) {
            await expect(goal).resolves.toEqual({});
            expect(goalCalls).toHaveBeenCalledTimes(1);
        } else {
            await expect(goal).rejects.toMatchObject({code: -32600});
            expect(goalCalls).not.toHaveBeenCalled();
        }
        finishRevert();
        await expect(rewinding).resolves.toEqual({rewound: true});
    });

    it("leaves the records of a session that was replaced during the revert", async () => {
        await connect();
        let finishRevert: () => void = () => {};
        const reverting = new Promise<void>(resolve => { finishRevert = resolve; });
        revert = async params => {
            await reverting;
            cut(params.beforeTurnId);
            return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
        };
        const server = client.agent as unknown as {
            sessions: Map<string, unknown>;
            clientDelivery: {entities: {rewind: (sessionId: string, cursorId: string) => void}};
        };
        const entitiesRewind = vi.spyOn(server.clientDelivery.entities, "rewind");
        const rewinding = rewind("before:turn-2");
        await vi.waitFor(() => expect(revertParams).toHaveLength(1));

        // A same-id `session/load` puts a new state in the map.
        server.sessions.set(sessionId, {...(server.sessions.get(sessionId) as object)});
        finishRevert();

        await expect(rewinding).resolves.toEqual({rewound: true});
        expect(entitiesRewind).not.toHaveBeenCalled();
    });

    it("does not revert a session that is closed during the rewind", async () => {
        await connect();
        let listed: () => void = () => {};
        const listing = new Promise<void>(resolve => { listed = resolve; });
        let release: () => void = () => {};
        const released = new Promise<void>(resolve => { release = resolve; });
        client.setCodexResponse("thread/turns/list", async () => {
            listed();
            await released;
            return {data: turns, nextCursor: null};
        });
        const rewinding = rewind("before:turn-2");
        const outcome = rewinding.then(() => null, (error: unknown) => error);
        await listing;

        await client.request("session/close", {sessionId});
        release();

        await expect(outcome).resolves.toMatchObject({code: -32002});
        expect(revertParams).toEqual([]);
    });

    it("does not revert when a same-id session/load begins during the rewind", async () => {
        await connect();
        let listed: () => void = () => {};
        const listing = new Promise<void>(resolve => { listed = resolve; });
        let release: () => void = () => {};
        const released = new Promise<void>(resolve => { release = resolve; });
        client.setCodexResponse("thread/turns/list", async () => {
            listed();
            await released;
            return {data: turns, nextCursor: null};
        });
        const rewinding = rewind("before:turn-2");
        const outcome = rewinding.then(() => null, (error: unknown) => error);
        await listing;

        let resumeStarted: () => void = () => {};
        const resuming = new Promise<void>(resolve => { resumeStarted = resolve; });
        let finishResume: () => void = () => {};
        const resumeHeld = new Promise<void>(resolve => { finishResume = resolve; });
        client.setCodexResponse("thread/resume", async () => {
            resumeStarted();
            await resumeHeld;
            return {
                thread: createThread(), model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
            } as never;
        });
        const loading = client.request("session/load", {sessionId, cwd: "/workspace", mcpServers: []}).catch(() => {});
        await resuming;
        release();

        await expect(outcome).resolves.toMatchObject({code: -32002});
        expect(revertParams).toEqual([]);
        finishResume();
        await loading;
    });

    it("does not revert when a same-id session/load begins while the rewind waits for the app-server", async () => {
        await connect();
        let appServerReady: () => void = () => {};
        const waiting = new Promise<void>(resolve => { appServerReady = resolve; });
        vi.spyOn(client.agent as unknown as {ensureAppServer(): Promise<void>}, "ensureAppServer").mockReturnValueOnce(waiting);
        const rewinding = rewind("before:turn-2");
        const outcome = rewinding.then(() => null, (error: unknown) => error);
        await settle();

        let finishResume: () => void = () => {};
        const resumeHeld = new Promise<void>(resolve => { finishResume = resolve; });
        let resumeStarted = false;
        client.setCodexResponse("thread/resume", async () => {
            resumeStarted = true;
            await resumeHeld;
            return {
                thread: createThread(), model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
            } as never;
        });
        const loading = client.request("session/load", {sessionId, cwd: "/workspace", mcpServers: []}).catch(() => {});
        await vi.waitFor(() => expect(resumeStarted).toBe(true));
        appServerReady();

        await expect(outcome).resolves.toMatchObject({code: -32002});
        expect(revertParams).toEqual([]);
        finishResume();
        await loading;
    });

    describe("with a provider update", () => {
        const setProvider = () => client.request("providers/set", {
            providerId: OPENAI_PROVIDER_ID, apiType: "openai", baseUrl: "https://gateway.example/v1",
        });

        it("restarts the app-server only after a rewind in flight settled", async () => {
            await connect();
            let finishRevert: () => void = () => {};
            const reverting = new Promise<void>(resolve => { finishRevert = resolve; });
            revert = async params => {
                await reverting;
                cut(params.beforeTurnId);
                return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
            };
            const restart = vi.spyOn(client.agent as unknown as {restartCodexClient(): Promise<unknown>}, "restartCodexClient")
                .mockResolvedValue(createReplacementCodexAcpClient().codexAcpClient);
            const rewinding = rewind("before:turn-2");
            await vi.waitFor(() => expect(revertParams).toHaveLength(1));

            const providerSet = setProvider();
            await settle();
            expect(restart).not.toHaveBeenCalled();

            finishRevert();
            await expect(rewinding).resolves.toEqual({rewound: true});
            await providerSet;
            expect(restart).toHaveBeenCalledTimes(1);
        });

        it("makes a rewind that is sent during the update wait for it", async () => {
            await connect();
            let finishRestart: (replacement: unknown) => void = () => {};
            const restarting = new Promise<unknown>(resolve => { finishRestart = resolve; });
            const restart = vi.spyOn(client.agent as unknown as {restartCodexClient(): Promise<unknown>}, "restartCodexClient")
                .mockReturnValue(restarting);
            const providerSet = setProvider();
            await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));

            const rewinding = rewind("before:turn-2").catch(() => null);
            await settle();
            expect(revertParams).toEqual([]);

            finishRestart(createReplacementCodexAcpClient().codexAcpClient);
            await providerSet;
            await rewinding;
            expect(revertParams).toEqual([]);
        });
    });

    it("runs a prompt that is sent during the rewind after the cut", async () => {
        await connect();
        let finishRevert: () => void = () => {};
        const reverting = new Promise<void>(resolve => { finishRevert = resolve; });
        revert = async params => {
            await reverting;
            cut(params.beforeTurnId);
            return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
        };
        const rewinding = rewind("before:turn-2");
        await vi.waitFor(() => expect(revertParams).toHaveLength(1));

        client.setTurnStart(async () => ({turn: createTurn("inProgress", "turn-after")}));
        const prompt = client.sendPrompt([{type: "text", text: "After"}]);
        await settle();
        expect(client.turnStartParams).toEqual([]);

        finishRevert();
        await expect(rewinding).resolves.toEqual({rewound: true});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        client.emit(turnStarted("turn-after"));
        client.emit(turnFinished("completed", "turn-after"));
        await prompt;
        expect(turns.map(candidate => candidate.id)).toEqual(["turn-1"]);
    });
});

async function runTurn(client: PromptSession, index: number, id: string) {
    client.setTurnStart(async () => ({turn: createTurn("inProgress", id)}));
    const response = client.sendPrompt([{type: "text", text: `Prompt ${index + 1}`}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(index + 1));
    client.emit(turnStarted(id));
    client.emit(agentMessageDelta("Reply", id, `agent-${index + 1}`));
    client.emit(turnFinished("completed", id));
    await client.promptRunFinished(index);
    await response.catch(() => {});
    await settle();
}

describe("_session/rewind, cursor anchors", () => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    it("anchors the next prompt after the entity before the removed message", async () => {
        const turns: Turn[] = [];
        client = await connectSession(1, {
            v1ClientCapabilities: rewindClient as never,
            codexResponses: {
                "thread/start": async () => ({
                    thread: {...createThread(), historyMode: "paginated"},
                    model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
                }),
                "thread/turns/list": async () => ({data: turns, nextCursor: null}),
                "thread/revert": async params => {
                    turns.splice(turns.findIndex(candidate => candidate.id === (params as {beforeTurnId: string}).beforeTurnId));
                    return {thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null};
                },
            },
        });
        for (const [index, id] of ["turn-1", "turn-2", "turn-3"].entries()) {
            turns.push(turn(id, "completed", [userMessageItem(`c${index + 1}`, `Prompt ${index + 1}`)]));
            await runTurn(client, index, id);
        }

        await expect(client.request(REWIND, {sessionId, cursorId: "before:turn-3"})).resolves.toEqual({rewound: true});
        turns.push(turn("turn-3b", "completed", [userMessageItem("c4", "Prompt 3, edited")]));
        await runTurn(client, 3, "turn-3b");

        await expect(dump(wireCursors(client))).toMatchFileSnapshot("data/session-rewind-cursors-live-v1.json");
    });
});

describe("_session/rewind, cursor anchors after a load", () => {
    it("anchors the next prompt after the entity before a replayed message", async () => {
        const turns = (): Turn[] => [
            {...createTurn("completed", "turn-1"), itemsView: "full", items: [userMessageItem("c1", "First"), agentItem]},
            {...createTurn("completed", "turn-2"), itemsView: "full", items: [{...userMessageItem("c2", "Second"), id: "user-2"}, {...agentItem, id: "agent-2"}]},
        ];
        const client = await connectSession(1, {openSession: false, v1ClientCapabilities: rewindClient as never});
        try {
            client.setCodexResponse("thread/resume", async () => ({
                thread: {...createThread(), historyMode: "paginated"},
                model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
                itemsBackwardsCursor: "last",
            }));
            client.setCodexResponse("thread/items/list", async params => {
                const entries = turns().flatMap(replayed => replayed.items.map(item => ({turnId: replayed.id, item, startedAtMs: null, completedAtMs: null})));
                return {data: (params as {sortDirection: string}).sortDirection === "desc" ? entries.slice(-1) : entries, nextCursor: null, backwardsCursor: null};
            });
            client.setCodexResponse("thread/turns/list", async () => ({data: turns(), nextCursor: null}));
            client.setCodexResponse("thread/revert", async () => ({thread: createThread(), turnsBackwardsCursor: null, itemsBackwardsCursor: null}));
            await client.request("session/load", {sessionId, cwd: "/workspace", mcpServers: []});
            await settle();

            await expect(client.request(REWIND, {sessionId, cursorId: "before:turn-2"})).resolves.toEqual({rewound: true});
            client.setTurnStart(async () => ({turn: createTurn("inProgress", "turn-2b")}));
            const prompt = client.sendPrompt([{type: "text", text: "Second, edited"}]);
            await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
            client.emit(turnStarted("turn-2b"));
            client.emit(turnFinished("completed", "turn-2b"));
            await prompt;
            await settle();

            expect(wireCursors(client).at(-1)).toMatchObject({
                cursorId: "before:turn-2b",
                anchor: {type: "agent_message", messageId: "agent-1", position: "after"},
            });
        } finally {
            client.connection.close();
        }
    });
});

describe("_session/rewind, advertisement", () => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    async function airCapabilityList(version: 1 | 2, declared: string[]): Promise<unknown> {
        client = await connectSession(version, {
            openSession: false,
            ...(version === 1
                ? {v1ClientCapabilities: airCapabilities(declared) as never}
                : {clientCapabilities: airCapabilities(declared) as never}),
        });
        const response = await client.request("initialize", version === 1
            ? {protocolVersion: 1, clientCapabilities: airCapabilities(declared)}
            : {protocolVersion: 2, info: {name: "test", version: "1"}, capabilities: airCapabilities(declared)});
        return response._meta?.jetbrains?.air?.capabilities;
    }

    it.each([
        ["v1 declared", 1, ["sessionRewind"], true],
        ["v1 not declared", 1, ["diffPatch"], false],
        ["v2 declared", 2, ["sessionRewind"], false],
    ] as const)("%s", async (_name, version, declared, listed) => {
        const capabilities = await airCapabilityList(version, [...declared]);

        expect(Array.isArray(capabilities) && capabilities.includes("sessionRewind")).toBe(listed);
    });
});

describe("_session/rewind, cursor capabilities", () => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    const replayedTurns = (): Turn[] => [
        {...createTurn("completed", "turn-1"), itemsView: "full", items: [userMessageItem("c1", "First"), agentItem]},
        {...createTurn("completed", "turn-2"), itemsView: "full", items: [{...userMessageItem("c2", "Second"), id: "user-2"}]},
    ];

    it.each([
        ["declared, paginated", rewindClient, "paginated", {fork: {}, rewind: {}}],
        ["declared, legacy history", rewindClient, "legacy", {fork: {}}],
        ["not declared", {session: {cursors: {}}, ...airCapabilities(["diffPatch"])}, "paginated", {fork: {}}],
    ] as const)("a replayed cursor, %s", async (_name, capabilities, historyMode, expected) => {
        client = await connectSession(1, {openSession: false, v1ClientCapabilities: capabilities as never});
        client.setCodexResponse("thread/resume", async () => ({
            thread: {...createThread(), historyMode},
            model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
            itemsBackwardsCursor: "last",
        }));
        client.setCodexResponse("thread/items/list", async params => {
            const entries = replayedTurns().flatMap(replayed => replayed.items.map(item => ({turnId: replayed.id, item, startedAtMs: null, completedAtMs: null})));
            const data = (params as {sortDirection: string}).sortDirection === "desc" ? entries.slice(-1) : entries;
            return {data, nextCursor: null, backwardsCursor: null};
        });
        client.setCodexResponse("thread/read", async () => ({thread: {...createThread(), historyMode, turns: replayedTurns()}}));
        client.setCodexResponse("thread/turns/list", async () => ({data: replayedTurns(), nextCursor: null}));
        await client.request("session/load", {sessionId, cwd: "/workspace", mcpServers: []});
        await settle();

        expect(wireCursors(client).map(cursor => cursor["capabilities"])).toEqual([expected]);
    });
});

describe("_session/rewind, live cursor capabilities", () => {
    let client: PromptSession;
    afterEach(() => client?.connection.close());

    it.each([
        ["legacy history", {historyMode: "legacy"}],
        ["an ephemeral thread", {ephemeral: true}],
    ] as const)("a live cursor has no rewind: %s", async (_name, thread) => {
        client = await connectSession(1, {
            v1ClientCapabilities: rewindClient as never,
            codexResponses: {
                "thread/start": async () => ({
                    thread: {...createThread(), ...thread},
                    model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
                }),
            },
        });
        await runTurn(client, 0, "turn-1");
        await runTurn(client, 1, "turn-2");

        expect(wireCursors(client).map(cursor => cursor["capabilities"])).toEqual([{fork: {}}]);
    });
});
