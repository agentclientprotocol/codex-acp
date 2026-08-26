import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type * as acpV1 from "@agentclientprotocol/sdk";
import {
    CodexAcpV2Adapter,
    V2SessionUpdateMapper,
} from "../v2/CodexAcpV2Adapter";
import type {CodexAcpServer} from "../CodexAcpServer";

describe("CodexAcpV2Adapter", () => {
    it("maps v1 tool-call creation to a v2 upsert", () => {
        const notification = new V2SessionUpdateMapper().map({
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
        const mapper = new V2SessionUpdateMapper();
        expect(mapper.map({
            sessionId: "session-1",
            update: {
                sessionUpdate: "plan",
                entries: [{content: "Implement", priority: "high", status: "in_progress"}],
            },
        })!.update).toEqual({
            sessionUpdate: "plan_update",
            plan: {
                type: "items",
                planId: "default",
                entries: [{content: "Implement", priority: "high", status: "in_progress"}],
            },
        });

        expect(mapper.map({
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
        })!.update).toMatchObject({
            sessionUpdate: "config_option_update",
            configOptions: [{configId: "model"}],
        });
    });

    it("maps legacy command inputs and file diffs to v2 shapes", () => {
        const mapper = new V2SessionUpdateMapper();
        expect(mapper.map({
            sessionId: "session-1",
            update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [{
                    name: "review",
                    description: "Review changes",
                    input: {hint: "optional instructions"},
                }],
            },
        })!.update).toEqual({
            sessionUpdate: "available_commands_update",
            availableCommands: [{
                name: "review",
                description: "Review changes",
                input: {type: "text", hint: "optional instructions"},
            }],
        });

        expect(mapper.map({
            sessionId: "session-1",
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "edit-1",
                content: [{
                    type: "diff",
                    path: "/tmp/example.txt",
                    oldText: "before\n",
                    newText: "after\n",
                }],
            },
        })!.update).toMatchObject({
            sessionUpdate: "tool_call_update",
            content: [{
                type: "diff",
                changes: [{operation: "modify", path: "/tmp/example.txt"}],
                patch: {format: "git_patch"},
            }],
        });
    });

    it("assigns stable v2 message ids to legacy chunks that omit them", () => {
        const mapper = new V2SessionUpdateMapper();
        const first = mapper.map({
            sessionId: "session-1",
            update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "hel"}},
        });
        const second = mapper.map({
            sessionId: "session-1",
            update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "lo"}},
        });
        const thought = mapper.map({
            sessionId: "session-1",
            update: {sessionUpdate: "agent_thought_chunk", content: {type: "text", text: "thinking"}},
        });

        expect(first!.update).toMatchObject({messageId: "v2-legacy-message-1"});
        expect(second!.update).toMatchObject({messageId: "v2-legacy-message-1"});
        expect(thought!.update).toMatchObject({messageId: "v2-legacy-message-2"});

        mapper.resetSession("session-1");
        const nextTurn = mapper.map({
            sessionId: "session-1",
            update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "next"}},
        });
        expect(nextTurn!.update).toMatchObject({messageId: "v2-legacy-message-3"});
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

    it("forks a session through the legacy agent and maps config ids", async () => {
        const forkSession = vi.fn().mockResolvedValue({
            sessionId: "session-2",
            configOptions: [{
                id: "model",
                name: "Model",
                type: "select",
                currentValue: "gpt-5",
                options: [{value: "gpt-5", name: "GPT-5"}],
            }],
        });
        const {adapter} = createAdapter({forkSession});

        await expect(adapter.forkSession({sessionId: "session-1", cwd: "/tmp"})).resolves.toEqual({
            sessionId: "session-2",
            configOptions: [{
                configId: "model",
                name: "Model",
                type: "select",
                currentValue: "gpt-5",
                options: [{value: "gpt-5", name: "GPT-5"}],
            }],
        });
        expect(forkSession).toHaveBeenCalledWith({sessionId: "session-1", cwd: "/tmp"});
    });

    it("declares the session fork capability when the legacy agent has one", async () => {
        const {adapter} = createAdapter({
            initialize: vi.fn().mockResolvedValue({
                agentInfo: {name: "codex-acp", version: "test"},
                agentCapabilities: {sessionCapabilities: {fork: {}}},
            }),
        });

        const response = await adapter.initialize({
            protocolVersion: 2,
            info: {name: "test-client", version: "test"},
            capabilities: {},
        });
        expect(response.capabilities?.session?.fork).toEqual({});
    });

    it("drops the legacy current_mode_update dialect (modes travel via config_option_update)", () => {
        expect(new V2SessionUpdateMapper().map({
            sessionId: "session-1",
            update: {
                sessionUpdate: "current_mode_update",
                currentModeId: "code",
            },
        })).toBeNull();
    });

    it("maps auth method and grouped config identifiers to v2", async () => {
        const {adapter} = createAdapter({
            initialize: vi.fn().mockResolvedValue({
                agentInfo: {name: "codex-acp", version: "test"},
                agentCapabilities: {},
                authMethods: [{id: "chat-gpt", name: "ChatGPT"}],
            }),
            newSession: vi.fn().mockResolvedValue({
                sessionId: "session-1",
                configOptions: [{
                    id: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "gpt-5",
                    options: [{
                        group: "recommended",
                        name: "Recommended",
                        options: [{value: "gpt-5", name: "GPT-5"}],
                    }],
                }],
            }),
        });

        await expect(adapter.initialize({
            protocolVersion: 2,
            info: {name: "test-client", version: "test"},
            capabilities: {},
        })).resolves.toMatchObject({
            authMethods: [{type: "agent", methodId: "chat-gpt", name: "ChatGPT"}],
        });
        await expect(adapter.newSession({cwd: "/tmp"})).resolves.toMatchObject({
            configOptions: [{
                configId: "model",
                options: [{groupId: "recommended"}],
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

    it("reports prompt failures as requiring action", async () => {
        const {adapter, notify} = createAdapter({
            prompt: vi.fn().mockRejectedValue(new Error("provider unavailable")),
        });

        await adapter.prompt({
            sessionId: "session-1",
            prompt: [{type: "text", text: "hello"}],
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(notify.mock.calls[1]?.[1]).toMatchObject({
            sessionId: "session-1",
            update: {
                sessionUpdate: "state_update",
                state: "requires_action",
                _meta: {codex: {error: "provider unavailable"}},
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
        forkSession: vi.fn().mockResolvedValue({}),
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
        adapter: new CodexAcpV2Adapter(agent, connection, new V2SessionUpdateMapper()),
        notify,
    };
}
