import {describe, expect, it, vi} from "vitest";
import {controlRuntime, readRuntime, runtimeControlParser, runtimeReadParser, type RuntimeSession} from "../SessionRuntime";

const session: RuntimeSession = {
    sessionId: "s", cwd: "/workspace", additionalDirectories: ["/extra"], currentModelId: "m",
    lastTokenUsage: null, totalTokenUsage: null, modelContextWindow: null, rateLimits: null,
};
const client = () => ({
    listSkills: vi.fn(async () => ({data: []})),
    listMcpServers: vi.fn(async () => ({data: [], nextCursor: null})),
    installedPlugins: vi.fn(async () => ({marketplaces: [], marketplaceLoadErrors: []})),
    reconcilePlugins: vi.fn(async () => ({changedPlugins: [], failedRemotePluginIds: [], failedMaterializationRemotePluginIds: []})),
    reloadMcpServers: vi.fn(async () => {}),
});
describe("runtime extension", () => {
    it("rejects arbitrary methods, extra native parameters and missing identity", () => {
        for (const input of [{sessionId: "s", resource: "config"}, {resource: "mcp"}, {sessionId: "s", resource: "mcp", threadId: "other"}]) {
            expect(runtimeReadParser.safeParse(input).success).toBe(false);
        }
        expect(runtimeControlParser.safeParse({sessionId: "s", action: "delete"}).success).toBe(false);
    });
    it("preserves unavailable context measurements as null", async () => {
        const result = await readRuntime(client(), session, {sessionId: "s", resource: "context"}, new AbortController().signal);
        expect(result).toMatchObject({data: {totalTokens: null, maxTokens: null, categories: null}});
    });
    it("refreshes skills for the actual session roots", async () => {
        const native = client();
        await controlRuntime(native, session, {sessionId: "s", action: "reloadSkills"});
        expect(native.listSkills).toHaveBeenCalledWith({cwds: ["/workspace", "/extra"], forceReload: true});
    });
    it("does not claim MCP readiness from a reload acknowledgement", async () => {
        const native = client();
        expect(await controlRuntime(native, session, {sessionId: "s", action: "reconnectMcp"})).toMatchObject({data: {scope: "provider", connectionsReady: false}});
        expect(native.reloadMcpServers).toHaveBeenCalledOnce();
    });
    it("rejects mismatched sessions before the native call", async () => {
        const native = client();
        await expect(controlRuntime(native, session, {sessionId: "other", action: "reloadSkills"})).rejects.toThrow("Session mismatch");
        expect(native.listSkills).not.toHaveBeenCalled();
    });
    it("does not start a cancelled status read", async () => {
        const native = client(); const abort = new AbortController(); abort.abort();
        expect(await readRuntime(native, session, {sessionId: "s", resource: "commands"}, abort.signal)).toMatchObject({reason: "cancelled"});
        expect(native.listSkills).not.toHaveBeenCalled();
    });
    it("does not publish the old provider's answer after replacement", async () => {
        const native = client(); let current = true;
        native.listSkills.mockImplementation(async () => {current = false; return {data: []};});
        expect(await readRuntime(native, session, {sessionId: "s", resource: "commands"}, new AbortController().signal, () => current)).toMatchObject({reason: "stale"});
    });
});
