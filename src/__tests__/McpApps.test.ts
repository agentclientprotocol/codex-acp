import {describe, expect, it} from "vitest";
import type {ThreadItem} from "../app-server/v2";
import {
    clientSupportsMcpApps,
    MAX_TOOL_RESULT_CHARS,
    mcpAppToolCallMeta,
    mcpResourcesReadParamsParser,
    mcpToolsCallParamsParser,
    refuseCheckedCall,
    toCallToolResult,
} from "../McpApps";
import {AcpToolCallRenderer} from "../tool-calls/AcpToolCallRenderer";
import {ClientCapabilities} from "../tool-calls/ClientCapabilities";
import {McpToolReporter} from "../tool-calls/reporters/McpToolReporter";

type McpToolCallItem = ThreadItem & {type: "mcpToolCall"};

function appCall(overrides: Partial<McpToolCallItem> = {}): McpToolCallItem {
    return {
        type: "mcpToolCall", id: "call-1", server: "basic", environmentId: null, tool: "get-time",
        status: "completed", arguments: {}, appContext: null,
        mcpAppUi: {resourceUri: "ui://get-time/app.html", preferredModelDisplayMode: "inline"},
        pluginId: null, readOnlyHint: null, durationMs: 1,
        result: {content: [{type: "text", text: "12:00"}], structuredContent: {time: "12:00"}, _meta: null},
        error: null,
        ...overrides,
    } as McpToolCallItem;
}

const withApps = {_meta: {mcpApps: {version: 1}}};

describe("MCP Apps", () => {
    it("needs a client capability with a version of at least 1", () => {
        expect(clientSupportsMcpApps(withApps)).toBe(true);
        expect(clientSupportsMcpApps({_meta: {mcpApps: {version: 0}}})).toBe(false);
        expect(clientSupportsMcpApps({_meta: {mcpApps: true}})).toBe(false);
        expect(clientSupportsMcpApps(undefined)).toBe(false);
    });

    it("describes a finished app tool call", () => {
        expect(mcpAppToolCallMeta(appCall())).toEqual({
            version: 1,
            server: "basic",
            tool: "get-time",
            resourceUri: "ui://get-time/app.html",
            toolResult: {content: [{type: "text", text: "12:00"}], structuredContent: {time: "12:00"}},
        });
    });

    it("takes the older flat resource field, and the error of a failed call", () => {
        const failed = appCall({
            mcpAppUi: null, mcpAppResourceUri: "ui://old", status: "failed", result: null, error: {message: "boom"},
        });
        expect(mcpAppToolCallMeta(failed)).toMatchObject({
            resourceUri: "ui://old",
            toolResult: {content: [{type: "text", text: "boom"}], isError: true},
        });
    });

    it("says nothing of a running call, a tool without a ui:// resource, or a result that is too long", () => {
        expect(mcpAppToolCallMeta(appCall({status: "inProgress", result: null}))).toBeUndefined();
        expect(mcpAppToolCallMeta(appCall({mcpAppUi: null}))).toBeUndefined();
        expect(mcpAppToolCallMeta(appCall({
            mcpAppUi: {resourceUri: "https://x", preferredModelDisplayMode: "inline"},
        }))).toBeUndefined();
        const long = appCall({result: {content: [{type: "text", text: "x".repeat(MAX_TOOL_RESULT_CHARS)}], structuredContent: null, _meta: null}});
        expect(mcpAppToolCallMeta(long)).not.toHaveProperty("toolResult");
    });

    it("sends _meta.mcpApp only to a client that declared mcpApps, on v1 and v2", () => {
        const facts = McpToolReporter.completed(appCall());
        for (const capabilities of [ClientCapabilities.from(withApps), ClientCapabilities.fromV2(withApps)]) {
            expect(new AcpToolCallRenderer(capabilities).render(facts)._meta?.["mcpApp"]).toMatchObject({tool: "get-time"});
        }
        for (const capabilities of [ClientCapabilities.from({}), ClientCapabilities.fromV2({})]) {
            expect(new AcpToolCallRenderer(capabilities).render(facts)._meta?.["mcpApp"]).toBeUndefined();
        }
    });

    it("puts _meta.mcpApp on the start report of a replayed call", () => {
        const rendered = new AcpToolCallRenderer(ClientCapabilities.from(withApps)).render(McpToolReporter.started(appCall()));
        expect(rendered.sessionUpdate).toBe("tool_call");
        expect(rendered._meta?.["mcpApp"]).toMatchObject({resourceUri: "ui://get-time/app.html"});
    });

    it("reads only ui:// resources and checks tool call params", () => {
        expect(mcpResourcesReadParamsParser.safeParse({sessionId: "s", server: "a", uri: "ui://x"}).success).toBe(true);
        expect(mcpResourcesReadParamsParser.safeParse({sessionId: "s", server: "a", uri: "file:///etc/hosts"}).success).toBe(false);
        expect(mcpToolsCallParamsParser.safeParse({sessionId: "s", server: "a", name: "t", arguments: []}).success).toBe(false);
        expect(mcpToolsCallParamsParser.safeParse({sessionId: "s", server: "a", name: "t", checkPermissions: "y"}).success).toBe(false);
    });

    it("refuses a call that asks for a permission check", () => {
        expect(() => refuseCheckedCall({sessionId: "s", server: "a", name: "t", checkPermissions: true})).toThrow(/permissions/);
        expect(() => refuseCheckedCall({sessionId: "s", server: "a", name: "t"})).not.toThrow();
    });

    it("keeps a tool call response without its null fields", () => {
        expect(toCallToolResult({content: [], structuredContent: null, isError: true, _meta: null})).toEqual({content: [], isError: true});
    });
});
