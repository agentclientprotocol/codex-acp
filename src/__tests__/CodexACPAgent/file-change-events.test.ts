import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, type CodexMockTestFixture } from '../acp-test-utils';

describe('CodexEventHandler - file change events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    const sessionState: SessionState = {
        pendingPrompt: null,
        sessionMetadata: {
            sessionId,
            currentModelId: 'model-id',
            models: [],
        },
    };

    async function setupAndSendNotifications(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue(undefined);
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue(undefined);

        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

        await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'test prompt' }],
        });

        mockFixture.clearAcpConnectionDump();

        for (const notification of notifications) {
            mockFixture.sendServerNotification(notification);
        }

        await vi.waitFor(() => {
            const dump = mockFixture.getAcpConnectionDump([]);
            expect(dump.length).toBeGreaterThan(0);
        });
    }

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

        await setupAndSendNotifications([newFileNotification]);

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

        await setupAndSendNotifications([multiFileNotification]);

        await expect(mockFixture.getAcpConnectionDump(['id'])).toMatchFileSnapshot(
            'data/file-change-add-multiple-files.json'
        );
    });
});
