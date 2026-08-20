import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";

import {CodexAppServerClient} from "../../CodexAppServerClient";
import type {DynamicToolCallParams, DynamicToolCallResponse} from "../../app-server/v2";
import {
    handleDynamicToolCall,
    LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME,
} from "../../WorkspaceDependencies";

describe("workspace dependencies", () => {
    const runtimeRoots: Array<string> = [];

    afterEach(() => {
        vi.restoreAllMocks();
        for (const runtimeRoot of runtimeRoots.splice(0)) {
            fs.rmSync(runtimeRoot, {recursive: true, force: true});
        }
    });

    it("returns validated bundled runtime paths", async () => {
        const runtimeRoot = createRuntime("darwin");

        const response = handleDynamicToolCall(dynamicToolParams(), {runtimeRoot, platform: "darwin"});
        const snapshot = `${JSON.stringify(response, null, 2).replaceAll(runtimeRoot, "<runtime>")}\n`;

        await expect(snapshot).toMatchFileSnapshot("data/workspace-dependencies-success.json");
    });

    it("resolves Windows executable names and bundled Git", () => {
        const runtimeRoot = createRuntime("win32");

        const response = handleDynamicToolCall(dynamicToolParams(), {runtimeRoot, platform: "win32"});
        const text = response.contentItems[0]?.type === "inputText"
            ? response.contentItems[0].text
            : "";

        expect(response.success).toBe(true);
        expect(text).toContain(path.join("dependencies", "node", "bin", "node.exe"));
        expect(text).toContain(path.join("dependencies", "python", "python.exe"));
        expect(text).toContain(path.join("dependencies", "bin", "fallback", "pnpm.cmd"));
        expect(text).toContain(path.join("dependencies", "native", "git", "cmd", "git.exe"));
    });

    it("returns a useful failure when a required runtime executable is missing", () => {
        const runtimeRoot = createRuntime("darwin");
        fs.unlinkSync(path.join(runtimeRoot, "dependencies", "node", "bin", "node"));

        const response = handleDynamicToolCall(dynamicToolParams(), {runtimeRoot, platform: "darwin"});

        expect(response).toEqual({
            contentItems: [{
                type: "inputText",
                text: expect.stringContaining("Failed to load workspace dependency runtime details"),
            }],
            success: false,
        });
    });

    it("rejects unsupported tools and arguments", () => {
        expect(handleDynamicToolCall(dynamicToolParams({tool: "unknown_tool"}))).toEqual({
            contentItems: [{type: "inputText", text: "Unsupported dynamic tool: unknown_tool"}],
            success: false,
        });
        expect(handleDynamicToolCall(dynamicToolParams({arguments: {unexpected: true}}))).toEqual({
            contentItems: [{
                type: "inputText",
                text: `${LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME} takes no arguments.`,
            }],
            success: false,
        });
    });

    it("registers the app-server dynamic tool request handler", async () => {
        const requestHandlers = new Map<string, (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>>();
        const connection = {
            onUnhandledNotification: vi.fn(),
            onRequest: vi.fn((requestType: {method: string}, handler: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>) => {
                requestHandlers.set(requestType.method, handler);
            }),
        } as unknown as MessageConnection;
        new CodexAppServerClient(connection);

        const handler = requestHandlers.get("item/tool/call");

        expect(handler).toBeDefined();
        await expect(handler?.(dynamicToolParams({tool: "unknown_tool"}))).resolves.toEqual({
            contentItems: [{type: "inputText", text: "Unsupported dynamic tool: unknown_tool"}],
            success: false,
        });
    });

    function createRuntime(platform: NodeJS.Platform): string {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-workspace-dependencies-"));
        runtimeRoots.push(runtimeRoot);
        const dependenciesRoot = path.join(runtimeRoot, "dependencies");
        const fallbackBinPath = path.join(dependenciesRoot, "bin", "fallback");
        const overrideBinPath = path.join(dependenciesRoot, "bin", "override");
        const nodeRoot = path.join(dependenciesRoot, "node");
        const pythonRoot = path.join(dependenciesRoot, "python");
        for (const directory of [
            fallbackBinPath,
            overrideBinPath,
            path.join(nodeRoot, "bin"),
            path.join(nodeRoot, "node_modules"),
            path.join(pythonRoot, "bin"),
        ]) {
            fs.mkdirSync(directory, {recursive: true});
        }
        fs.writeFileSync(path.join(runtimeRoot, "runtime.json"), JSON.stringify({
            bundleFormatVersion: 2,
            bundleVersion: "test-bundle",
            nativeDependencies: ["git"],
            pnpmVersion: "test-pnpm",
        }));
        if (platform === "win32") {
            writeExecutable(path.join(nodeRoot, "bin", "node.exe"));
            writeExecutable(path.join(pythonRoot, "python.exe"));
            writeExecutable(path.join(fallbackBinPath, "pnpm.cmd"));
            writeExecutable(path.join(dependenciesRoot, "native", "git", "cmd", "git.exe"));
        } else {
            writeExecutable(path.join(nodeRoot, "bin", "node"));
            writeExecutable(path.join(pythonRoot, "bin", "python3"));
            writeExecutable(path.join(fallbackBinPath, "pnpm"));
            writeExecutable(path.join(fallbackBinPath, "git"));
        }
        return runtimeRoot;
    }
});

function dynamicToolParams(overrides: Partial<DynamicToolCallParams> = {}): DynamicToolCallParams {
    return {
        threadId: "thread-id",
        turnId: "turn-id",
        callId: "call-id",
        namespace: null,
        tool: LOAD_WORKSPACE_DEPENDENCIES_TOOL_NAME,
        arguments: {},
        ...overrides,
    };
}

function writeExecutable(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, "test executable");
    fs.chmodSync(filePath, 0o755);
}
