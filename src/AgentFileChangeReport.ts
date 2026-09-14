import fs from "node:fs";
import path from "node:path";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {Turn} from "./app-server/v2";
import {
    AIR_AGENT_FILE_CHANGE_REPORT_REQUEST_KEY,
    AIR_META_KEY,
    JETBRAINS_META_KEY,
} from "./AirExtension";

export const AGENT_FILE_CHANGE_REPORT_VERSION = 1;
export const AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS = 30_000;
export const AGENT_FILE_CHANGE_REPORT_MAX_PATHS = 1_024;
export const AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH = 4_096;
export const AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES = 256 * 1_024;
export const AGENT_FILE_CHANGE_REPORT_MAX_UNCERTAINTY_LENGTH = 2_000;

export interface AgentFileChangeReportRequest {
    version: typeof AGENT_FILE_CHANGE_REPORT_VERSION;
    requestId: string;
}

export interface AgentFileChangeWorkspace {
    cwd: string;
    additionalDirectories: string[];
}

interface ModelFileChangeReport {
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

export const AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["paths", "complete", "uncertainty"],
    properties: {
        paths: {
            type: "array",
            items: {type: "string"},
        },
        complete: {type: "boolean"},
        uncertainty: {
            anyOf: [{
                type: "string",
                maxLength: AGENT_FILE_CHANGE_REPORT_MAX_UNCERTAINTY_LENGTH,
            }, {
                type: "null",
            }],
        },
    },
};

export const AGENT_FILE_CHANGE_REPORT_DEVELOPER_INSTRUCTIONS = `You are running an internal, read-only file-change audit for the immediately preceding turn.
Do not modify files, run commands that can modify files, or ask the user questions.
Report files that the preceding turn causally created, modified, deleted, or moved, including changes made by shell commands, version-control commands, generators, and child processes.
Do not report files that were only read or inspected.
You may use read-only inspection when needed. If the list may be incomplete, set complete to false and briefly explain why in uncertainty.`;

export function createAgentFileChangeReportPrompt(workspace: AgentFileChangeWorkspace): string {
    return `List the paths changed by the immediately preceding turn.
Return only the structured result required by the output schema.
Relative paths are resolved against the working directory.
Working directory: ${JSON.stringify(workspace.cwd)}
Additional allowed directories: ${JSON.stringify(workspace.additionalDirectories)}`;
}

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
    turn: Turn,
    workspace: AgentFileChangeWorkspace,
): ReportedAgentFileChangeReport {
    const modelReport = parseModelFileChangeReport(turn);
    const normalized = normalizeModelFileChangeReport(modelReport, workspace);
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

function parseModelFileChangeReport(turn: Turn): ModelFileChangeReport {
    switch (turn.status) {
        case "interrupted":
            throw new AgentFileChangeReportError("cancelled", "The audit turn was interrupted");
        case "failed":
            throw new AgentFileChangeReportError(
                "providerError",
                `The audit turn failed${turn.error?.message ? `: ${turn.error.message}` : ""}`,
            );
        case "inProgress":
            throw new AgentFileChangeReportError("notReported", "The audit turn did not complete");
        case "completed":
            break;
    }

    let text: string | null = null;
    for (let index = turn.items.length - 1; index >= 0; index -= 1) {
        const item = turn.items[index];
        if (item?.type === "agentMessage") {
            text = item.text;
            break;
        }
    }
    if (text === null) {
        throw new AgentFileChangeReportError("notReported", "The audit turn returned no agent message");
    }

    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new AgentFileChangeReportError("invalidOutput", "The audit turn returned invalid JSON");
    }
    const report = asRecord(value);
    if (report === null || !hasOnlyKeys(report, ["paths", "complete", "uncertainty"])) {
        throw new AgentFileChangeReportError("invalidOutput", "The audit turn returned an invalid object");
    }
    const paths = report["paths"];
    const complete = report["complete"];
    const uncertainty = report["uncertainty"];
    if (!Array.isArray(paths)
        || !paths.every((item): item is string => typeof item === "string")
        || typeof complete !== "boolean"
        || (uncertainty !== undefined && uncertainty !== null && typeof uncertainty !== "string")) {
        throw new AgentFileChangeReportError("invalidOutput", "The audit turn returned invalid fields");
    }
    const normalizedUncertainty = typeof uncertainty === "string" ? uncertainty.trim() : undefined;
    if (normalizedUncertainty !== undefined
        && normalizedUncertainty.length > AGENT_FILE_CHANGE_REPORT_MAX_UNCERTAINTY_LENGTH) {
        throw new AgentFileChangeReportError("invalidOutput", "The audit turn returned oversized uncertainty");
    }
    return {
        paths,
        complete,
        ...(normalizedUncertainty ? {uncertainty: normalizedUncertainty} : {}),
    };
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

function normalizeModelFileChangeReport(
    report: ModelFileChangeReport,
    workspace: AgentFileChangeWorkspace,
): Omit<ReportedAgentFileChangeReport, "version" | "requestId" | "status"> {
    const cwd = normalizeWorkspaceRoot(workspace.cwd);
    if (cwd === null) {
        throw new AgentFileChangeReportError("providerError", "The session working directory is not absolute");
    }
    const roots = [cwd, ...workspace.additionalDirectories.flatMap(directory => {
        const root = normalizeWorkspaceRoot(directory);
        return root === null || root.flavor !== cwd.flavor ? [] : [root];
    })];
    const paths: string[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let truncated = false;

    for (const reportedPath of report.paths) {
        if (reportedPath.length > AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH) {
            truncated = true;
            continue;
        }
        const normalized = normalizeReportedPath(reportedPath, cwd, roots);
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
    const trimmed = value.trim();
    if (!isValidPathText(trimmed)) {
        return null;
    }
    if (isWindowsAbsolutePath(trimmed)) {
        return canonicalizeWorkspaceRoot({
            value: path.win32.normalize(trimmed.replace(/\//g, "\\")),
            flavor: "windows",
        });
    }
    if (path.posix.isAbsolute(trimmed)) {
        return canonicalizeWorkspaceRoot({
            value: path.posix.normalize(trimmed.replace(/\\/g, "/")),
            flavor: "posix",
        });
    }
    return null;
}

function normalizeReportedPath(
    value: string,
    cwd: NormalizedPath,
    roots: NormalizedPath[],
): NormalizedPath | null {
    const trimmed = value.trim();
    if (!isValidPathText(trimmed)
        || /^[A-Za-z]:[^\\/]/.test(trimmed)
        || /^\\\\[?.]\\/.test(trimmed)
        || (/^(?:\\\\|\/\/)/.test(trimmed) && !isWindowsAbsolutePath(trimmed))
        || (cwd.flavor === "windows" && /^\\(?!\\)/.test(trimmed))
        || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
        return null;
    }

    let candidate: NormalizedPath;
    if (isWindowsAbsolutePath(trimmed)) {
        candidate = {value: path.win32.normalize(trimmed.replace(/\//g, "\\")), flavor: "windows"};
    } else if (path.posix.isAbsolute(trimmed)) {
        candidate = {value: path.posix.normalize(trimmed.replace(/\\/g, "/")), flavor: "posix"};
    } else if (cwd.flavor === "windows") {
        candidate = {
            value: path.win32.resolve(cwd.value, trimmed.replace(/\//g, "\\")),
            flavor: "windows",
        };
    } else {
        candidate = {
            value: path.posix.resolve(cwd.value, trimmed.replace(/\\/g, "/")),
            flavor: "posix",
        };
    }

    candidate = canonicalizeReportedPath(candidate);

    return roots.some(root => pathIsStrictlyInside(root, candidate)) ? candidate : null;
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
