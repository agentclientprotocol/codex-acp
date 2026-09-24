import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import type {FileUpdateChange, ThreadItem} from '../../app-server/v2';
import {
    connectSession,
    dump,
    itemCompleted,
    itemStarted,
    type PromptSession,
    settle,
    turnCompleted,
    turnStarted,
    userMessageItem,
} from './v2-prompt-harness';
import {expectConformingV2SessionUpdates} from './v2-session-update-guard';

let root = "";

beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "codex-acp-diff-v2-"));
});

afterAll(async () => {
    await rm(root, {recursive: true, force: true});
});

/** Starts a turn; the v1 prompt response only arrives when the turn ends, so it is returned unawaited. */
async function startTurn(client: PromptSession, protocolVersion: 1 | 2): Promise<{response: Promise<unknown>}> {
    const response = client.sendPrompt([{type: "text", text: "Edit the files"}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    const clientUserMessageId = protocolVersion === 2
        ? client.turnStartParams[0]!["clientUserMessageId"] as string
        : null;
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(clientUserMessageId)));
    if (protocolVersion === 2) {
        await response;
    }
    return {response};
}

function fileChangeItem(id: string, changes: FileUpdateChange[]): ThreadItem {
    return {type: "fileChange", id, changes, status: "inProgress"};
}

/** Runs one turn with a single file change and returns the tool call updates the client received. */
async function runFileChange(item: ThreadItem, protocolVersion: 1 | 2 = 2): Promise<unknown[]> {
    const client = await connectSession(protocolVersion);
    try {
        const {response} = await startTurn(client, protocolVersion);
        client.emit(itemStarted(item));
        client.emit(itemCompleted({...item, status: "completed"} as ThreadItem));
        client.emit(turnCompleted());
        await response;
        await client.promptRunFinished();
        await settle();
        return client.transcript.flatMap(entry => "sessionUpdate" in entry ? [entry.sessionUpdate] : [])
            .filter(update => ["tool_call", "tool_call_update"].includes(update.sessionUpdate));
    } finally {
        client.connection.close();
    }
}

/** Snapshot text with the temporary directory replaced by a stable placeholder. */
function dumpWithRoot(updates: unknown[]): string {
    return dump(updates).replaceAll(root, "<root>");
}

/** Absolute path in the temporary directory, created with `content` if given. */
async function file(name: string, content?: string): Promise<string> {
    const filePath = path.join(root, name);
    if (content !== undefined) {
        await writeFile(filePath, content);
    }
    return filePath;
}

function diffs(updates: unknown[]): acpV2.Diff[] {
    return (updates as acpV2.ToolCallUpdate[])
        .flatMap(update => update.content ?? [])
        .filter(content => content.type === "diff")
        .map(content => content as acpV2.Diff);
}

describe('file change diffs over ACP v2', () => {
    afterEach(() => {
        vi.clearAllMocks();
        expectConformingV2SessionUpdates();
    });

    it('renders an edit as a modify change with a git patch', async () => {
        const target = await file("edit.ts", "one\ntwo\nthree\nfour\n");
        const updates = await runFileChange(fileChangeItem("item-edit", [{
            path: target,
            kind: {type: "update", move_path: null},
            diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "modify", path: target}]);
        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v2-edit.json');
    });

    it('renders an added file as an add change with a new-file patch', async () => {
        const target = await file("added.ts");
        const updates = await runFileChange(fileChangeItem("item-add", [{
            path: target,
            kind: {type: "add"},
            diff: "export const a = 1;\nexport const b = 2;\n",
        }]));

        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v2-add.json');
    });

    it('renders a deleted file as a delete change with a deleted-file patch', async () => {
        const target = await file("deleted.ts");
        const updates = await runFileChange(fileChangeItem("item-delete", [{
            path: target,
            kind: {type: "delete"},
            diff: "export const gone = true;",
        }]));

        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v2-delete.json');
    });

    it('renders a moved and edited file as a move change with a rename patch', async () => {
        const source = await file("old-name.ts", "old code line\n");
        const destination = await file("new-name.ts");
        const updates = await runFileChange(fileChangeItem("item-move", [{
            path: source,
            kind: {type: "update", move_path: destination},
            diff: `@@ -1 +1 @@\n-old code line\n+new code line\n\n\nMoved to: ${destination}`,
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "move", oldPath: source, path: destination}]);
        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v2-move.json');
    });

    it('renders one diff per file of a multi-file change', async () => {
        const edited = await file("multi-edit.ts", "let x = 1;\n");
        const added = await file("multi-add.ts");
        const deleted = await file("multi-delete.ts");
        const updates = await runFileChange(fileChangeItem("item-multi", [
            {path: edited, kind: {type: "update", move_path: null}, diff: "@@ -1 +1 @@\n-let x = 1;\n+let x = 2;\n"},
            {path: added, kind: {type: "add"}, diff: "new\n"},
            {path: deleted, kind: {type: "delete"}, diff: "old\n"},
        ]));

        expect(diffs(updates).map(diff => diff.changes)).toEqual([
            [{operation: "modify", path: edited}],
            [{operation: "add", path: added}],
            [{operation: "delete", path: deleted}],
        ]);
        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v2-multi.json');
    });

    it('keeps the v1 oldText/newText diff shape on a v1 connection', async () => {
        const source = await file("v1-old-name.ts", "old code line\n");
        const destination = await file("v1-new-name.ts");
        const added = await file("v1-added.ts");
        const updates = await runFileChange(fileChangeItem("item-v1", [
            {
                path: source,
                kind: {type: "update", move_path: destination},
                diff: "@@ -1 +1 @@\n-old code line\n+new code line\n",
            },
            {path: added, kind: {type: "add"}, diff: "new\n"},
        ]), 1);

        await expect(dumpWithRoot(updates)).toMatchFileSnapshot('data/diff-v1-unchanged.json');
    });
});
