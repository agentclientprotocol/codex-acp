import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createFileChangeUpdate } from '../../CodexToolCallMapper';
import type { ThreadItem } from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from '../acp-test-utils';
import {AgentMode} from "../../AgentMode";

describe('CodexEventHandler - file change events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
    });

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: 'model-id[effort]',
        agentMode: AgentMode.DEFAULT_AGENT_MODE
    });

    it('should handle new file creation', async () => {
        const newFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-1',
                    changes: [
                        {
                            path: '/test/project/NewFile.kt',
                            kind: { type: 'add' },
                            diff: 'package test.project\n\nclass NewFile {\n    fun hello() = "Hello"\n}\n',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [newFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-add-new-file.json'
        );
    });

    it('should handle multiple new files in single change', async () => {
        const multiFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-2',
                    changes: [
                        {
                            path: '/test/project/FileA.kt',
                            kind: { type: 'add' },
                            diff: 'class FileA\n',
                        },
                        {
                            path: '/test/project/FileB.kt',
                            kind: { type: 'add' },
                            diff: 'class FileB\n',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [multiFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-add-multiple-files.json'
        );
    });

    it('should handle new file creation with raw content', async () => {
        // Codex sends raw file content (not unified diff) for new files
        const newFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-raw',
                    changes: [
                        {
                            path: '/test/project/RawFile.kt',
                            kind: { type: 'add' },
                            diff: 'fun main() {\n    println("Hello, World!")\n}\n',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [newFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-add-raw-content.json'
        );
    });

    it('should handle file deletion', async () => {
        const deleteFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-3',
                    changes: [
                        {
                            path: '/test/project/OldFile.kt',
                            kind: { type: 'delete' },
                            diff: 'package test.project\n\nclass OldFile {}',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [deleteFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-delete-file.json'
        );
    });

    it('should handle file deletion with raw content', async () => {
        // Codex sends raw file content (not unified diff) for deleted files
        const deletedFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-delete-raw',
                    changes: [
                        {
                            path: '/test/project/RawDeleteFile.kt',
                            kind: { type: 'delete' },
                            diff: 'fun main() {\n    println("Hello, World!")\n}\n',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [deletedFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-delete-raw-content.json'
        );
    });

    it('should handle file deletion when old file is already missing', async () => {
        const deleteFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-3',
                    changes: [
                        {
                            path: '/test/project/OldFile.kt',
                            kind: { type: 'delete' },
                            diff: 'package test.project\n\nclass OldFile {}',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [deleteFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-delete-file.json'
        );
    });

    it('should handle file deletion with raw content when old file is already missing', async () => {
        const deletedFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-delete-raw',
                    changes: [
                        {
                            path: '/test/project/RawDeleteFile.kt',
                            kind: { type: 'delete' },
                            diff: 'fun main() {\n    println("Hello, World!")\n}\n',
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [deletedFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-delete-raw-content.json'
        );
    });

    it('should preserve metadata when an update diff is invalid', async () => {
        const fileChange: ThreadItem & { type: 'fileChange' } = {
            type: 'fileChange',
            id: 'file-change-broken-diff',
            changes: [
                {
                    path: '/test/project/OldFile.kt',
                    kind: { type: 'update', move_path: null },
                    diff:
`--- /test/project/OldFile.kt
+++ /test/project/OldFile.kt
@@ broken @@
+class UpdatedFile
`,
                },
            ],
            status: 'completed',
        };

        const updateEvent = await createFileChangeUpdate(fileChange);
        expect(updateEvent).toMatchObject({
            content: [],
            locations: [{ path: '/test/project/OldFile.kt' }],
            rawInput: { changes: fileChange.changes },
            rawOutput: {
                status: 'completed',
                success: true,
            },
        });
    });

    it('should emit localized update content when the source file is unavailable', async () => {
        const updateFileNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    type: 'fileChange',
                    id: 'file-change-already-patched',
                    changes: [
                        {
                            path: '/test/project/OldFile.kt',
                            kind: { type: 'update', move_path: null },
                            diff:
`@@ -18,7 +18,7 @@
 modified_section_4: experiment_id=new_xyz456 status=replaced
-random_operation_3: tool_call_count=10 agent_test=true
-random_operation_4: data_point=value_7390
+random_operation_3: tool_call_count=12 agent_test=true
+random_operation_4: data_point=value_8462
 random_operation_5: final_entry timestamp=2026-05-02T11:31:23Z
 updated_entry_4: replaced_lines=22-23 round=2 op=1
-updated_entry_5: metrics=[reads=20,writes=10,duration_ms=99999]
+updated_entry_5: metrics=[reads=23,writes=11,duration_ms=98417]
 round2_operation_3: test_phase=integration_test status=running
`,
                        },
                    ],
                    status: 'completed',
                },
            },
        } satisfies ServerNotification;

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updateFileNotification]);

        const updates = mockFixture.getAcpConnectionEvents(['id']).map((event) => event.args[0].update);
        expect(updates).toMatchObject([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'file-change-already-patched',
                status: 'completed',
                content: [
                    {
                        oldText: [
                            'modified_section_4: experiment_id=new_xyz456 status=replaced',
                            'random_operation_3: tool_call_count=10 agent_test=true',
                            'random_operation_4: data_point=value_7390',
                            'random_operation_5: final_entry timestamp=2026-05-02T11:31:23Z',
                            'updated_entry_4: replaced_lines=22-23 round=2 op=1',
                            'updated_entry_5: metrics=[reads=20,writes=10,duration_ms=99999]',
                            'round2_operation_3: test_phase=integration_test status=running',
                        ].join('\n'),
                        newText: [
                            'modified_section_4: experiment_id=new_xyz456 status=replaced',
                            'random_operation_3: tool_call_count=12 agent_test=true',
                            'random_operation_4: data_point=value_8462',
                            'random_operation_5: final_entry timestamp=2026-05-02T11:31:23Z',
                            'updated_entry_4: replaced_lines=22-23 round=2 op=1',
                            'updated_entry_5: metrics=[reads=23,writes=11,duration_ms=98417]',
                            'round2_operation_3: test_phase=integration_test status=running',
                        ].join('\n'),
                        path: '/test/project/OldFile.kt',
                    },
                ],
                locations: [{ path: '/test/project/OldFile.kt', line: 18 }],
                rawInput: { changes: updateFileNotification.params.item.changes },
                rawOutput: {
                    status: 'completed',
                    success: true,
                },
            },
        ]);
    });

    it('should preserve start-before-completion ordering without file reads', async () => {
        const fileChange = {
            type: 'fileChange',
            id: 'file-change-slow-start',
            changes: [
                {
                    path: '/test/project/OldFile.kt',
                    kind: { type: 'update', move_path: null },
                    diff:
`@@ -1,3 +1,3 @@
 package test.project
 
-class OldFile {}
+class UpdatedFile {}
`,
                },
            ],
        } satisfies Omit<ThreadItem & { type: 'fileChange' }, 'status'>;

        const fileChangeStarted: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                item: {
                    ...fileChange,
                    status: 'inProgress',
                },
            },
        };
        const fileChangeCompleted: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                completedAtMs: 0,
                item: {
                    ...fileChange,
                    status: 'completed',
                },
            },
        };

        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const turn = { id: 'turn-id', items: [], status: 'inProgress' as const, error: null };
        codexAppServerClient.turnStart = vi.fn().mockResolvedValue({ turn });
        codexAppServerClient.awaitTurnCompleted = vi.fn().mockResolvedValue({
            threadId: sessionId,
            turn: { ...turn, status: 'completed' },
        });
        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'test prompt' }],
        });

        mockFixture.clearAcpConnectionDump();
        mockFixture.sendServerNotification(fileChangeStarted);
        mockFixture.sendServerNotification(fileChangeCompleted);

        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionEvents([])).toHaveLength(2);
        });

        const updates = mockFixture.getAcpConnectionEvents([]).map((event) => event.args[0].update);
        expect(updates).toMatchObject([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'file-change-slow-start',
                status: 'in_progress',
                content: [
                    {
                        oldText: 'package test.project\n\nclass OldFile {}',
                        newText: 'package test.project\n\nclass UpdatedFile {}',
                        path: '/test/project/OldFile.kt',
                    },
                ],
            },
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'file-change-slow-start',
                status: 'completed',
                rawOutput: {
                    status: 'completed',
                    success: true,
                },
            },
        ]);
    });

    it('should map file-change patch updates with compact content and metadata', async () => {
        const patchUpdated: ServerNotification = {
            method: 'item/fileChange/patchUpdated',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-patch-updated',
                changes: [
                    {
                        path: '/test/project/UpdatedFile.kt',
                        kind: { type: 'update', move_path: null },
                        diff:
`@@ -40,3 +40,3 @@
 before context
-old value
+new value
 after context
`,
                    },
                ],
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [patchUpdated]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-patch-updated.json'
        );
    });

    it('should parse update diffs with move metadata appended', async () => {
        const fileChange: ThreadItem = {
            type: 'fileChange',
            id: 'file-change-move-metadata',
            changes: [
                {
                    path: '/test/project/OriginalFile.kt',
                    kind: {
                        type: 'update',
                        move_path: '/test/project/NewFile.kt',
                    },
                    diff:
`@@ -1 +1 @@
-old code line
+new code line


Moved to: /test/project/NewFile.kt`,
                },
            ],
            status: 'inProgress',
        };

        const updateEvent = await createFileChangeUpdate(fileChange);
        expect(updateEvent).toMatchObject({
            content: [
                {
                    oldText: 'old code line',
                    newText: 'new code line',
                    path: '/test/project/NewFile.kt',
                },
            ],
        });
    });

    it('should parse update diffs when the original file was moved already', async () => {
        const fileChange: ThreadItem = {
            type: 'fileChange',
            id: 'file-change-moved-file-exists',
            changes: [
                {
                    path: '/test/project/OriginalFile.kt',
                    kind: {
                        type: 'update',
                        move_path: '/test/project/NewFile.kt',
                    },
                    diff:
`@@ -1 +1 @@
-old code line
+new code line


Moved to: /test/project/NewFile.kt`,
                },
            ],
            status: 'inProgress',
        };

        const updateEvent = await createFileChangeUpdate(fileChange);
        expect(updateEvent).toMatchObject({
            content: [
                {
                    oldText: 'old code line',
                    newText: 'new code line',
                    path: '/test/project/NewFile.kt',
                },
            ],
        });
    });
});
