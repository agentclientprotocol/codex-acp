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
    ],
};

function v1Router(models: SubagentModels = MODELS): {router: CodexSubagentEventRouter; sent: SentUpdate[]} {
    const sent: SentUpdate[] = [];
    const connection = {
        notify: vi.fn(async (_method: string, params: unknown) => {
            sent.push(params as SentUpdate);
        }),
        request: vi.fn(),
    } as unknown as AcpClientConnection;
    const session = new ACPSessionConnection(connection, "root");
    return {router: new CodexSubagentEventRouter("root", true, session, () => {}, () => models), sent};
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

function spawn(model: string | null): ServerNotification {
    const item: ThreadItem = {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "root",
        receiverThreadIds: ["child-1"],
        prompt: "Review the diff",
        model,
        reasoningEffort: null,
        agentsStates: {"child-1": {status: "running", message: null}},
    };
    return {method: "item/started", params: {threadId: "root", turnId: "turn-1", startedAtMs: 0, item}};
}

function activity(model: string | null): ServerNotification {
    const item: ThreadItem = {
        type: "subAgentActivity",
        model,
        reasoningEffort: null,
        id: "activity-started",
        kind: "started",
        agentThreadId: "child-1",
        agentPath: "/root/reviewer",
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

describe('the model of a native subagent session', () => {
    afterEach(() => {
        expectConformingV2SessionUpdates();
    });

    it('reports the requested model on the child session right after the announcement', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn("gpt-5.2-codex"));
        await router.handle(activity(null));

        expect(sent.map(({sessionId, update}) => `${sessionId} ${update["sessionUpdate"]}`)).toEqual([
            "root subagent_spawned",
            "child-1 config_option_update",
        ]);
        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-requested.json');
    });

    it('uses the value and the name of the same model in the parent model option', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn("gpt-5.2-codex"));
        await router.handle(activity(null));

        const parentOption = createModelConfigOption([...MODELS.availableModels], MODELS.currentModel!);
        const parentEntry = ((parentOption as {options: Array<{value: string}>}).options)
            .find(option => option.value === "gpt-5.2-codex");
        const childOption = modelOptionOf(sent[1]!.update);
        expect(childOption["currentValue"]).toBe("gpt-5.2-codex");
        expect(childOption["options"]).toEqual([parentEntry]);
    });

    it('reports the model of the parent for a spawn that requests no model', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn(null));
        await router.handle(activity(null));

        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-inherited.json');
    });

    it('prefers the model that Codex resolved for the child, and keeps an unknown model id as it is', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn("gpt-5.2-codex"));
        await router.handle(activity("custom-model"));

        expect(modelOptionOf(sent[1]!.update)).toMatchObject({
            currentValue: "custom-model",
            options: [{value: "custom-model", name: "custom-model", description: null}],
        });
    });

    it('reports the model again on the new session of a reopened child', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn("gpt-5.2-codex"));
        await router.handle(activity(null));
        await router.handle(childTurn("first-turn", "completed"));
        await router.handle(childTurn("followup-turn", "inProgress"));

        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-reopen.json');
    });

    it('reports a new snapshot when the settings of the child thread change its model', async () => {
        const {router, sent} = v1Router();

        await router.handle(spawn(null));
        await router.handle(activity(null));
        const settings = (model: string): ServerNotification => ({
            method: "thread/settings/updated",
            params: {threadId: "child-1", threadSettings: {model} as never},
        });
        await router.handle(settings("gpt-5.5"));
        await router.handle(settings("gpt-5.2-codex"));

        expect(sent.map(({sessionId, update}) => [sessionId, update["sessionUpdate"]])).toEqual([
            ["root", "subagent_spawned"],
            ["child-1", "config_option_update"],
            ["child-1", "config_option_update"],
        ]);
        expect(modelOptionOf(sent[2]!.update)["currentValue"]).toBe("gpt-5.2-codex");
    });

    it('sends no configuration when the model of the child is not known', async () => {
        const {router, sent} = v1Router({currentModel: null, availableModels: []});

        await router.handle(spawn(null));
        await router.handle(activity(null));

        expect(sent.map(({update}) => update["sessionUpdate"])).toEqual(["subagent_spawned"]);
    });

    it('renders the child configuration in the ACP v2 shape', async () => {
        const {router, sent} = v2Router();

        await router.handle(spawn("gpt-5.2-codex"));
        await router.handle(activity(null));

        await expect(JSON.stringify(sent, null, 2)).toMatchFileSnapshot('data/subagent-model-v2.json');
    });
});
