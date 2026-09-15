import fs from "node:fs";
import path from "node:path";
import {parsePatch} from "diff";
import {
    AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY,
    AIR_META_KEY,
    JETBRAINS_META_KEY,
} from "./AirExtension";

export const AGENT_FILE_CHANGE_REPORT_VERSION = 1;
export const AGENT_FILE_CHANGE_REPORT_MAX_PATHS = 1_024;
export const AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH = 4_096;
export const AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES = 256 * 1_024;
export const AGENT_FILE_CHANGE_REPORT_MAX_UNCERTAINTY_LENGTH = 2_000;
export const AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES = 8 * 1_024 * 1_024;

const TURN_DIFF_UNCERTAINTY = "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.";

export interface AgentFileChangeReportRequest {
    version: typeof AGENT_FILE_CHANGE_REPORT_VERSION;
    requestId: string;
}

export interface AgentFileChangeWorkspace {
    cwd: string;
    additionalDirectories: string[];
}

interface ParsedFileChangeReport {
    paths: string[];
    complete: boolean;
    uncertainty?: string;
}

export interface ReportedAgentFileChangeReport {
    version: typeof AGENT_FILE_CHANGE_REPORT_VERSION;
    requestId: string;
    status: "reported";
    paths: string[];
    declaredComplete: boolean;
    truncated: boolean;
    uncertainty?: string;
}

export type AgentFileChangeReportUnavailableReason =
    | "cancelled"
    | "timeout"
    | "invalidOutput"
    | "notReported"
    | "providerError";

export interface UnavailableAgentFileChangeReport {
    version: typeof AGENT_FILE_CHANGE_REPORT_VERSION;
    requestId: string;
    status: "unavailable";
    reason: AgentFileChangeReportUnavailableReason;
}

export type AgentFileChangeReport = ReportedAgentFileChangeReport | UnavailableAgentFileChangeReport;

export function parseAgentFileChangeReportRequest(
    meta: Record<string, unknown> | null | undefined,
): AgentFileChangeReportRequest | null {
    const jetbrains = asRecord(meta?.[JETBRAINS_META_KEY]);
    const air = asRecord(jetbrains?.[AIR_META_KEY]);
    const request = asRecord(air?.[AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY]);
    if (request === null
        || !hasOnlyKeys(request, ["version", "requestId"])
        || request["version"] !== AGENT_FILE_CHANGE_REPORT_VERSION) {
        return null;
    }
    const requestId = request["requestId"];
    if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
        return null;
    }
    return {version: AGENT_FILE_CHANGE_REPORT_VERSION, requestId};
}

export function createReportedAgentFileChangeReport(
    requestId: string,
    diff: string,
    workspace: AgentFileChangeWorkspace,
): ReportedAgentFileChangeReport {
    if (Buffer.byteLength(diff, "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_DIFF_BYTES) {
        throw new AgentFileChangeReportError("invalidOutput", "The turn diff exceeds the parser input limit");
    }
    const parsedReport = parseTurnDiff(diff);
    const normalized = normalizeFileChangeReport(parsedReport, workspace);
    return fitReportedAgentFileChangeReport({
        version: AGENT_FILE_CHANGE_REPORT_VERSION,
        requestId,
        status: "reported",
        ...normalized,
    });
}

export function createUnavailableAgentFileChangeReport(
    requestId: string,
    reason: AgentFileChangeReportUnavailableReason,
): UnavailableAgentFileChangeReport {
    return {
        version: AGENT_FILE_CHANGE_REPORT_VERSION,
        requestId,
        status: "unavailable",
        reason,
    };
}

export class AgentFileChangeReportError extends Error {
    readonly reason: AgentFileChangeReportUnavailableReason;

    constructor(reason: AgentFileChangeReportUnavailableReason, message: string) {
        super(message);
        this.name = "AgentFileChangeReportError";
        this.reason = reason;
    }
}

function parseTurnDiff(diff: string): ParsedFileChangeReport {
    if (diff.trim() === "") {
        return {paths: [], complete: false, uncertainty: TURN_DIFF_UNCERTAINTY};
    }

    let patches: ReturnType<typeof parsePatch>;
    try {
        patches = parsePatch(diff);
    } catch (error) {
        throw new AgentFileChangeReportError(
            "invalidOutput",
            `The turn diff is not valid unified diff: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (patches.length === 0) {
        throw new AgentFileChangeReportError("invalidOutput", "The turn diff contains no parseable file patches");
    }

    const paths: string[] = [];
    for (const patch of patches) {
        const oldPath = normalizeDiffPath(patch.oldFileName);
        const newPath = normalizeDiffPath(patch.newFileName);
        if (oldPath === null && newPath === null) {
            throw new AgentFileChangeReportError("invalidOutput", "The turn diff contains a patch without a file path");
        }
        if (oldPath !== null) paths.push(oldPath);
        if (newPath !== null) paths.push(newPath);
    }
    return {paths, complete: false, uncertainty: TURN_DIFF_UNCERTAINTY};
}

function normalizeDiffPath(value: string | undefined): string | null {
    if (value === undefined || value === "/dev/null") return null;
    return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

/**
 * AIR applies its 256 KiB limit to the serialized report object, not only to
 * the raw path strings. Account for JSON quotes, escaping, separators, and
 * fixed fields before publishing so a boundary-sized report remains decodable.
 */
function fitReportedAgentFileChangeReport(
    report: ReportedAgentFileChangeReport,
): ReportedAgentFileChangeReport {
    const paths = [...report.paths];
    let truncated = report.truncated;
    let fitted = report;
    while (Buffer.byteLength(JSON.stringify(fitted), "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES) {
        if (paths.length === 0) {
            throw new AgentFileChangeReportError("invalidOutput", "The audit report exceeds the wire limit");
        }
        paths.pop();
        truncated = true;
        fitted = {
            ...report,
            paths: [...paths],
            declaredComplete: false,
            truncated,
        };
    }
    return fitted;
}

function normalizeFileChangeReport(
    report: ParsedFileChangeReport,
    workspace: AgentFileChangeWorkspace,
): Omit<ReportedAgentFileChangeReport, "version" | "requestId" | "status"> {
    const lexicalCwd = parseWorkspaceRoot(workspace.cwd);
    if (lexicalCwd === null) {
        throw new AgentFileChangeReportError("providerError", "The session working directory is not absolute");
    }
    const cwd = canonicalizeWorkspaceRoot(lexicalCwd);
    const diffRoot = findDiffDisplayRoot(lexicalCwd);
    const roots = [cwd, ...workspace.additionalDirectories.flatMap(directory => {
        const root = normalizeWorkspaceRoot(directory);
        return root === null || root.flavor !== cwd.flavor ? [] : [root];
    })];
    const paths: string[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let truncated = false;

    for (const reportedPath of report.paths) {
        // parseTurnDiff has already decoded Git quoting and removed the a/ or b/ header prefix.
        if (reportedPath.length > AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH) {
            truncated = true;
            continue;
        }
        const normalized = normalizeReportedPath(reportedPath, diffRoot, roots);
        if (normalized === null || normalized.value.length > AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH) {
            truncated = true;
            continue;
        }
        const key = normalized.flavor === "windows" ? normalized.value.toLowerCase() : normalized.value;
        if (seen.has(key)) {
            continue;
        }
        const bytes = Buffer.byteLength(normalized.value, "utf8");
        if (paths.length >= AGENT_FILE_CHANGE_REPORT_MAX_PATHS
            || totalBytes + bytes > AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES) {
            truncated = true;
            continue;
        }
        seen.add(key);
        paths.push(normalized.value);
        totalBytes += bytes;
    }

    return {
        paths,
        declaredComplete: report.complete && !truncated,
        truncated,
        ...(report.uncertainty ? {uncertainty: report.uncertainty} : {}),
    };
}

type PathFlavor = "posix" | "windows";

interface NormalizedPath {
    value: string;
    flavor: PathFlavor;
}

function normalizeWorkspaceRoot(value: string): NormalizedPath | null {
    const root = parseWorkspaceRoot(value);
    return root === null ? null : canonicalizeWorkspaceRoot(root);
}

/** Preserve the spelling Codex uses for lexical ancestor discovery. */
function parseWorkspaceRoot(value: string): NormalizedPath | null {
    const trimmed = value.trim();
    if (!isValidPathText(trimmed)) {
        return null;
    }
    if (isWindowsAbsolutePath(trimmed)) {
        return {
            value: path.win32.normalize(trimmed.replace(/\//g, "\\")),
            flavor: "windows",
        };
    }
    if (path.posix.isAbsolute(trimmed)) {
        return {
            value: path.posix.normalize(trimmed.replace(/\\/g, "/")),
            flavor: "posix",
        };
    }
    return null;
}

function normalizeReportedPath(
    value: string,
    relativeRoot: NormalizedPath,
    roots: NormalizedPath[],
): NormalizedPath | null {
    const trimmed = value.trim();
    if (!isValidPathText(trimmed)
        || /^[A-Za-z]:[^\\/]/.test(trimmed)
        || /^\\\\[?.]\\/.test(trimmed)
        || (/^(?:\\\\|\/\/)/.test(trimmed) && !isWindowsAbsolutePath(trimmed))
        || (relativeRoot.flavor === "windows" && /^\\(?!\\)/.test(trimmed))
        || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
        return null;
    }

    let candidate: NormalizedPath;
    if (isWindowsAbsolutePath(trimmed)) {
        candidate = {value: path.win32.normalize(trimmed.replace(/\//g, "\\")), flavor: "windows"};
    } else if (path.posix.isAbsolute(trimmed)) {
        candidate = {value: path.posix.normalize(trimmed.replace(/\\/g, "/")), flavor: "posix"};
    } else if (relativeRoot.flavor === "windows") {
        candidate = {
            value: path.win32.resolve(relativeRoot.value, trimmed.replace(/\//g, "\\")),
            flavor: "windows",
        };
    } else {
        candidate = {
            value: path.posix.resolve(relativeRoot.value, trimmed.replace(/\\/g, "/")),
            flavor: "posix",
        };
    }

    candidate = canonicalizeReportedPath(candidate);

    return roots.some(root => pathIsStrictlyInside(root, candidate)) ? candidate : null;
}

/** Codex 0.154 renders turn-diff paths relative to the nearest Git root by default. */
function findDiffDisplayRoot(cwd: NormalizedPath): NormalizedPath {
    if (!isNativePathFlavor(cwd.flavor)) return cwd;
    const pathImplementation = cwd.flavor === "windows" ? path.win32 : path.posix;
    let current = cwd.value;
    while (true) {
        if (fs.existsSync(pathImplementation.join(current, ".git"))) {
            return canonicalizeWorkspaceRoot({value: current, flavor: cwd.flavor});
        }
        const parent = pathImplementation.dirname(current);
        if (parent === current) return cwd;
        current = parent;
    }
}

/** Resolve native filesystem aliases such as macOS' /tmp -> /private/tmp. */
function canonicalizeWorkspaceRoot(root: NormalizedPath): NormalizedPath {
    if (!isNativePathFlavor(root.flavor)) {
        return root;
    }
    return {...root, value: canonicalizeFromExistingAncestor(root.value)};
}

/**
 * Canonicalize the parent but not the leaf itself. A changed path may be
 * deleted, or it may be a symlink whose node (rather than target) changed.
 */
function canonicalizeReportedPath(candidate: NormalizedPath): NormalizedPath {
    if (!isNativePathFlavor(candidate.flavor)) {
        return candidate;
    }
    const parent = canonicalizeFromExistingAncestor(path.dirname(candidate.value));
    return {...candidate, value: path.resolve(parent, path.basename(candidate.value))};
}

/** Resolve the nearest existing ancestor and retain any missing suffix. */
function canonicalizeFromExistingAncestor(value: string): string {
    const original = path.resolve(value);
    let current = original;
    const missingSegments: string[] = [];

    while (true) {
        try {
            const canonical = fs.realpathSync.native(current);
            return path.resolve(canonical, ...missingSegments.reverse());
        } catch (error) {
            if (!isMissingPathError(error)) return original;
        }

        const parent = path.dirname(current);
        if (parent === current) return original;
        missingSegments.push(path.basename(current));
        current = parent;
    }
}

function isMissingPathError(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function isNativePathFlavor(flavor: PathFlavor): boolean {
    return process.platform === "win32" ? flavor === "windows" : flavor === "posix";
}

function pathIsStrictlyInside(root: NormalizedPath, candidate: NormalizedPath): boolean {
    if (root.flavor !== candidate.flavor) {
        return false;
    }
    const pathImplementation = root.flavor === "windows" ? path.win32 : path.posix;
    const relative = pathImplementation.relative(root.value, candidate.value);
    return relative.length > 0
        && !pathImplementation.isAbsolute(relative)
        && relative !== ".."
        && !relative.startsWith(`..${pathImplementation.sep}`);
}

function isWindowsAbsolutePath(value: string): boolean {
    const portable = value.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(portable) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(portable);
}

function isValidPathText(value: string): boolean {
    return value.length > 0 && !/[\u0000-\u001F\u007F-\u009F]/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every(key => allowedKeys.has(key));
}
