import {beforeEach, describe, expect, it, vi} from "vitest";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    PermissionsRequestApprovalParams,
} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import {AgentMode} from "../../AgentMode";
import {ApprovalOptionId} from "../../ApprovalOptionId";

type CommandParams = CommandExecutionRequestApprovalParams & {
    availableDecisions?: unknown;
};

describe("Approval Events", () => {
    let fixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    function setupSessionWithPendingPrompt() {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        let resolveTurnCompleted!: (value: {
            threadId: string;
            turn: {id: string; items: never[]; status: string; error: null};
        }) => void;
        const turnCompletedPromise = new Promise<{
            threadId: string;
            turn: {id: string; items: never[]; status: string; error: null};
        }>(resolve => {
            resolveTurnCompleted = resolve;
        });
        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: {id: "turn-1", items: [], status: "inProgress", error: null},
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockReturnValue(turnCompletedPromise);
        const sessionState: SessionState = createTestSessionState({
            sessionId,
            currentModelId: "model-id[effort]",
            agentMode: AgentMode.DEFAULT_AGENT_MODE,
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{type: "text", text: "Test prompt"}],
        });
        return {
            sessionState,
            promptPromise,
            completeTurn: () => resolveTurnCompleted({
                threadId: sessionId,
                turn: {id: "turn-1", items: [], status: "completed", error: null},
            }),
        };
    }

    function commandParams(
        availableDecisions: CommandExecutionApprovalDecision[] | unknown,
        overrides: Partial<CommandParams> = {},
    ): CommandParams {
        return {
            threadId: sessionId,
            turnId: "turn-1",
            itemId: "command-item",
            startedAtMs: 0,
            environmentId: "local",
            command: "/bin/zsh -c npm test",
            cwd: "/workspace",
            reason: "Needed to verify the changes.",
            availableDecisions,
            ...overrides,
        };
    }

    function permissionRequest() {
        return fixture.getAcpConnectionEvents([]).find(event => event.method === "requestPermission")?.args[0];
    }

    async function finish(prompt: ReturnType<typeof setupSessionWithPendingPrompt>): Promise<void> {
        prompt.completeTurn();
        await prompt.promptPromise;
    }

    describe("command approvals", () => {
        it("emits an autonomous ACP v1 snapshot and maps explicit reject to decline", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: ApprovalOptionId.RejectOnce}});
            const params = commandParams(["accept", "acceptForSession", "decline", "cancel"], {
                commandActions: [
                    {type: "read", command: "cat src/a.ts", name: "cat", path: "/workspace/src/a.ts"},
                    {type: "search", command: "rg TODO src", query: "TODO", path: "/workspace/src"},
                ],
            });

            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                params,
            );

            expect(response).toEqual({decision: "decline"});
            expect(permissionRequest()).toEqual({
                sessionId,
                toolCall: {
                    toolCallId: "command-item",
                    kind: "execute",
                    status: "pending",
                    title: "Run command with file reads",
                    rawInput: {command: "npm test", cwd: "/workspace"},
                    locations: [{path: "/workspace/src/a.ts"}, {path: "/workspace/src"}],
                },
                options: [
                    {optionId: "allow_once", name: "Allow once", kind: "allow_once"},
                    {
                        optionId: "allow_always",
                        name: "Allow for session",
                        kind: "allow_always",
                        _meta: {permission: {
                            version: 1,
                            description: "Remember this approval until the Codex session ends",
                        }},
                    },
                    {optionId: "reject_once", name: "Reject", kind: "reject_once"},
                ],
                _meta: {permission: {
                    version: 1,
                    title: "Run command?",
                    description: "Needed to verify the changes.",
                }},
            });
            for (const option of permissionRequest().options) {
                if (option._meta?.permission) {
                    expect(option._meta.permission).not.toHaveProperty("changes");
                }
            }
            expect(JSON.stringify(permissionRequest())).not.toContain("exact_command");
            expect(JSON.stringify(permissionRequest())).not.toContain("codex");
            await finish(prompt);
        });

        it("maps ACP cancellation to cancel, not decline", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "cancelled"}});
            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(["accept", "decline", "cancel"]),
            );
            expect(response).toEqual({decision: "cancel"});
            await finish(prompt);
        });

        it("retains and returns the exact proposed exec-policy payload without exposing argv in prose", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: {outcome: "selected", optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment},
            });
            const amendment = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "@'\nsecret\n'@"];
            const decision = {acceptWithExecpolicyAmendment: {execpolicy_amendment: amendment}} as const;
            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(["accept", decision, "decline", "cancel"], {
                    command: amendment.join(" "),
                    proposedExecpolicyAmendment: amendment,
                }),
            );
            expect(response).toEqual({decision});
            const option = permissionRequest().options.find(
                (candidate: {optionId: string}) => candidate.optionId === ApprovalOptionId.AcceptWithExecpolicyAmendment,
            );
            expect(option).toEqual({
                optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment,
                name: "Allow command pattern",
                kind: "allow_always",
                _meta: {permission: {
                    version: 1,
                    description: "Add the proposed command-prefix rule to persistent Codex policy",
                }},
            });
            expect(JSON.stringify(option)).not.toContain("secret");
            await finish(prompt);
        });

        it.each(["http", "https", "socks5Tcp", "socks5Udp"] as const)(
            "keeps %s host/protocol in the tool subject and maps the exact network amendment",
            async protocol => {
                const prompt = setupSessionWithPendingPrompt();
                const amendment = {host: "example.test", action: "allow" as const};
                const decision = {applyNetworkPolicyAmendment: {network_policy_amendment: amendment}} as const;
                fixture.setPermissionResponse({
                    outcome: {outcome: "selected", optionId: `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:0`},
                });
                const response = await fixture.sendServerRequest<{decision: unknown}>(
                    "item/commandExecution/requestApproval",
                    commandParams(["accept", "acceptForSession", decision, "decline", "cancel"], {
                        networkApprovalContext: {host: amendment.host, protocol},
                        proposedNetworkPolicyAmendments: [amendment],
                    }),
                );
                expect(response).toEqual({decision});
                expect(permissionRequest()._meta).toEqual({permission: {
                    version: 1,
                    title: "Allow network access?",
                    description: "Needed to verify the changes.",
                }});
                expect(permissionRequest().toolCall).toMatchObject({
                    title: `${protocol} network access to example.test`,
                    content: [{type: "content", content: {type: "text", text: `${protocol} access to example.test`}}],
                });
                const optionsJson = JSON.stringify(permissionRequest().options);
                expect(optionsJson).not.toContain("example.test");
                expect(optionsJson).not.toContain("exact");
                await finish(prompt);
            },
        );

        it("maps a selected persistent network block to its exact provider decision", async () => {
            const prompt = setupSessionWithPendingPrompt();
            const amendment = {host: "blocked.test", action: "deny" as const};
            const decision = {applyNetworkPolicyAmendment: {network_policy_amendment: amendment}} as const;
            fixture.setPermissionResponse({
                outcome: {outcome: "selected", optionId: `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:0`},
            });
            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(["accept", decision, "decline", "cancel"], {
                    networkApprovalContext: {host: amendment.host, protocol: "https"},
                    proposedNetworkPolicyAmendments: [amendment],
                }),
            );
            expect(response).toEqual({decision});
            expect(permissionRequest().options[1]).toMatchObject({
                name: "Block in future",
                kind: "reject_always",
                _meta: {permission: {description: "Add the proposed block rule to persistent Codex network policy"}},
            });
            await finish(prompt);
        });

        it.each([
            ["missing", undefined],
            ["empty", []],
            ["unknown", ["accept", "futureDecision", "decline"]],
            ["no explicit decline", ["accept", "cancel"]],
            ["mismatched amendment", [
                "accept",
                {acceptWithExecpolicyAmendment: {execpolicy_amendment: ["different"]}},
                "decline",
            ]],
        ])("fails closed for a %s authoritative decision contract", async (_name, availableDecisions) => {
            const prompt = setupSessionWithPendingPrompt();
            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(availableDecisions, {proposedExecpolicyAmendment: ["expected"]}),
            );
            expect(response).toEqual({decision: "cancel"});
            expect(permissionRequest()).toBeUndefined();
            await finish(prompt);
        });

        it("rejects a stale-turn command before opening ACP permission UI", async () => {
            const prompt = setupSessionWithPendingPrompt();
            prompt.sessionState.currentTurnId = "newer-turn";
            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(["accept", "decline", "cancel"]),
            );
            expect(response).toEqual({decision: "cancel"});
            expect(permissionRequest()).toBeUndefined();
            await finish(prompt);
        });

        it("keeps concurrent approvalId callbacks request-local while reusing the item toolCallId", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: ApprovalOptionId.AllowOnce}});
            const decisions: CommandExecutionApprovalDecision[] = ["accept", "decline", "cancel"];
            const first = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(decisions, {approvalId: "approval-a"}),
            );
            const second = await fixture.sendServerRequest<{decision: unknown}>(
                "item/commandExecution/requestApproval",
                commandParams(decisions, {approvalId: "approval-b"}),
            );
            expect(first).toEqual({decision: "accept"});
            expect(second).toEqual({decision: "accept"});
            const requests = fixture.getAcpConnectionEvents([]).filter(event => event.method === "requestPermission");
            expect(requests).toHaveLength(2);
            expect(requests.map(event => event.args[0].toolCall.toolCallId)).toEqual(["command-item", "command-item"]);
            expect(JSON.stringify(requests)).not.toContain("approval-a");
            expect(JSON.stringify(requests)).not.toContain("approval-b");
            await finish(prompt);
        });
    });

    describe("file change approvals", () => {
        function fileParams(overrides: Partial<FileChangeRequestApprovalParams> = {}): FileChangeRequestApprovalParams {
            return {
                threadId: sessionId,
                turnId: "turn-1",
                itemId: "file-item",
                startedAtMs: 0,
                reason: "Apply the generated edits.",
                grantRoot: "/workspace",
                ...overrides,
            };
        }

        it("uses correlated file locations and never claims grantRoot coverage", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.sendServerNotification({
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-1",
                    startedAtMs: 0,
                    item: {
                        type: "fileChange",
                        id: "file-item",
                        status: "inProgress",
                        changes: [
                            {path: "/workspace/a.ts", kind: {type: "update", move_path: null}, diff: "diff-a"},
                            {path: "/workspace/b.ts", kind: {type: "add"}, diff: "diff-b"},
                        ],
                    },
                },
            });
            await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            fixture.clearAcpConnectionDump();
            fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: ApprovalOptionId.AllowAlways}});

            const response = await fixture.sendServerRequest<{decision: unknown}>(
                "item/fileChange/requestApproval",
                fileParams(),
            );

            expect(response).toEqual({decision: "acceptForSession"});
            expect(permissionRequest()).toMatchObject({
                toolCall: {
                    toolCallId: "file-item",
                    kind: "edit",
                    status: "pending",
                    title: "Edit files",
                    locations: [{path: "/workspace/a.ts"}, {path: "/workspace/b.ts"}],
                },
                _meta: {permission: {
                    version: 1,
                    title: "Make edits?",
                    description: "Apply the generated edits.",
                }},
            });
            expect(JSON.stringify(permissionRequest())).not.toContain("grantRoot");
            expect(JSON.stringify(permissionRequest())).not.toContain("writes under");
            await finish(prompt);
        });

        it("distinguishes explicit file rejection from ACP cancellation", async () => {
            const rejectPrompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "selected", optionId: ApprovalOptionId.RejectOnce}});
            expect(await fixture.sendServerRequest("item/fileChange/requestApproval", fileParams()))
                .toEqual({decision: "decline"});
            await finish(rejectPrompt);

            fixture = createCodexMockTestFixture();
            const cancelPrompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "cancelled"}});
            expect(await fixture.sendServerRequest("item/fileChange/requestApproval", fileParams()))
                .toEqual({decision: "cancel"});
            await finish(cancelPrompt);
        });
    });

    describe("additional permission approvals", () => {
        const permissions = {
            network: {enabled: false},
            fileSystem: {
                read: ["/workspace/read"],
                write: ["/workspace/write"],
                globScanMaxDepth: 3,
                entries: [
                    {path: {type: "path" as const, path: "/workspace/exact"}, access: "read" as const},
                    {path: {type: "glob_pattern" as const, pattern: "/workspace/**/*.key"}, access: "deny" as const},
                    {path: {type: "special" as const, value: {kind: "project_roots" as const, subpath: "build"}}, access: "write" as const},
                ],
            },
        };

        function params(): PermissionsRequestApprovalParams {
            return {
                threadId: sessionId,
                turnId: "turn-1",
                itemId: "permissions-item",
                environmentId: "remote-env",
                startedAtMs: 0,
                cwd: "/workspace",
                reason: "The build needs generated output access.",
                permissions,
            };
        }

        it.each([
            [ApprovalOptionId.AllowPermissionsForTurn, "turn", false],
            [ApprovalOptionId.AllowPermissionsForSession, "session", false],
            [ApprovalOptionId.RejectPermissions, "turn", true],
        ] as const)("maps %s atomically", async (optionId, scope, strictAutoReview) => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "selected", optionId}});
            const response = await fixture.sendServerRequest<any>("item/permissions/requestApproval", params());
            expect(response).toEqual(optionId === ApprovalOptionId.RejectPermissions
                ? {permissions: {}, scope, strictAutoReview}
                : {permissions, scope, strictAutoReview});

            if (optionId === ApprovalOptionId.AllowPermissionsForTurn) {
                expect(permissionRequest()).toMatchObject({
                    toolCall: {
                        toolCallId: "permissions-item",
                        kind: "other",
                        status: "pending",
                        title: "Additional sandbox permissions",
                        rawInput: {permissions, cwd: "/workspace", environmentId: "remote-env"},
                        locations: [
                            {path: "/workspace/read"},
                            {path: "/workspace/write"},
                            {path: "/workspace/exact"},
                        ],
                        content: [{type: "content", content: {type: "text", text: [
                            "Disable network access",
                            "deny filesystem pattern /workspace/**/*.key",
                            'write Codex filesystem scope {"kind":"project_roots","subpath":"build"}',
                        ].join("\n")}}],
                    },
                    _meta: {permission: {
                        version: 1,
                        title: "Grant permissions?",
                        description: "The build needs generated output access.",
                    }},
                });
            }
            await finish(prompt);
        });

        it("maps ACP cancellation to an empty strict profile", async () => {
            const prompt = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({outcome: {outcome: "cancelled"}});
            expect(await fixture.sendServerRequest("item/permissions/requestApproval", params())).toEqual({
                permissions: {},
                scope: "turn",
                strictAutoReview: true,
            });
            await finish(prompt);
        });
    });
});
