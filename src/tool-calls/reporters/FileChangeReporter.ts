import type {ToolCallContent} from "@agentclientprotocol/sdk";
import {applyPatch, parsePatch, reversePatch, type StructuredPatch} from "diff";
import {readFile} from "node:fs/promises";
import {AIR_DIFF_PATCH_KEY, withAirMeta} from "../../AirExtension";
import type {FileChangeRequestApprovalParams, FileUpdateChange, ThreadItem} from "../../app-server/v2";
import {createAddedFileGitPatch, createDeletedFileGitPatch, createUpdateGitPatch} from "../../GitPatch";
import {logger} from "../../Logger";
import type {PermissionToolFacts, ToolFacts} from "../ToolFacts";
import {toToolStatus} from "./ToolStatus";

type FileChangeItem = ThreadItem & {type: "fileChange"};

export const FILE_CHANGE_TITLE = "Editing files";

/**
 * Reports a Codex file change. The diff in `content` carries the file text.
 * With the AIR `diffPatch` capability, the diff is a Git patch, see `docs/air-extensions.md#diff-patch`.
 */
export class FileChangeReporter {
    static async started(item: FileChangeItem, diffPatch: boolean): Promise<ToolFacts> {
        const diffs: ToolCallContent[] = [];
        for (const change of item.changes) {
            // An unparseable change has no diff.
            const content = await createPatchContent(change, diffPatch);
            if (content) diffs.push(content);
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

async function createPatchContent(
    change: FileUpdateChange,
    supportsDiffPatch: boolean,
): Promise<ToolCallContent | null> {
    try {
        switch (change.kind.type) {
            case "add":
                return createAddFileContent(change, supportsDiffPatch);
            case "delete":
                return createDeleteFileContent(change, supportsDiffPatch);
            case "update":
                return await createUpdateFileContent(change, change.kind.move_path, supportsDiffPatch);
        }
    } catch (error) {
        logger.log(`Error processing file update change: ${error}`);
        return null;
    }
}

function createAddFileContent(
    change: FileUpdateChange,
    supportsDiffPatch: boolean,
): ToolCallContent {
    // app-server always returns file content instead of diff
    const patch = supportsDiffPatch ? createAddedFileGitPatch(change.path, change.diff) : null;
    if (patch !== null) {
        return createPatchOnlyContent(change.path, "add", patch);
    }
    return {
        type: "diff",
        oldText: null,
        newText: change.diff,
        path: change.path,
        _meta: { kind: "add" },
    };
}

async function createUpdateFileContent(
    change: FileUpdateChange,
    movePath: string | null,
    supportsDiffPatch: boolean,
): Promise<ToolCallContent | null> {
    const unifiedDiff = recoverCorruptedDiff(change.diff);
    const targetPath = movePath ?? change.path;

    const gitPatch = supportsDiffPatch ? createUpdateGitPatch(change.path, targetPath, unifiedDiff) : null;
    if (gitPatch !== null) {
        return createPatchOnlyContent(targetPath, "update", gitPatch);
    }

    // The standard diff needs the file text, so it reads the file and applies the Codex hunks.
    const patch = parseSinglePatch(unifiedDiff);
    if (patch === null) {
        logger.log("Skipped a file change whose diff has no single valid patch", {path: change.path});
        return null;
    }

    const oldContent = await readFileContent(change.path);
    if (oldContent !== null) {
        const patchedContent = applyPatch(oldContent, patch);
        if (patchedContent === false) {
            // If Codex runs in full access mode, the file might already be patched.
            // we can verify this by checking if the reverted patch applies.
            const revertedContent = applyPatch(oldContent, reversePatch(patch));
            if (revertedContent !== false) {
                return createUpdateDiffContent(targetPath, revertedContent, oldContent);
            }
            return null;
        }
        return createUpdateDiffContent(targetPath, oldContent, patchedContent);
    }

    if (!movePath) return null;
    const newContent = await readFileContent(movePath);
    if (newContent === null) return null;

    const revertedContent = applyPatch(newContent, reversePatch(patch));
    if (revertedContent === false) return null;

    return createUpdateDiffContent(movePath, revertedContent, newContent);
}

function parseSinglePatch(diff: string): StructuredPatch | null {
    try {
        const patches = parsePatch(diff);
        return patches.length === 1 ? patches[0]! : null;
    } catch {
        return null;
    }
}

function createUpdateDiffContent(path: string, oldText: string, newText: string): ToolCallContent {
    return {
        type: "diff",
        oldText,
        newText,
        path,
        _meta: { kind: "update" },
    };
}

function createDeleteFileContent(
    change: FileUpdateChange,
    supportsDiffPatch: boolean,
): ToolCallContent {
    // app-server always returns file content instead of diff
    const patch = supportsDiffPatch ? createDeletedFileGitPatch(change.path, change.diff) : null;
    if (patch !== null) {
        return createPatchOnlyContent(change.path, "delete", patch);
    }
    return {
        type: "diff",
        oldText: change.diff,
        newText: "",
        path: change.path,
        _meta: { kind: "delete" },
    };
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

async function readFileContent(filePath: string): Promise<string | null> {
    return await readFile(filePath, { encoding: "utf8" }).catch(() => null);
}

/**
 * Fix unified diff content corrupted by codex agent.
 * Removes synthetic "Moved to" from the end.
 */
function recoverCorruptedDiff(diff: string): string {
    return diff.replace(/\n\nMoved to: .*$/, "");
}
