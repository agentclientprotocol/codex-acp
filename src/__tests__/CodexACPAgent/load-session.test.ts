import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexMockTestFixture, createTestModel } from "../acp-test-utils";
import type { Model, Thread, ThreadGoal } from "../../app-server/v2";

describe("CodexACPAgent - loadSession", () => {
    it("replays native child history and disconnects an orphan", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.authRequired = vi.fn().mockResolvedValue(false);
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const makeThread = (id: string, items: Thread["turns"][number]["items"]): Thread => ({
            id,
            sessionId: id,
            parentThreadId: id === "root-history" ? null : "root-history",
            threadSource: null,
            forkedFromId: null,
            preview: id,
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 2,
            recencyAt: null,
            status: {type: "idle"},
            path: null,
            cwd: "/workspace",
            cliVersion: "0",
            section: null,
            sectionEnteredAt: null,
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [{
                id: `turn-${id}`,
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
                items,
            }],
        });
        const root = makeThread("root-history", [
            {
                type: "subAgentActivity",
                id: "activity-child-1",
                kind: "started",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-1-terminal",
                kind: "interrupted",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-2",
                kind: "started",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-2-terminal",
                kind: "interrupted",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-orphan",
                kind: "started",
                agentThreadId: "orphan-history",
                agentPath: "/root/orphan_child",
            },
        ]);
        const child = makeThread("child-history", [{
            type: "agentMessage",
            id: "child-history-message-1",
            text: "Persisted first-generation output",
            phase: null,
            memoryCitation: null,
        }]);
        const firstChildTurn = child.turns[0]!;
        child.turns.push({
            id: "turn-child-history-2",
            itemsView: firstChildTurn.itemsView,
            status: firstChildTurn.status,
            error: firstChildTurn.error,
            startedAt: firstChildTurn.startedAt,
            completedAt: firstChildTurn.completedAt,
            durationMs: firstChildTurn.durationMs,
            items: [{
                type: "agentMessage",
                id: "child-history-message-2",
                text: "Persisted second-generation output",
                phase: null,
                memoryCitation: null,
            }],
        });
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root,
            model: model.id,
            modelProvider: "openai",
            cwd: "/workspace",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) => {
            if (threadId === "orphan-history") return Promise.reject(new Error("missing child history"));
            return Promise.resolve({thread: threadId === root.id ? root : child});
        });

        await agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions"]}}},
            },
        });
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        const firstSpawnIndex = updates.findIndex(({update}) => update.subagentSessionId === "child-history"
            && update.sessionUpdate === "subagent_spawned");
        const firstOutputIndex = updates.findIndex(({update}) => update.messageId === "child-history-message-1");
        const secondSpawnIndex = updates.findIndex(({update}) => update.subagentSessionId === "child-history:generation:2"
            && update.sessionUpdate === "subagent_spawned");
        const secondOutputIndex = updates.findIndex(({update}) => update.messageId === "child-history-message-2");
        const orphanTerminalIndex = updates.findIndex(({update}) => update.subagentSessionId === "orphan-history"
            && update.state === "disconnected");
        expect(firstOutputIndex).toBeGreaterThan(firstSpawnIndex);
        expect(secondSpawnIndex).toBeGreaterThan(firstOutputIndex);
        expect(secondOutputIndex).toBeGreaterThan(secondSpawnIndex);
        expect(orphanTerminalIndex).toBeGreaterThan(secondOutputIndex);
        expect(updates[firstOutputIndex]?.sessionId).toBe("child-history");
        expect(updates[secondOutputIndex]?.sessionId).toBe("child-history:generation:2");
    });

    it("should replay history during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "Hi",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 123,
            updatedAt: 124,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: "Saved title",
            turns: [
                {
                    id: "turn-1",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            clientId: null,
                            content: [
                                { type: "text", text: "Hi", text_elements: [] },
                                { type: "image", url: "https://example.com/image.png" },
                            ],
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-1",
                            text: "Hello!",
                            phase: null,
                            memoryCitation: null,
                        },
                        {
                            type: "reasoning",
                            id: "item-reason-1",
                            summary: ["Thinking..."],
                            content: [],
                        },
                        {
                            type: "commandExecution",
                            id: "item-cmd-1",
                            pluginId: null,
                            scriptPath: null,
                            command: "ls",
                            cwd: "/test/project",
                            processId: null,
                            source: "agent",
                            status: "completed",
                            commandActions: [],
                            aggregatedOutput: "Added.txt\nREADME.md\n",
                            exitCode: 0,
                            durationMs: 5,
                        },
                        {
                            type: "fileChange",
                            id: "item-file-1",
                            changes: [
                                {
                                    path: "/test/project/Added.txt",
                                    kind: { type: "add" },
                                    diff: "Hello\nWorld\n",
                                }
                            ],
                            status: "completed",
                        },
                        {
                            type: "mcpToolCall",
                            id: "item-mcp-1",
                            server: "github",
                            tool: "search",
                            status: "completed",
                            arguments: {},
                            appContext: null,
                            readOnlyHint: null,
                            pluginId: null,
                            result: null,
                            error: null,
                            durationMs: null,
                        },
                        {
                            type: "dynamicToolCall",
                            id: "item-dyn-1",
                            namespace: null,
                            tool: "list_apps",
                            arguments: { includeDisabled: false },
                            status: "completed",
                            contentItems: [{ type: "inputText", text: "Done" }],
                            success: true,
                            durationMs: 3,
                        },
                        {
                            type: "imageView",
                            id: "item-image-view-1",
                            path: "/test/project/input.png",
                        },
                        {
                            type: "imageGeneration",
                            id: "item-image-generation-1",
                            status: "completed",
                            revisedPrompt: "A tiny blue square",
                            result: "iVBORw0KGgo=",
                            failure: null,
                            savedPath: "/test/project/generated-blue-square.png",
                        },
                        {
                            type: "contextCompaction",
                            id: "item-context-compaction-1",
                        },
                        {
                            type: "subAgentActivity",
                            id: "item-subagent-1",
                            kind: "started",
                            agentThreadId: "thread-child-1",
                            agentPath: "/root/test_audit",
                        },
                    ],
                },
            ],
        };
        const resumeThread: Thread = {
            ...thread,
            turns: thread.turns.map((turn) => ({
                ...turn,
                itemsView: "summary",
                items: turn.items.filter((item) => item.type === "userMessage" || item.type === "agentMessage"),
            })),
        };

        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: resumeThread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({
            thread: thread,
        });
        const goal: ThreadGoal = {
            threadId: thread.id,
            objective: "Keep the restored migration green",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 46,
            createdAt: 1710000000,
            updatedAt: 1710000046,
        };
        codexAppServerClient.threadGoalGet = vi.fn().mockResolvedValue({ goal });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadParams: acp.LoadSessionRequest = {
            sessionId: thread.id,
            cwd: "/test/project",
            mcpServers: [],
        };
        const response = await codexAcpAgent.loadSession(loadParams);

        expect(response.sessionId).toBe(thread.id);
        expect(codexAppServerClient.threadRead).toHaveBeenCalledWith({
            threadId: thread.id,
            includeTurns: true,
        });
        expect(codexAppServerClient.threadGoalGet).toHaveBeenCalledWith({ threadId: thread.id });
        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/load-session-history.json"
        );
    });

    it("should not recover session mcp servers during loadSession when request omits them", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({
            thread: thread,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });
        await codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [],
        });

        expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual([]);
    });

    it("should recover response item function calls when app-server history omits tool items", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const tempDir = await mkdtemp(join(tmpdir(), "codex-acp-rollout-history-"));

        try {
            const rolloutPath = join(tempDir, "rollout.jsonl");
            const rolloutRecords = [
                {
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "# AGENTS.md\n\nHidden bootstrap context" }],
                    },
                },
                {
                    type: "event_msg",
                    payload: {
                        type: "user_message",
                        message: "List the files",
                        images: [],
                        local_images: [],
                        text_elements: [],
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "List the files" }],
                    },
                },
                {
                    type: "event_msg",
                    payload: {
                        type: "agent_reasoning",
                        text: "Need to inspect the directory.",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "reasoning",
                        summary: [],
                        content: [],
                        encrypted_content: null,
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call",
                        name: "exec_command",
                        arguments: JSON.stringify({
                            cmd: "rg \"Service\" src | head -n 20",
                            workdir: "/test/project",
                            yield_time_ms: 1000,
                        }),
                        call_id: "call-rg",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call_output",
                        call_id: "call-rg",
                        output: "Chunk ID: search123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\nsrc/service.ts:export class Service {}\n",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call",
                        name: "exec_command",
                        arguments: JSON.stringify({
                            cmd: "rg \"Missing\" src",
                            workdir: "/test/project",
                            yield_time_ms: 1000,
                        }),
                        call_id: "call-rg-failed",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call_output",
                        call_id: "call-rg-failed",
                        output: "Chunk ID: search456\nWall time: 0.0000 seconds\nProcess exited with code 1\nOutput:\n",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call",
                        name: "exec_command",
                        arguments: JSON.stringify({
                            cmd: "nl -ba src/index.ts | sed -n '1,40p'",
                            workdir: "/test/project",
                            yield_time_ms: 1000,
                        }),
                        call_id: "call-read",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call_output",
                        call_id: "call-read",
                        output: "Chunk ID: read123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n     1\tconsole.log('hi');\n",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call",
                        name: "exec_command",
                        arguments: JSON.stringify({
                            cmd: "ls",
                            workdir: "/test/project",
                            yield_time_ms: 1000,
                        }),
                        call_id: "call-ls",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call_output",
                        call_id: "call-ls",
                        output: "Chunk ID: abc123\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\nREADME.md\nsrc\n",
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "The directory contains README.md and src." }],
                        phase: "final_answer",
                    },
                },
            ];
            await writeFile(
                rolloutPath,
                `${rolloutRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
                "utf8",
            );

            codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
            codexAcpClient.getAccount = vi.fn().mockResolvedValue({
                account: null,
                requiresOpenaiAuth: false,
            });
            codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

            const model = createTestModel({ id: "gpt-5.2", displayName: "GPT-5.2" });
            codexAppServerClient.listModels = vi.fn().mockResolvedValue({
                data: [model],
                nextCursor: null,
            });

            const thread: Thread = {
                id: "session-legacy",
                sessionId: "session-legacy",
                parentThreadId: null,
                threadSource: null,
                forkedFromId: null,
                preview: "List the files",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 123,
                updatedAt: 124,
                recencyAt: null,
                status: { type: "idle" },
                path: rolloutPath,
                cwd: "/test/project",
                cliVersion: "0.139.0",
                section: null,
                sectionEnteredAt: null,
                source: "vscode",
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [
                    {
                        id: "turn-1",
                        itemsView: "full",
                        status: "completed",
                        error: null,
                        startedAt: null,
                        completedAt: null,
                        durationMs: null,
                        items: [
                            {
                                type: "userMessage",
                                id: "item-user-1",
                                clientId: null,
                                content: [{ type: "text", text: "List the files", text_elements: [] }],
                            },
                            {
                                type: "reasoning",
                                id: "item-reasoning-1",
                                summary: ["Need to inspect the directory."],
                                content: [],
                            },
                            {
                                type: "plan",
                                id: "item-plan-1",
                                text: "Inspect project files",
                            },
                            {
                                type: "agentMessage",
                                id: "item-agent-1",
                                text: "The directory contains README.md and src.",
                                phase: null,
                                memoryCitation: null,
                            },
                        ],
                    },
                ],
            };

            codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
                thread,
                model: model.id,
                modelProvider: "openai",
                cwd: "/test/project",
                approvalPolicy: "never",
                sandbox: { type: "dangerFullAccess" },
                reasoningEffort: model.defaultReasoningEffort,
            });
            codexAppServerClient.threadRead = vi.fn().mockResolvedValue({
                thread,
            });

            await codexAcpAgent.initialize({
                protocolVersion: 1,
                clientCapabilities: {
                    _meta: {
                        terminal_output: true,
                    },
                },
            });
            await codexAcpAgent.loadSession({
                sessionId: thread.id,
                cwd: "/test/project",
                mcpServers: [],
            });

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                "data/load-session-response-item-history-fallback.json",
            );
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("publishes MCP startup failure for explicitly requested servers during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.authRequired = vi.fn().mockResolvedValue(false);
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({
            thread: thread,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadPromise = codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [{
                name: "broken-mcp",
                command: "npx",
                args: ["broken"],
                env: [],
            }],
        });

        await vi.waitFor(() => {
            expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual(["broken-mcp"]);
        });

        fixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "session-1", name: "broken-mcp", status: "failed", error: "boom" }
        });

        await loadPromise;

        await vi.waitFor(() => {
            const dump = fixture.getAcpConnectionDump([]);
            expect(dump).toContain('"toolCallId": "mcp_startup.broken-mcp"');
            expect(dump).toContain('MCP server `broken-mcp` failed to start: boom');
        });
    });
});
