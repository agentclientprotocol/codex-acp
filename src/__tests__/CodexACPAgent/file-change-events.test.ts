import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../CodexAcpServer';
import type { ServerNotification } from '../../app-server';
import { createFileChangeUpdate } from '../../CodexToolCallMapper';
import type { ThreadItem } from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, setupPromptAndSendNotifications, type CodexMockTestFixture } from '../acp-test-utils';
import {AgentMode} from "../../AgentMode";

const { mockFiles, mockReadDelays, mockFileContent, delayMockFileRead, removeMockFile, clearMockFiles } = vi.hoisted(() => {
    const files = new Map<string, string>();
    const readDelays = new Map<string, Promise<void>>();
    return {
        mockFiles: files,
        mockReadDelays: readDelays,
        mockFileContent: (path: string, content: string) => files.set(path, content),
        delayMockFileRead: (path: string, delay: Promise<void>) => readDelays.set(path, delay),
        removeMockFile: (path: string) => files.delete(path),
        clearMockFiles: () => {
            files.clear();
            readDelays.clear();
        },
    };
});

vi.mock('node:fs/promises', () => ({
    readFile: async (path: string) => {
        const delay = mockReadDelays.get(path);
        if (delay) {
            await delay;
        }
        const content = mockFiles.get(path);
        if (content !== undefined) {
            return content;
        }
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
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
        mockFileContent('/test/project/RawDeleteFile.kt', 'fun main() {\n    println("Hello, World!")\n}\n');

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
        removeMockFile('/test/project/OldFile.kt');

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
        removeMockFile('/test/project/RawDeleteFile.kt');

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

    it.each([
        { name: 'before application', disk: 'old\n' },
        { name: 'after application', disk: 'new\nextra\n' },
        { name: 'a relocated hunk', disk: 'prefix\nold\n' },
    ])('publishes legacy update text $name', async ({ disk }) => {
        mockFileContent('/test/project/OldFile.kt', disk);
        const event = await createFileChangeUpdate({
            type: 'fileChange',
            id: 'stats-update',
            changes: [{
                path: '/test/project/OldFile.kt',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra\n',
            }],
            status: 'completed',
        });
        expect(event.sessionUpdate).toBe('tool_call');
        if (event.sessionUpdate !== 'tool_call') throw new Error('Expected a file-change tool call');
        expect(event.content).toHaveLength(1);
        expect(event.content![0]!._meta).toEqual({ kind: 'update' });
    });

    it('should ignore broken unified diffs in update file changes', async () => {
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
        });
    });

    it('should handle update diffs when the file was already patched', async () => {
        mockFileContent('/test/project/OldFile.kt', 'package test.project\n\nclass UpdatedFile {}\n');

        const updateFileNotification: ServerNotification = {
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
`@@ -1,3 +1,3 @@
 package test.project
 
-class OldFile {}
+class UpdatedFile {}
`,
                        },
                    ],
                    status: 'completed',
                },
            },
        };

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, [updateFileNotification]);

        const updates = mockFixture.getAcpConnectionEvents(['id']).map((event) => event.args[0].update);
        expect(updates).toMatchObject([
            {
                sessionUpdate: 'tool_call',
                toolCallId: 'file-change-already-patched',
                status: 'completed',
                content: [
                    {
                        oldText: 'package test.project\n\nclass OldFile {}\n',
                        newText: 'package test.project\n\nclass UpdatedFile {}\n',
                        path: '/test/project/OldFile.kt',
                    },
                ],
            },
        ]);
    });

    it('should not emit completion before a slow file-change start event', async () => {
        mockFileContent('/test/project/OldFile.kt', 'package test.project\n\nclass OldFile {}\n');

        let releaseRead = () => {};
        const blockedRead = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        delayMockFileRead('/test/project/OldFile.kt', blockedRead);

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

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockFixture.getAcpConnectionEvents([])).toEqual([]);

        releaseRead();
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
                        oldText: 'package test.project\n\nclass OldFile {}\n',
                        newText: 'package test.project\n\nclass UpdatedFile {}\n',
                        path: '/test/project/OldFile.kt',
                    },
                ],
            },
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'file-change-slow-start',
                status: 'completed',
            },
        ]);
    });

    it('should parse update diffs with move metadata appended', async () => {
        mockFileContent('/test/project/OriginalFile.kt', 'old code line\n');

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
                    oldText: 'old code line\n',
                    newText: 'new code line\n',
                    path: '/test/project/NewFile.kt',
                },
            ],
        });
    });

    it('should parse update diffs when the original file was moved already', async () => {
        mockFileContent('/test/project/NewFile.kt', 'new code line\n');

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
                    oldText: 'old code line\n',
                    newText: 'new code line\n',
                    path: '/test/project/NewFile.kt',
                },
            ],
        });
    });

    it('should send compact git patches when the client supports diffPatch', async () => {
        const updateEvent = await createFileChangeUpdate({
            type: 'fileChange',
            id: 'file-change-patches',
            changes: [
                {path: '/test/New.kt', kind: {type: 'add'}, diff: 'new line\n'},
                {path: '/test/Old.kt', kind: {type: 'delete'}, diff: 'old line\n'},
                {
                    path: '/test/Edit.kt',
                    kind: {type: 'update', move_path: null},
                    diff: '@@ -1 +1 @@\n-old line\n+new line\n',
                },
            ],
            status: 'completed',
        }, true);

        expect(updateEvent.sessionUpdate).toBe('tool_call');
        if (updateEvent.sessionUpdate !== 'tool_call') throw new Error('Expected a tool call');
        const contentBlocks = updateEvent.content ?? [];
        expect(contentBlocks).toHaveLength(3);
        for (const content of contentBlocks) {
            expect(content).toMatchObject({
                type: 'diff',
                oldText: null,
                newText: '',
                _meta: {
                    jetbrains: {
                        air: {
                            version: 1,
                            diffPatch: {version: 1, format: 'git_patch'},
                        },
                    },
                },
            });
        }
        const patches = contentBlocks.map((block) => (block._meta as any).jetbrains.air.diffPatch.text);
        expect(patches[0]).toContain('--- /dev/null');
        expect(patches[1]).toContain('+++ /dev/null');
        expect(patches[2]).toContain('@@ -1 +1 @@');
    });

    describe('diff patch fallback', () => {
        function onlyContent(event: Awaited<ReturnType<typeof createFileChangeUpdate>>) {
            if (event.sessionUpdate !== 'tool_call') throw new Error('Expected a tool call');
            expect(event.content).toHaveLength(1);
            return event.content![0]!;
        }

        it('sends the standard diff when the patch mode is not negotiated', async () => {
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'legacy-delete',
                changes: [{path: '/w/Old.kt', kind: {type: 'delete'}, diff: 'old line\n'}],
                status: 'completed',
            }, false));

            expect(content).toEqual({
                type: 'diff',
                oldText: 'old line\n',
                newText: '',
                path: '/w/Old.kt',
                _meta: {kind: 'delete'},
            });
        });

        it.each([
            {name: 'an empty added file', kind: {type: 'add' as const}, diff: '', expected: {oldText: null, newText: ''}},
            {name: 'an empty deleted file', kind: {type: 'delete' as const}, diff: '', expected: {oldText: '', newText: ''}},
            {name: 'a binary added file', kind: {type: 'add' as const}, diff: 'PNG\0data', expected: {oldText: null, newText: 'PNG\0data'}},
        ])('sends the standard diff for $name', async ({kind, diff, expected}) => {
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'fallback',
                changes: [{path: '/w/File', kind, diff}],
                status: 'completed',
            }, true));

            expect(content).toMatchObject({type: 'diff', path: '/w/File', ...expected});
            expect(JSON.stringify(content)).not.toContain('diffPatch');
        });

        it('sends the standard diff when the Codex hunks cannot form a valid patch', async () => {
            mockFileContent('/w/Edit.kt', 'old\n');
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'fallback-update',
                changes: [{
                    path: '/w/Edit.kt',
                    kind: {type: 'update', move_path: null},
                    diff: 'Index: /w/Edit.kt\n@@ -1 +1 @@\n-old\n+new\n',
                }],
                status: 'completed',
            }, true));

            expect(content).toEqual({
                type: 'diff',
                oldText: 'old\n',
                newText: 'new\n',
                path: '/w/Edit.kt',
                _meta: {kind: 'update'},
            });
        });

        it('sends the standard diff when a hunk has a marker line other than the final newline marker', async () => {
            mockFileContent('/w/Edit.kt', 'old');
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'fallback-marker',
                changes: [{
                    path: '/w/Edit.kt',
                    kind: {type: 'update', move_path: null},
                    diff: '@@ -1 +1 @@\n-old\n\\ injected\n+new\n',
                }],
                status: 'completed',
            }, true));

            expect(content).toEqual({
                type: 'diff',
                oldText: 'old',
                newText: 'new\n',
                path: '/w/Edit.kt',
                _meta: {kind: 'update'},
            });
        });

        it('sends the standard diff for a pure rename', async () => {
            mockFileContent('/w/New.kt', 'same\n');
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'pure-rename',
                changes: [{path: '/w/Old.kt', kind: {type: 'update', move_path: '/w/New.kt'}, diff: ''}],
                status: 'completed',
            }, true));

            expect(content).toMatchObject({type: 'diff', oldText: 'same\n', newText: 'same\n', path: '/w/New.kt'});
        });

        it('uses the target path of a rename in the patch block', async () => {
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'rename',
                changes: [{
                    path: '/w/Old.kt',
                    kind: {type: 'update', move_path: '/w/New.kt'},
                    diff: '@@ -1 +1 @@\n-old\n+new\n\n\nMoved to: /w/New.kt',
                }],
                status: 'completed',
            }, true));

            expect(content.type === 'diff' && content.path).toBe('/w/New.kt');
            expect((content._meta as any).jetbrains.air.diffPatch.text).toContain('rename from w/Old.kt\nrename to w/New.kt\n');
        });

        it('uses the target path when the moved file is already patched', async () => {
            mockFileContent('/w/Old.kt', 'new\n');
            const content = onlyContent(await createFileChangeUpdate({
                type: 'fileChange',
                id: 'already-patched-move',
                changes: [{path: '/w/Old.kt', kind: {type: 'update', move_path: '/w/New.kt'}, diff: '@@ -1 +1 @@\n-old\n+new\n'}],
                status: 'completed',
            }, false));

            expect(content).toMatchObject({oldText: 'old\n', newText: 'new\n', path: '/w/New.kt'});
        });
    });
});
