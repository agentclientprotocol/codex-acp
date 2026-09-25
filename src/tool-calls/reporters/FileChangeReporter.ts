import type {ToolCallContent} from "@agentclientprotocol/sdk";
import {parsePatch, type StructuredPatch} from "diff";
import {AIR_DIFF_PATCH_KEY, withAirMeta} from "../../AirExtension";
import type {FileChangeRequestApprovalParams, FileUpdateChange, ThreadItem} from "../../app-server/v2";
import {
    createAddedFileGitPatch,
    createDeletedFileGitPatch,
    createUpdateGitPatch,
    DIFF_PATCH_MAX_BYTES,
} from "../../GitPatch";
import {logger} from "../../Logger";
import type {PermissionToolFacts, ToolFacts} from "../ToolFacts";
import {toToolStatus} from "./ToolStatus";

type FileChangeItem = ThreadItem & {type: "fileChange"};

const FILE_CHANGE_TITLE = "Editing files";

/**
 * Reports a Codex file change from the Codex diff alone. The reporter never reads the file.
 *
 * An update gets one ACP diff per Codex hunk: `oldText` and `newText` hold the changed lines and the context lines
 * of the hunk, not the whole file. An added or a deleted file gets its whole text. A diff whose text is larger than
 * {@link DIFF_PATCH_MAX_BYTES} is not sent. With the AIR `diffPatch` capability, the diff is a Git patch,
 * see `docs/air-extensions.md#diff-patch`.
 */
export class FileChangeReporter {
    static started(item: FileChangeItem, diffPatch: boolean): ToolFacts {
        const diffs: ToolCallContent[] = [];
        for (const change of item.changes) {
            // An unparseable or a too large change has no diff.
            diffs.push(...createPatchContent(change, diffPatch));
        }
        return {
            toolCallId: item.id,
            report: "start",
            title: FILE_CHANGE_TITLE,
            kind: "edit",
            status: toToolStatus(item.status),
            result: diffs,
        };
    }

    static completed(item: FileChangeItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            status: item.status === "completed" ? "completed" : "failed",
        };
    }

    /**
     * The tool call of an approval request. A started file change already shows its diff,
     * so the request adds only the paths.
     */
    static permission(params: FileChangeRequestApprovalParams, item: FileChangeItem | undefined): PermissionToolFacts {
        return {
            toolCallId: params.itemId,
            title: FILE_CHANGE_TITLE,
            ...(item === undefined ? {kind: "edit", status: "pending"} : {}),
            locations: [...new Set(item?.changes.map(change => change.path) ?? [])],
            standard: {kind: "edit", status: "pending", title: "Edit files"},
        };
    }
}

function createPatchContent(change: FileUpdateChange, supportsDiffPatch: boolean): ToolCallContent[] {
    try {
        switch (change.kind.type) {
            case "add":
                return createWholeFileContent(change, "add", supportsDiffPatch);
            case "delete":
                return createWholeFileContent(change, "delete", supportsDiffPatch);
            case "update":
                return createUpdateFileContent(change, change.kind.move_path, supportsDiffPatch);
        }
    } catch (error) {
        logger.log(`Error processing file update change: ${error}`);
        return [];
    }
}

/** The diff of an added or a deleted file. Codex sends the whole file text in `diff`. */
function createWholeFileContent(
    change: FileUpdateChange,
    kind: "add" | "delete",
    supportsDiffPatch: boolean,
): ToolCallContent[] {
    if (!fitsDiffLimit(change.diff)) {
        logger.log("Skipped the diff of a file that is too large", {path: change.path});
        return [];
    }
    const patch = !supportsDiffPatch ? null
        : kind === "add" ? createAddedFileGitPatch(change.path, change.diff)
        : createDeletedFileGitPatch(change.path, change.diff);
    if (patch !== null) return [createPatchOnlyContent(change.path, kind, patch)];
    return [{
        type: "diff",
        oldText: kind === "add" ? null : change.diff,
        newText: kind === "add" ? change.diff : "",
        path: change.path,
        _meta: {kind},
    }];
}

/** The diffs of an updated file: one diff per Codex hunk. */
function createUpdateFileContent(
    change: FileUpdateChange,
    movePath: string | null,
    supportsDiffPatch: boolean,
): ToolCallContent[] {
    const unifiedDiff = recoverCorruptedDiff(change.diff);
    const targetPath = movePath ?? change.path;
    if (!fitsDiffLimit(unifiedDiff)) {
        logger.log("Skipped the diff of a file change that is too large", {path: targetPath});
        return [];
    }

    const gitPatch = supportsDiffPatch ? createUpdateGitPatch(change.path, targetPath, unifiedDiff) : null;
    if (gitPatch !== null) {
        return [createPatchOnlyContent(targetPath, "update", gitPatch)];
    }

    // A pure rename has no hunks. Its diff names the new path and changes no line.
    if (movePath !== null && unifiedDiff.trim().length === 0) {
        return [{type: "diff", oldText: "", newText: "", path: targetPath, _meta: {kind: "update"}}];
    }
    const patch = parseSinglePatch(unifiedDiff);
    if (patch === null) {
        logger.log("Skipped a file change whose diff has no single valid patch", {path: change.path});
        return [];
    }
    return patch.hunks.map(hunk => {
        const {oldText, newText} = hunkTexts(hunk.lines);
        return {type: "diff", oldText, newText, path: targetPath, _meta: {kind: "update"}};
    });
}

/**
 * The old and the new text of one hunk. Each line keeps its line break, except a line that the
 * `\\ No newline at end of file` marker follows.
 */
function hunkTexts(lines: string[]): {oldText: string; newText: string} {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let previous = " ";
    for (const line of lines) {
        const sign = line[0] ?? " ";
        if (sign === "\\") {
            if (previous !== "+") stripLineBreak(oldLines);
            if (previous !== "-") stripLineBreak(newLines);
            continue;
        }
        const text = `${line.slice(1)}\n`;
        if (sign !== "+") oldLines.push(text);
        if (sign !== "-") newLines.push(text);
        previous = sign;
    }
    return {oldText: oldLines.join(""), newText: newLines.join("")};
}

function stripLineBreak(lines: string[]): void {
    const last = lines.at(-1);
    if (last !== undefined) lines[lines.length - 1] = last.slice(0, -1);
}

/**
 * Whether a diff text is small enough to send. The UTF-16 length is a lower bound of the UTF-8 size, so a text
 * over the limit is rejected before it is encoded or copied.
 */
function fitsDiffLimit(text: string): boolean {
    return text.length <= DIFF_PATCH_MAX_BYTES && Buffer.byteLength(text, "utf8") <= DIFF_PATCH_MAX_BYTES;
}

function parseSinglePatch(diff: string): StructuredPatch | null {
    try {
        const patches = parsePatch(diff);
        return patches.length === 1 ? patches[0]! : null;
    } catch {
        return null;
    }
}

function createPatchOnlyContent(path: string, kind: string, patch: string): ToolCallContent {
    return {
        type: "diff",
        oldText: null,
        newText: "",
        path,
        _meta: withAirMeta({ kind }, AIR_DIFF_PATCH_KEY, {
            version: 1,
            format: "git_patch",
            text: patch,
        }),
    };
}

/**
 * Fix unified diff content corrupted by codex agent.
 * Removes synthetic "Moved to" from the end.
 */
function recoverCorruptedDiff(diff: string): string {
    return diff.replace(/\n\nMoved to: .*$/, "");
}
