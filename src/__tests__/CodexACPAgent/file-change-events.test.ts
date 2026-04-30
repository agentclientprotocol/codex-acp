import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from '../acp-test-utils';
import {AgentMode} from "../../AgentMode";

const { mockFiles, mockFileContent, removeMockFile, clearMockFiles } = vi.hoisted(() => {
    const files = new Map<string, string>();
    return {
        mockFiles: files,
        mockFileContent: (path: string, content: string) => files.set(path, content),
        removeMockFile: (path: string) => files.delete(path),
        clearMockFiles: () => files.clear(),
    };
});

vi.mock('node:fs/promises', () => ({
    readFile: (path: string) => {
        const content = mockFiles.get(path);
        if (content !== undefined) {
            return Promise.resolve(content);
        }
        return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    },
}));

describe('CodexEventHandler - file change events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        clearMockFiles();
        mockFileContent('/test/project/OldFile.kt', 'package test.project\n\nclass OldFile {}');
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
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-1',
                    changes: [
                        {
                            path: '/test/project/NewFile.kt',
                            kind: { type: 'add' },
                            diff: `--- /dev/null
+++ /test/project/NewFile.kt
@@ -0,0 +1,5 @@
+package test.project
+
+class NewFile {
+    fun hello() = "Hello"
+}`,
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
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-2',
                    changes: [
                        {
                            path: '/test/project/FileA.kt',
                            kind: { type: 'add' },
                            diff: `--- /dev/null
+++ /test/project/FileA.kt
@@ -0,0 +1 @@
+class FileA`,
                        },
                        {
                            path: '/test/project/FileB.kt',
                            kind: { type: 'add' },
                            diff: `--- /dev/null
+++ /test/project/FileB.kt
@@ -0,0 +1 @@
+class FileB`,
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
                threadId: 'thread-1',
                turnId: 'turn-1',
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
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-3',
                    changes: [
                        {
                            path: '/test/project/OldFile.kt',
                            kind: { type: 'delete' },
                            diff: `--- /test/project/OldFile.kt
+++ /dev/null
@@ -1,3 +0,0 @@
-package test.project
-
-class OldFile {}`,
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
        mockFileContent('/test/project/RawDeleteFile.kt', 'fun main() {\n    println("Hello, World!")\n}\n');

        // Codex sends raw file content (not unified diff) for deleted files
        const deletedFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
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
        removeMockFile('/test/project/OldFile.kt');

        const deleteFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-3',
                    changes: [
                        {
                            path: '/test/project/OldFile.kt',
                            kind: { type: 'delete' },
                            diff: `--- /test/project/OldFile.kt
+++ /dev/null
@@ -1,3 +0,0 @@
-package test.project
-
-class OldFile {}`,
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
        removeMockFile('/test/project/RawDeleteFile.kt');

        const deletedFileNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
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

    it('should handle file change patch updates', async () => {
        mockFileContent('/test/project/Existing.kt', 'class Existing {\n    fun value() = 1\n}\n');

        const change = {
            path: '/test/project/Existing.kt',
            kind: { type: 'update' as const, move_path: null },
            diff: `--- /test/project/Existing.kt
+++ /test/project/Existing.kt
@@ -1,3 +1,3 @@
 class Existing {
-    fun value() = 1
+    fun value() = 2
 }`,
        };

        const startedNotification: ServerNotification = {
            method: 'item/started',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-patch-update',
                    changes: [],
                    status: 'inProgress',
                },
            },
        };

        const patchUpdatedNotification: ServerNotification = {
            method: 'item/fileChange/patchUpdated',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'file-change-patch-update',
                changes: [change],
            },
        };

        const completedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-patch-update',
                    changes: [change],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [
            startedNotification,
            patchUpdatedNotification,
            completedNotification,
        ]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-patch-updated.json'
        );
    });

    it('should handle completed file changes after the file is already updated', async () => {
        mockFileContent('/test/project/Existing.kt', 'class Existing {\n    fun value() = 2\n}\n');

        const completedNotification: ServerNotification = {
            method: 'item/completed',
            params: {
                threadId: sessionId,
                turnId: 'turn-1',
                item: {
                    type: 'fileChange',
                    id: 'file-change-completed-after-apply',
                    changes: [
                        {
                            path: '/test/project/Existing.kt',
                            kind: { type: 'update', move_path: null },
                            diff: `--- /test/project/Existing.kt
+++ /test/project/Existing.kt
@@ -1,3 +1,3 @@
 class Existing {
-    fun value() = 1
+    fun value() = 2
 }`,
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [completedNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-completed-after-apply.json'
        );
    });
});
