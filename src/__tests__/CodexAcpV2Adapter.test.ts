import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type * as acpV1 from "@agentclientprotocol/sdk";
import {CodexAcpV2Adapter, mapSessionUpdateNotification} from "../v2/CodexAcpV2Adapter";
import type {CodexAcpServer} from "../CodexAcpServer";

describe("CodexAcpV2Adapter", () => {
    it("maps v1 tool-call creation to a v2 upsert", () => {
        const notification = mapSessionUpdateNotification({
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call",
                toolCallId: "tool-1",
                title: "Read file",
                status: "in_progress",
            },
        });

        expect(notification).toEqual({
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tool-1",
                title: "Read file",
                status: "in_progress",
            },
        });
    });

    it("maps legacy plan and config updates to their v2 shapes", () => {
        expect(mapSessionUpdateNotification({
            sessionId: "session-1",
            update: {
                sessionUpdate: "plan",
                entries: [{content: "Implement", priority: "high", status: "in_progress"}],
            },
        }).update).toEqual({
            sessionUpdate: "plan_update",
            plan: {
                type: "items",
                planId: "default",
                entries: [{content: "Implement", priority: "high", status: "in_progress"}],
            },
        });

        expect(mapSessionUpdateNotification({
            sessionId: "session-1",
            update: {
                sessionUpdate: "config_option_update",
                configOptions: [{
                    id: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "gpt-5",
                    options: [{value: "gpt-5", name: "GPT-5"}],
                }],
            },
        }).update).toMatchObject({
            sessionUpdate: "config_option_update",
            configOptions: [{configId: "model"}],
        });
    });

    it("maps config option ids in new-session responses", async () => {
        const {adapter} = createAdapter({
            newSession: vi.fn().mockResolvedValue({
                sessionId: "session-1",
                configOptions: [{
                    id: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "gpt-5",
                    options: [{value: "gpt-5", name: "GPT-5"}],
                }],
            }),
        });

        await expect(adapter.newSession({cwd: "/tmp"})).resolves.toEqual({
            sessionId: "session-1",
            configOptions: [{
                configId: "model",
                name: "Model",
                type: "select",
                currentValue: "gpt-5",
                options: [{value: "gpt-5", name: "GPT-5"}],
            }],
        });
    });

    it("replays history from the start through the legacy load path", async () => {
        const loadSession = vi.fn().mockResolvedValue({configOptions: []});
        const resumeSession = vi.fn();
        const {adapter} = createAdapter({loadSession, resumeSession});

        await adapter.resumeSession({
            sessionId: "session-1",
            cwd: "/tmp",
            replayFrom: {type: "start"},
        });

        expect(loadSession).toHaveBeenCalledOnce();
        expect(resumeSession).not.toHaveBeenCalled();
    });

    it("acknowledges prompts before completion and reports running then idle", async () => {
        let completePrompt: ((response: acpV1.PromptResponse) => void) | undefined;
        const prompt = vi.fn().mockReturnValue(new Promise<acpV1.PromptResponse>((resolve) => {
            completePrompt = resolve;
        }));
        const {adapter, notify} = createAdapter({prompt});

        await expect(adapter.prompt({
            sessionId: "session-1",
            prompt: [{type: "text", text: "hello"}],
        })).resolves.toEqual({});

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[1]).toMatchObject({
            sessionId: "session-1",
            update: {sessionUpdate: "state_update", state: "running"},
        });

        completePrompt?.({stopReason: "end_turn", usage: {inputTokens: 10, outputTokens: 5, totalTokens: 15}});
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls[1]?.[1]).toMatchObject({
            sessionId: "session-1",
            update: {
                sessionUpdate: "state_update",
                state: "idle",
                stopReason: "end_turn",
            },
        });
    });
});

function createAdapter(overrides: Partial<Record<keyof CodexAcpServer, unknown>>) {
    const notify = vi.fn().mockResolvedValue(undefined);
    const connection = {
        notify,
        request: vi.fn(),
    } as unknown as acp.AgentContext;
    const defaults = {
        initialize: vi.fn().mockResolvedValue({}),
        newSession: vi.fn().mockResolvedValue({}),
        loadSession: vi.fn().mockResolvedValue({}),
        resumeSession: vi.fn().mockResolvedValue({}),
        listSessions: vi.fn().mockResolvedValue({sessions: []}),
        deleteSession: vi.fn().mockResolvedValue({}),
        closeSession: vi.fn().mockResolvedValue({}),
        setSessionConfigOption: vi.fn().mockResolvedValue({configOptions: []}),
        authenticate: vi.fn().mockResolvedValue({}),
        logout: vi.fn().mockResolvedValue({}),
        listProviders: vi.fn().mockReturnValue({providers: []}),
        setProvider: vi.fn().mockResolvedValue({}),
        disableProvider: vi.fn().mockResolvedValue({}),
        prompt: vi.fn().mockResolvedValue({stopReason: "end_turn"}),
        cancel: vi.fn().mockResolvedValue(undefined),
        extMethod: vi.fn().mockResolvedValue({}),
    };
    const agent = Object.assign(defaults, overrides) as unknown as CodexAcpServer;
    return {
        adapter: new CodexAcpV2Adapter(agent, connection),
        notify,
    };
}
