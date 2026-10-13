import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { Thread, ThreadItem } from "./app-server/v2";
import {
    createAddedFileGitPatch,
    createDeletedFileGitPatch,
    createUpdateGitPatch,
} from "./GitPatch";

export const SESSION_FILE_REVERT_METHOD = "_session/files/revert";
export const sessionFileRevertParser = z
    .object({
        sessionId: z.string().trim().min(1),
        toolCallId: z.string().trim().min(1),
        dryRun: z.boolean(),
        previewToken: z
            .string()
            .regex(/^sha256:[a-f0-9]{64}$/)
            .optional(),
    })
    .strict()
    .refine(
        (p) => p.dryRun || p.previewToken !== undefined,
        "A restore requires its preview token",
    );
export type SessionFileRevertRequest = z.infer<typeof sessionFileRevertParser>;
type NativeFileChange = Extract<ThreadItem, { type: "fileChange" }>;
export type FileRevertSession = {
    sessionId: string;
    cwd: string;
    additionalDirectories: string[];
};
export type FileRevertResult = {
    version: 1;
    dryRun: boolean;
    canRevert: boolean;
    reverted: boolean;
    paths: string[];
    previewToken?: string;
    reason?: string;
};
export function fileRevertCapability() {
    return {
        version: 1,
        method: SESSION_FILE_REVERT_METHOD,
        dryRun: true,
        previewTokenRequired: true,
        scope: "nativeFileChangeTool",
        requiresGit: true,
        changesConversation: false,
        coverage:
            "Recorded text patches only; not shell changes or a whole-workspace checkpoint",
    };
}

const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 8 * 1024 * 1024;
function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative !== "" &&
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)
    );
}

/** Ignore inherited alternate-index/worktree knobs. This operation never stages
  * files and never changes HEAD, branches, hooks, or the user's Git index. */
async function git(
    cwd: string,
    args: string[],
    input?: string,
): Promise<{ code: number | null; stdout: string }> {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !key.toUpperCase().startsWith("GIT_"),
        ),
    );
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
            cwd,
            env,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => child.kill(), 15_000);
        child.stdout.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_BYTES) chunks.push(chunk);
            else child.kill();
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
        });
        child.stdin.end(input);
    });
}

async function checkedPath(
    root: string,
    roots: string[],
    value: string,
): Promise<{ absolute: string; relative: string }> {
    const absolute = path.resolve(value);
    if (
        !inside(root, absolute) ||
        !roots.some((workspace) => inside(workspace, absolute))
    )
        throw new Error("outside_workspace");
    const relative = path.relative(root, absolute);
    const parts = relative.split(path.sep);
    if (parts.some((part) => part.toLowerCase() === ".git" || part.includes(":")))
        throw new Error("unsafe_path");
    let walk = root;
    for (let i = 0; i < parts.length; i++) {
        walk = path.join(walk, parts[i]!);
        try {
            const stat = await lstat(walk);
            if (
                stat.isSymbolicLink() ||
                (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
            )
                throw new Error("unsupported_file_type");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
        }
    }
    return { absolute, relative: relative.split(path.sep).join("/") };
}

async function fingerprintFiles(files: string[]): Promise<string[]> {
    return Promise.all(
        files.map(async (file) => {
            try {
                const stat = await lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
                    throw new Error("unsupported_file_type_or_size");
                return `${file}\0${stat.mode}\0${hash(await readFile(file))}`;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                    return `${file}\0missing`;
                throw error;
            }
        }),
    );
}

/** Hold the session AND overlapping-workspace mutation fence around this whole
  * call. External editors are not controlled by the adapter; Git rejects patch
  * conflicts, but this is not a cross-process filesystem transaction. */
export async function revertSessionFiles(
    value: unknown,
    session: FileRevertSession,
    readHistory: () => Promise<{ thread: Thread }>,
): Promise<FileRevertResult> {
    const request = sessionFileRevertParser.parse(value);
    if (request.sessionId !== session.sessionId)
        throw RequestError.invalidParams(undefined, "Session mismatch");
    const base: FileRevertResult = {
        version: 1,
        dryRun: request.dryRun,
        canRevert: false,
        reverted: false,
        paths: [],
    };
    const { thread } = await readHistory();
    if (thread.id !== session.sessionId)
        throw RequestError.invalidParams(undefined, "History session mismatch");
    const matches = thread.turns
        .flatMap((turn) => turn.items)
        .filter(
            (item): item is NativeFileChange =>
                item.type === "fileChange" && item.id === request.toolCallId,
        );
    if (matches.length !== 1 || matches[0]!.status !== "completed")
        return { ...base, reason: "completed_patch_not_found" };
    const changes = matches[0]!.changes;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64)
        return {...base, reason: "unsupported_patch_size"};
    // Validate every native change before constructing any patch. Generated types cannot
    // validate runtime JSON from an older/newer native process.
    for (const change of changes as unknown[]) {
        if (change === null || typeof change !== "object") return {...base, reason: "unsupported_patch"};
        const value = change as {path?: unknown; kind?: {type?: unknown; move_path?: unknown}; diff?: unknown};
        if (typeof value.path !== "string" || !value.path || typeof value.diff !== "string"
            || value.kind === null || typeof value.kind !== "object"
            || !["add", "delete", "update"].includes(String(value.kind.type))
            || (value.kind.type === "update" && value.kind.move_path != null && typeof value.kind.move_path !== "string")) {
            return {...base, reason: "unsupported_patch"};
        }
    }
    const found = await git(session.cwd, ["rev-parse", "--show-toplevel"]);
    if (found.code !== 0) return { ...base, reason: "not_git_repository" };
    const root = await realpath(found.stdout.trim());
    const roots = await Promise.all(
        [session.cwd, ...session.additionalDirectories].map((value) =>
            realpath(value),
        ),
    );
    let patch = "";
    const paths = new Set<string>();
    try {
        for (const change of changes) {
            const source = await checkedPath(
                root,
                roots,
                path.resolve(session.cwd, change.path),
            );
            paths.add(source.absolute);
            let part: string | null;
            switch (change.kind.type) {
                case "add":
                    part = createAddedFileGitPatch(source.relative, change.diff);
                    break;
                case "delete":
                    part = createDeletedFileGitPatch(source.relative, change.diff);
                    break;
                case "update": {
                    const target = change.kind.move_path
                        ? await checkedPath(
                                root,
                                roots,
                                path.resolve(session.cwd, change.kind.move_path),
                            )
                        : source;
                    paths.add(target.absolute);
                    part = createUpdateGitPatch(
                        source.relative,
                        target.relative,
                        change.diff,
                    );
                    break;
                }
                default:
                    return { ...base, reason: "unsupported_patch" };
            }
            if (part === null) return { ...base, reason: "unsupported_patch" };
            patch += part;
            if (Buffer.byteLength(patch, "utf8") > MAX_BYTES)
                return { ...base, reason: "unsupported_patch_size" };
        }
        base.paths = [...paths].sort();
        const before = await fingerprintFiles(base.paths);
        const previewToken = `sha256:${hash(JSON.stringify([root, session.sessionId, request.toolCallId, patch, before]))}`;
        if (!request.dryRun && request.previewToken !== previewToken)
            return { ...base, reason: "stale_preview" };
        const check = await git(
            root,
            ["apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
            patch,
        );
        if (check.code !== 0) return { ...base, reason: "patch_conflict" };
        if (request.dryRun) return { ...base, canRevert: true, previewToken };
        // Validate nodes again immediately before applying, including parents.
        for (const file of base.paths) await checkedPath(root, roots, file);
        if (
            JSON.stringify(before) !==
            JSON.stringify(await fingerprintFiles(base.paths))
        )
            return { ...base, reason: "stale_preview" };
        const applied = await git(
            root,
            ["apply", "--reverse", "--whitespace=nowarn", "-"],
            patch,
        );
        if (applied.code !== 0)
            return { ...base, reason: "restore_outcome_unknown" };
        return { ...base, canRevert: true, reverted: true };
    } catch (error) {
        // Never include file contents or provider stderr in a failure response.
        if (
            error instanceof Error &&
            [
                "outside_workspace",
                "unsafe_path",
                "unsupported_file_type",
                "unsupported_file_type_or_size",
            ].includes(error.message)
        ) {
            return { ...base, reason: error.message };
        }
        throw error;
    }
}
