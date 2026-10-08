import {describe, expect, it, vi} from "vitest";
import {searchSessions, sessionAttachments, sessionAttachmentsParser, sessionSearchParser, type SessionDiscoveryClient} from "../SessionDiscovery";
import type {Thread} from "../app-server/v2";

describe("native session discovery", () => {
    it("rejects invalid search ranges and arbitrary native parameters", () => {
        for (const p of [{searchTerm: " "}, {searchTerm: "x", limit: 0}, {searchTerm: "x", limit: 101}, {searchTerm: "x", method: "thread/delete"}]) {
            expect(sessionSearchParser.safeParse(p).success).toBe(false);
        }
    });
    it("preserves the native cursor and snippet without leaking runtime config", async () => {
        const native = {threadSearch: vi.fn(async () => ({data: [{thread: {id: "s", cwd: "/work", name: "name", updatedAt: 42, modelProvider: "private-config"} as Thread, snippet: "match"}], nextCursor: "opaque"}))};
        expect(await searchSessions(native, {searchTerm: "match", archived: true, limit: 20})).toEqual({version: 1, sessions: [{sessionId: "s", cwd: "/work", title: "name", updatedAt: 42, snippet: "match"}], nextCursor: "opaque"});
        expect(native.threadSearch).toHaveBeenCalledWith({searchTerm: "match", archived: true, limit: 20});
    });
    it("bounds attachment metadata and rejects extra destinations", () => {
        const base = {sessionId: "s", action: "add", attachmentType: "pull_request", identityKey: "https://example.test/pr/1"};
        expect(sessionAttachmentsParser.safeParse({...base, payload: {title: "PR"}}).success).toBe(true);
        expect(sessionAttachmentsParser.safeParse({...base, payload: "x".repeat(256 * 1024)}).success).toBe(false);
        expect(sessionAttachmentsParser.safeParse({...base, payload: {}, threadId: "other"}).success).toBe(false);
    });
    it("uses the checked session identity for every attachment operation", async () => {
        const add = vi.fn(async () => ({outcome: "created", attachment: {id: "a"}}));
        const native = {threadAttachmentAdd: add} as unknown as SessionDiscoveryClient;
        const request = {sessionId: "s", action: "add" as const, attachmentType: "pull_request", identityKey: "url", payload: {url: "https://example.test/pr/1"}};
        await expect(sessionAttachments(native, "other", request)).rejects.toThrow("Session mismatch");
        expect(add).not.toHaveBeenCalled();
        await sessionAttachments(native, "s", request);
        expect(add).toHaveBeenCalledWith({threadId: "s", attachmentType: "pull_request", identityKey: "url", payload: request.payload});
    });
});
