import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {DynamicToolCallParams, DynamicToolCallResponse} from "./app-server/v2";

export const LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME = "load_workspace_dependencies";

interface RuntimeMetadata {
    bundleFormatVersion?: number;
    bundleVersion?: string;
    nativeDependencies?: Array<string>;
    pnpmVersion?: string;
}

export interface WorkspaceDependencyOptions {
    platform?: NodeJS.Platform;
    runtimeRoot?: string;
}

interface WorkspaceDependencyPaths {
    fallbackBinPath: string;
    gitPath: string | null;
    nodeModulesPath: string;
    nodePath: string;
    overrideBinPath: string;
    pnpmPath: string | null;
    pythonLibrariesPath: string;
    pythonPath: string;
}

export function handleDynamicToolCall(
    params: DynamicToolCallParams,
    options: WorkspaceDependencyOptions = {},
): DynamicToolCallResponse {
    if (params.namespace !== null || params.tool !== LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME) {
        return failure(`Unsupported dynamic tool: ${params.tool}`);
    }
    if (!isEmptyObject(params.arguments)) {
        return failure(`${LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME} takes no arguments.`);
    }

    try {
        return loadWorkspaceDependencies(options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`Failed to load workspace dependency runtime details: ${message}`);
    }
}

export function loadWorkspaceDependencies(
    options: WorkspaceDependencyOptions = {},
): DynamicToolCallResponse {
    const platform = options.platform ?? process.platform;
    const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
    const metadata = readRuntimeMetadata(runtimeRoot);
    const paths = resolveWorkspaceDependencyPaths(runtimeRoot, metadata, platform);
    validateWorkspaceDependencyPaths(paths);

    return {
        contentItems: [{
            type: "inputText",
            text: [
                "Workspace dependencies are available for this local thread.",
                formatInstructions(paths, metadata.bundleVersion),
            ].join("\n\n"),
        }],
        success: true,
    };
}

function defaultRuntimeRoot(): string {
    return path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime");
}

function readRuntimeMetadata(runtimeRoot: string): RuntimeMetadata {
    const metadataPath = path.join(runtimeRoot, "runtime.json");
    const value: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!isObject(value)) {
        throw new Error(`Invalid workspace dependency metadata at ${metadataPath}`);
    }
    const bundleFormatVersion = value["bundleFormatVersion"];
    const bundleVersion = value["bundleVersion"];
    const nativeDependencies = value["nativeDependencies"];
    const pnpmVersion = value["pnpmVersion"];
    return {
        ...(typeof bundleFormatVersion === "number"
            ? {bundleFormatVersion}
            : {}),
        ...(typeof bundleVersion === "string" ? {bundleVersion} : {}),
        ...(Array.isArray(nativeDependencies)
            ? {nativeDependencies: nativeDependencies.filter(item => typeof item === "string")}
            : {}),
        ...(typeof pnpmVersion === "string" ? {pnpmVersion} : {}),
    };
}

function resolveWorkspaceDependencyPaths(
    runtimeRoot: string,
    metadata: RuntimeMetadata,
    platform: NodeJS.Platform,
): WorkspaceDependencyPaths {
    const bundleFormatVersion = metadata.bundleFormatVersion ?? 1;
    const dependenciesRoot = path.join(runtimeRoot, "dependencies");
    const binPath = path.join(dependenciesRoot, "bin");
    const fallbackBinPath = path.join(binPath, "fallback");
    const overrideBinPath = path.join(binPath, "override");
    const nodeRoot = bundleFormatVersion >= 2
        ? path.join(dependenciesRoot, "node")
        : runtimeRoot;
    const pythonRoot = bundleFormatVersion >= 2
        ? path.join(dependenciesRoot, "python")
        : path.join(runtimeRoot, "python");
    const windows = platform === "win32";
    const nodePath = path.join(nodeRoot, "bin", windows ? "node.exe" : "node");
    const pythonPath = firstAccessible(windows
        ? [
            path.join(pythonRoot, "python.exe"),
            path.join(pythonRoot, "python", "python.exe"),
            path.join(pythonRoot, "bin", "python.exe"),
        ]
        : [
            path.join(pythonRoot, "bin", "python3"),
            path.join(pythonRoot, "bin", "python"),
        ]);
    const pnpmName = windows ? "pnpm.cmd" : "pnpm";
    const pnpmPath = metadata.pnpmVersion == null
        ? null
        : firstAccessible([
            path.join(fallbackBinPath, pnpmName),
            path.join(binPath, pnpmName),
        ]);
    const gitPath = metadata.nativeDependencies?.includes("git") === true
        ? firstAccessible(windows
            ? [path.join(dependenciesRoot, "native", "git", "cmd", "git.exe")]
            : [path.join(fallbackBinPath, "git"), path.join(binPath, "git")])
        : null;

    return {
        fallbackBinPath,
        gitPath,
        nodeModulesPath: path.join(nodeRoot, "node_modules"),
        nodePath,
        overrideBinPath,
        pnpmPath,
        pythonLibrariesPath: pythonPackageRoot(pythonPath),
        pythonPath,
    };
}

function firstAccessible(candidates: Array<string>): string {
    const candidate = candidates.find(value => {
        try {
            fs.accessSync(value);
            return true;
        } catch {
            return false;
        }
    });
    return candidate ?? candidates[0] ?? "";
}

function pythonPackageRoot(pythonPath: string): string {
    const parent = path.dirname(pythonPath);
    return path.basename(parent) === "bin" ? path.dirname(parent) : parent;
}

function validateWorkspaceDependencyPaths(paths: WorkspaceDependencyPaths): void {
    for (const executable of [paths.gitPath, paths.nodePath, paths.pnpmPath, paths.pythonPath]) {
        if (executable != null) {
            fs.accessSync(executable, fs.constants.X_OK);
        }
    }
    for (const directory of [
        paths.nodeModulesPath,
        paths.pythonLibrariesPath,
        paths.overrideBinPath,
        paths.fallbackBinPath,
    ]) {
        if (!fs.statSync(directory).isDirectory()) {
            throw new Error(`Expected a directory at ${directory}`);
        }
    }
}

function formatInstructions(paths: WorkspaceDependencyPaths, bundleVersion?: string): string {
    const lines = [
        "### Workspace Dependencies",
        "Use these bundled paths for sheets, slides, documents, PDFs, images, or browser automation:",
    ];
    if (bundleVersion != null) {
        lines.push(`- Bundle version: ${quote(bundleVersion)}`);
    }
    if (paths.gitPath != null) {
        lines.push(`- Git executable: ${quote(paths.gitPath)}`);
    }
    lines.push(`- Node.js executable: ${quote(paths.nodePath)}`);
    lines.push(`- Node.js packages: ${quote(paths.nodeModulesPath)}`);
    if (paths.pnpmPath != null) {
        lines.push(`- pnpm executable: ${quote(paths.pnpmPath)}`);
    }
    lines.push(`- Python executable: ${quote(paths.pythonPath)}`);
    lines.push(`- Python packages: ${quote(paths.pythonLibrariesPath)}`);
    lines.push(`- Override binaries: ${quote(paths.overrideBinPath)}`);
    lines.push(`- Fallback binaries: ${quote(paths.fallbackBinPath)}`);
    return lines.join("\n");
}

function quote(value: string): string {
    return `\`${value.replaceAll("`", "\\`")}\``;
}

function failure(message: string): DynamicToolCallResponse {
    return {
        contentItems: [{type: "inputText", text: message}],
        success: false,
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
    return isObject(value) && Object.keys(value).length === 0;
}
