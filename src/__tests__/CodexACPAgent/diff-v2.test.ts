import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
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

/** The diffs come from Codex alone, so the files do not exist. */
const root = "/workspace";

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

function file(name: string): string {
    return path.join(root, name);
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
        const target = file("edit.ts");
        const updates = await runFileChange(fileChangeItem("item-edit", [{
            path: target,
            kind: {type: "update", move_path: null},
            diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "modify", path: target}]);
        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-edit.json');
    });

    it('renders an added file as an add change with a new-file patch', async () => {
        const target = file("added.ts");
        const updates = await runFileChange(fileChangeItem("item-add", [{
            path: target,
            kind: {type: "add"},
            diff: "export const a = 1;\nexport const b = 2;\n",
        }]));

        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-add.json');
    });

    it('renders a deleted file as a delete change with a deleted-file patch', async () => {
        const target = file("deleted.ts");
        const updates = await runFileChange(fileChangeItem("item-delete", [{
            path: target,
            kind: {type: "delete"},
            diff: "export const gone = true;",
        }]));

        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-delete.json');
    });

    it('renders a moved and edited file as a move change with a rename patch', async () => {
        const source = file("old-name.ts");
        const destination = file("new-name.ts");
        const updates = await runFileChange(fileChangeItem("item-move", [{
            path: source,
            kind: {type: "update", move_path: destination},
            diff: `@@ -1 +1 @@\n-old code line\n+new code line\n\n\nMoved to: ${destination}`,
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "move", oldPath: source, path: destination}]);
        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-move.json');
    });

    it('renders a pure rename as a move change with a rename-only patch', async () => {
        const source = file("renamed-old.ts");
        const destination = file("renamed-new.ts");
        const updates = await runFileChange(fileChangeItem("item-rename", [{
            path: source,
            kind: {type: "update", move_path: destination},
            diff: "",
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "move", oldPath: source, path: destination}]);
        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-rename.json');
    });

    it('renders an added empty file as an add change with a header-only patch', async () => {
        const target = file("empty.ts");
        const updates = await runFileChange(fileChangeItem("item-add-empty", [{
            path: target,
            kind: {type: "add"},
            diff: "",
        }]));

        expect(diffs(updates)[0]!.changes).toEqual([{operation: "add", path: target}]);
        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-add-empty.json');
    });

    it('sends no diff for a change without a valid patch', async () => {
        const updates = await runFileChange(fileChangeItem("item-malformed", [{
            path: file("malformed.ts"),
            kind: {type: "update", move_path: null},
            diff: "not a diff",
        }]));

        expect(diffs(updates)).toEqual([]);
    });

    it('renders one diff per file of a multi-file change', async () => {
        const edited = file("multi-edit.ts");
        const added = file("multi-add.ts");
        const deleted = file("multi-delete.ts");
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
        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v2-multi.json');
    });

    it('keeps the v1 oldText/newText diff shape on a v1 connection', async () => {
        const source = file("v1-old-name.ts");
        const destination = file("v1-new-name.ts");
        const added = file("v1-added.ts");
        const updates = await runFileChange(fileChangeItem("item-v1", [
            {
                path: source,
                kind: {type: "update", move_path: destination},
                diff: "@@ -1 +1 @@\n-old code line\n+new code line\n",
            },
            {path: added, kind: {type: "add"}, diff: "new\n"},
        ]), 1);

        await expect(dump(updates)).toMatchFileSnapshot('data/diff-v1-unchanged.json');
    });
});
