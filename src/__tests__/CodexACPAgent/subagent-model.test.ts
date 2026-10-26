import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import {ACPSessionConnection, type AcpClientConnection, AcpV2Connection} from '../../ACPSessionConnection';
import {CodexSubagentEventRouter, type SubagentModels} from '../../subagents/CodexSubagentEventRouter';
import {createModelConfigOption} from '../../ModelConfigOption';
import type {ServerNotification} from '../../app-server';
import type {ThreadItem} from '../../app-server/v2';
import {createTestModel} from '../acp-test-utils';
import {checkV2SessionUpdate, expectConformingV2SessionUpdates} from './v2-session-update-guard';

type SentUpdate = {sessionId: string; update: Record<string, unknown>};

const MODELS: SubagentModels = {
    currentModel: "gpt-5.5",
    availableModels: [
        createTestModel({id: "gpt-5.5", displayName: "gpt-5.5"}),
        createTestModel({id: "gpt-5.2-codex", model: "gpt-5.2-codex", displayName: "gpt-5.2-codex", isDefault: false}),
        createTestModel({id: "codex-fast", model: "gpt-5.2-codex-fast", displayName: "gpt-5.2-codex-fast", isDefault: false}),
    ],
};

function v1Router(
    models: SubagentModels | null = MODELS,
    supported = true,
): {router: CodexSubagentEventRouter; sent: SentUpdate[]} {
    const sent: SentUpdate[] = [];
    const connection = {
        notify: vi.fn(async (_method: string, params: unknown) => {
            sent.push(params as SentUpdate);
        }),
        request: vi.fn(),
    } as unknown as AcpClientConnection;
    const session = new ACPSessionConnection(connection, "root");
    return {router: new CodexSubagentEventRouter("root", supported, session, () => {}, () => models), sent};
}

function v2Router(): {router: CodexSubagentEventRouter; sent: SentUpdate[]} {
    const sent: SentUpdate[] = [];
    const v2Client = {
        notify: vi.fn(async (_method: string, params: unknown) => {
            const notification = params as {sessionId: string; update: acpV2.SessionUpdate};
            checkV2SessionUpdate(notification.update);
            sent.push(notification as unknown as SentUpdate);
        }),
        request: vi.fn(),
    };
    const view = new AcpV2Connection(v2Client as any).extensionOnlyV1View();
    const session = new ACPSessionConnection(view, "root");
    return {router: new CodexSubagentEventRouter("root", true, session, () => {}, () => MODELS), sent};
}

function spawn(
    model: string | null,
    child = "child-1",
    sender = "root",
    receivers = [child],
    method: "item/started" | "item/completed" = "item/started",
): ServerNotification {
    const item: ThreadItem = {
        type: "collabAgentToolCall",
        id: `spawn-${child}`,
        tool: "spawnAgent",
        status: method === "item/started" ? "inProgress" : "completed",
        senderThreadId: sender,
        receiverThreadIds: receivers,
        prompt: "Review the diff",
        model,
        reasoningEffort: null,
        agentsStates: Object.fromEntries(receivers.map(id => [id, {status: "running" as const, message: null}])),
    };
    return method === "item/started"
        ? {method, params: {threadId: "root", turnId: "turn-1", startedAtMs: 0, item}}
        : {method, params: {threadId: "root", turnId: "turn-1", completedAtMs: 0, item}};
}

function activity(model: string | null, child = "child-1", path = "/root/reviewer"): ServerNotification {
    const item: ThreadItem = {
        type: "subAgentActivity",
        model,
        reasoningEffort: null,
        id: `activity-${child}`,
        kind: "started",
        agentThreadId: child,
        agentPath: path,
    };
    return {method: "item/started", params: {threadId: "root", turnId: "turn-1", startedAtMs: 0, item}};
}

function childTurn(id: string, status: "completed" | "inProgress"): ServerNotification {
    const turn = {
        id,
        items: [],
        rootTurnId: null,
        itemsView: "notLoaded" as const,
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
    return status === "completed"
        ? {method: "turn/completed", params: {threadId: "child-1", turn}}
        : {method: "turn/started", params: {threadId: "child-1", turn}};
}

function modelOptionOf(update: Record<string, unknown>): Record<string, unknown> {
    return (update["configOptions"] as Array<Record<string, unknown>>)[0]!;
}

/** Handles the notifications in order, with the child updates that the router buffered, as the event handler does. */
async function feed(router: CodexSubagentEventRouter, ...notifications: ServerNotification[]): Promise<void> {
    for (const notification of notifications) {
        await router.handle(notification);
        for (const buffered of router.takeBufferedNotifications()) await router.handle(buffered);
    }
}

function settings(model: string, child = "child-1"): ServerNotification {
    return {method: "thread/settings/updated", params: {threadId: child, threadSettings: {model} as never}};
}

function threadStarted(threadId: string, model: string, parentThreadId: string | null = null): ServerNotification {
    return {method: "thread/started", params: {thread: {id: threadId, model, parentThreadId} as never}};
}

function rootTurnCompleted(): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId: "root",
            turn: {
                id: "root-turn",
                items: [],
                rootTurnId: null,
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        },
    };
}

/** The model updates as `session value "name"`. */
function modelReports(sent: SentUpdate[]): string[] {
    return sent
        .filter(({update}) => update["sessionUpdate"] === "config_option_update")
        .map(({sessionId, update}) => {
            const option = modelOptionOf(update) as {currentValue: string; options: Array<{name: string}>};
            return `${sessionId} ${option.currentValue} "${option.options[0]!.name}"`;
        });
}

describe('the model of a native subagent session', () => {
    afterEach(() => {
        expectConformingV2SessionUpdates();
    });

    it('reports the resolved activity model on the child session right after the announcement', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn("gpt-5.5"), activity("gpt-5.2-codex"));

        expect(sent.map(({sessionId, update}) => `${sessionId} ${update["sessionUpdate"]}`)).toEqual([
            "root subagent_spawned",
            "child-1 config_option_update",
        ]);
        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-activity.json');
    });

    it('uses the value and the name of the same model in the parent model option', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("gpt-5.2-codex"));

        const parentOption = createModelConfigOption([...MODELS.availableModels], MODELS.currentModel!);
        const parentEntry = ((parentOption as {options: Array<{value: string}>}).options)
            .find(option => option.value === "gpt-5.2-codex");
        const childOption = modelOptionOf(sent[1]!.update);
        expect(childOption["currentValue"]).toBe("gpt-5.2-codex");
        expect(childOption["options"]).toEqual([parentEntry]);
    });

    it.each([
        {requested: "gpt-5.2-codex"},
        {requested: null},
    ])('guesses no model from the spawn request or the parent ($requested)', async ({requested}) => {
        const {router, sent} = v1Router();

        await feed(router, spawn(requested), activity(null));

        expect(sent.map(({update}) => update["sessionUpdate"])).toEqual(["subagent_spawned"]);
    });

    it('keeps an unknown model id as it is', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("custom-model"));

        expect(modelOptionOf(sent[1]!.update)).toMatchObject({
            currentValue: "custom-model",
            options: [{value: "custom-model", name: "custom-model", description: null}],
        });
    });

    it('reports the model again on the new session of a reopened child', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            spawn(null),
            activity("gpt-5.2-codex"),
            childTurn("first-turn", "completed"),
            childTurn("followup-turn", "inProgress"),
        );

        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-reopen.json');
    });

    it('reports the thread model on a reopened child that ended before its announcement', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            spawn(null),
            threadStarted("child-1", "gpt-5.2-codex"),
            // The child ends before Codex reports its activity, so it is not announced.
            childTurn("first-turn", "completed"),
            childTurn("followup-turn", "inProgress"),
        );

        expect(modelReports(sent)).toEqual(['child-1:generation:2 gpt-5.2-codex "5.2 Codex"']);
    });

    it('reports a new snapshot when the settings of the child thread change its model', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("gpt-5.5"), settings("gpt-5.5"), settings("gpt-5.2-codex"));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.5 "5.5"', 'child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('reports for a nested child only the model that Codex states for it', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            spawn(null),
            activity("gpt-5.2-codex"),
            spawn(null, "grandchild-1", "child-1"),
            activity(null, "grandchild-1", "/root/reviewer/helper"),
        );

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('sends no configuration to a client that gets no session configuration', async () => {
        const {router, sent} = v1Router(null);

        await feed(
            router,
            spawn("gpt-5.2-codex"),
            threadStarted("child-1", "gpt-5.5"),
            activity("custom-model"),
            settings("gpt-5.2-codex"),
        );

        expect(sent.map(({update}) => update["sessionUpdate"])).toEqual(["subagent_spawned"]);
    });

    it('sends nothing to a client without native subagent sessions', async () => {
        const {router, sent} = v1Router(MODELS, false);

        await feed(router, spawn("gpt-5.2-codex"), activity("gpt-5.2-codex"), threadStarted("child-1", "gpt-5.5"));

        expect(sent).toEqual([]);
    });

    it('takes the model from thread/started when the activity names none', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), threadStarted("child-1", "gpt-5.2-codex"), activity(null));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('keeps the activity model when a later thread/started reports another model', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("gpt-5.2-codex"), threadStarted("child-1", "gpt-5.5"));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('takes a model from thread/started that arrives before the spawn names its child', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            spawn(null, "child-1", "root", []),
            threadStarted("child-1", "gpt-5.2-codex"),
            spawn(null, "child-1", "root", ["child-1"], "item/completed"),
            activity(null),
        );

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('announces a pending child with the model of a settings change, and reports it once', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), settings("gpt-5.2-codex"), activity("gpt-5.5"));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('reports a settings change after the announcement over the activity model', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("gpt-5.2-codex"), settings("gpt-5.5"));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"', 'child-1 gpt-5.5 "5.5"']);
    });

    it('sends no new snapshot when another spelling of the model gives the same option value', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), activity("codex-fast"), threadStarted("child-1", "gpt-5.2-codex-fast"),
            settings("gpt-5.2-codex-fast"));

        expect(modelReports(sent)).toEqual(['child-1 codex-fast "5.2 Codex Fast"']);
    });

    it('keeps the full model id when the parent session has no model option', async () => {
        const {router, sent} = v1Router({currentModel: "gpt-5.5", availableModels: []});

        await feed(router, spawn(null), activity("gpt-5.5"));

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.5 "gpt-5.5"']);
    });

    it('announces the child when the model report fails', async () => {
        const sent: string[] = [];
        const connection = {
            notify: vi.fn(async (_method: string, params: unknown) => {
                const update = (params as SentUpdate).update;
                if (update["sessionUpdate"] === "config_option_update") throw new Error("connection closed");
                sent.push(String(update["sessionUpdate"]));
            }),
            request: vi.fn(),
        } as unknown as AcpClientConnection;
        const router = new CodexSubagentEventRouter(
            "root",
            true,
            new ACPSessionConnection(connection, "root"),
            () => {},
            () => MODELS,
        );

        await feed(router, spawn(null), activity("gpt-5.2-codex"));

        expect(sent).toEqual(["subagent_spawned"]);
        expect(await router.waitForMaterializedSession("child-1")).toBe("child-1");
    });

    it('announces a pending child with the last of two buffered settings changes, and reports it once', async () => {
        const {router, sent} = v1Router();

        await feed(router, spawn(null), settings("gpt-5.2-codex"), settings("codex-fast"), activity("gpt-5.5"));

        expect(modelReports(sent)).toEqual(['child-1 codex-fast "5.2 Codex Fast"']);
    });

    it('keeps no early model of a thread that is not of this root', async () => {
        const {router, sent} = v1Router();

        // No spawn of this root is in flight, and the thread names another parent.
        await feed(
            router,
            threadStarted("child-1", "gpt-5.2-codex", "other-root"),
            spawn(null, "child-1", "root", ["child-1"], "item/completed"),
            activity(null),
        );

        expect(modelReports(sent)).toEqual([]);
    });

    it('takes an early model of a thread that names this root as its parent', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            threadStarted("child-1", "gpt-5.2-codex", "root"),
            spawn(null, "child-1", "root", ["child-1"], "item/completed"),
            activity(null),
        );

        expect(modelReports(sent)).toEqual(['child-1 gpt-5.2-codex "5.2 Codex"']);
    });

    it('drops the early models when the root turn ends', async () => {
        const {router, sent} = v1Router();

        await feed(
            router,
            spawn(null, "child-1", "root", []),
            threadStarted("child-1", "gpt-5.2-codex"),
            rootTurnCompleted(),
            spawn(null, "child-1", "root", ["child-1"], "item/completed"),
            activity(null),
        );

        expect(modelReports(sent)).toEqual([]);
    });

    it.each([
        {announcement: "first"},
        {announcement: "reopen"},
    ])('sends no model to a child that ends while the router announces it ($announcement)', async ({announcement}) => {
        const sent: string[] = [];
        let spawned = 0;
        let router: CodexSubagentEventRouter | undefined;
        const endOn = announcement === "first" ? 1 : 2;
        const connection = {
            notify: vi.fn(async (_method: string, params: unknown) => {
                const update = (params as SentUpdate).update;
                sent.push(String(update["sessionUpdate"]));
                // A prompt wait timeout can end the children in this gap.
                if (update["sessionUpdate"] === "subagent_spawned" && ++spawned === endOn) {
                    await router!.finishOutstanding("failed");
                }
            }),
            request: vi.fn(),
        } as unknown as AcpClientConnection;
        router = new CodexSubagentEventRouter(
            "root",
            true,
            new ACPSessionConnection(connection, "root"),
            () => {},
            () => MODELS,
        );

        await feed(router, spawn(null), activity("gpt-5.2-codex"));
        if (announcement === "reopen") {
            sent.length = 0;
            await feed(router, childTurn("first-turn", "completed"), childTurn("followup-turn", "inProgress"));
        }

        expect(sent).not.toContain("config_option_update");
    });

    it('renders the child configuration in the ACP v2 shape', async () => {
        const {router, sent} = v2Router();

        await feed(router, spawn(null), activity("gpt-5.2-codex"));

        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-v2.json');
    });
});
