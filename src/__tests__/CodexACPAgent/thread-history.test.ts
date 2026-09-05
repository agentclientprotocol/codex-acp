import {describe, expect, it, vi} from "vitest";
import type {Turn} from "../../app-server/v2";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";

function messageTurn(id: string): Turn {
    return {
        id,
        items: [{type: "userMessage", id: `${id}-input`, clientId: null, content: [{type: "text", text: `Question ${id}`, text_elements: []}]}, {type: "agentMessage", id: `${id}-message`, text: `Answer ${id}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null}],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

describe("paginated thread history", () => {
    it("loads every page in chronological order with complete messages", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const metadataRead = vi.spyOn(appServer, "threadRead").mockResolvedValue({
            thread: {id: "history", turns: [], name: "Saved conversation"} as any,
        });
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [messageTurn("third"), messageTurn("second")], nextCursor: "next-page", backwardsCursor: null})
            .mockResolvedValueOnce({data: [messageTurn("first")], nextCursor: null, backwardsCursor: "previous-page"});

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");

        await expect(JSON.stringify({
            reads: metadataRead.mock.calls,
            pages: pages.mock.calls,
            thread,
        }, null, 2)).toMatchFileSnapshot("data/paginated-thread-history.json");
    });

    it.each([
        {mode: "paginated", boundary: "resume-boundary", expectedIds: ["first", "second"]},
        {mode: "paginated", boundary: null, expectedIds: []},
        {mode: "legacy", boundary: null, expectedIds: ["first", "second", "new-after-resume"]},
    ] as const)("loads $mode history with resume boundary $boundary", async ({mode, boundary, expectedIds}) => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const client = fixture.getCodexAcpClient();
        vi.spyOn(appServer, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(appServer, "listModels").mockResolvedValue({data: [createTestModel({id: "gpt-5"})], nextCursor: null});
        vi.spyOn(appServer, "threadResume").mockResolvedValue({
            thread: {id: "history", historyMode: mode, name: "Resume metadata", turns: []},
            turnsBackwardsCursor: boundary,
            model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
        } as any);
        const read = vi.spyOn(appServer, "threadRead").mockResolvedValue({
            thread: {id: "history", historyMode: mode, name: "Later metadata", turns: []} as any,
        });
        const pages = vi.spyOn(appServer, "threadTurnsList").mockImplementation(async ({cursor, sortDirection, itemsView}) => {
            expect(sortDirection).toBe("desc");
            expect(itemsView).toBe("full");
            // Simulate a turn persisted after resume, before history is requested.
            if (cursor === null) return {data: [messageTurn("new-after-resume")], nextCursor: "resume-boundary", backwardsCursor: null};
            if (cursor === "resume-boundary") return {data: [messageTurn("second")], nextCursor: "older", backwardsCursor: null};
            if (cursor === "older") return {data: [messageTurn("first")], nextCursor: null, backwardsCursor: null};
            throw new Error("Unexpected cursor");
        });

        const loaded = await client.loadSession({sessionId: "history", cwd: "/workspace", mcpServers: []});

        expect(loaded.thread.turns.map(turn => turn.id)).toEqual(expectedIds);
        expect(loaded.thread.name).toBe(mode === "paginated" ? "Resume metadata" : "Later metadata");
        expect(read).toHaveBeenCalledTimes(mode === "paginated" ? 0 : 1);
        expect(pages).toHaveBeenCalledTimes(expectedIds.length);
    });

    it("does not include turns appended while standalone history is being paged", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        const stored = [messageTurn("first"), messageTurn("second")];
        vi.spyOn(appServer, "threadTurnsList").mockImplementation(async ({cursor, sortDirection}) => {
            expect(sortDirection).toBe("desc");
            const index = cursor === null ? stored.length - 1 : Number(cursor);
            const data = [stored[index]!];
            if (cursor === null) stored.push(messageTurn("appended-during-read"));
            return {data, nextCursor: index === 0 ? null : String(index - 1), backwardsCursor: null};
        });

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");
        expect(thread.turns.map(turn => turn.id)).toEqual(["first", "second"]);
        expect(stored).toHaveLength(3);
    });

    it("rejects a cursor that returns to the initial resume boundary", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [], nextCursor: "resume-boundary", backwardsCursor: null})
            .mockRejectedValue(new Error("Unexpected extra page request"));

        await expect(appServer.threadReadHistory("history", "resume-boundary"))
            .rejects.toThrow("Codex returned a repeated thread history cursor");
        expect(pages).toHaveBeenCalledTimes(1);
    });

    it("returns an empty history when the first page is empty", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "empty", turns: []} as any});
        const pages = vi.spyOn(appServer, "threadTurnsList").mockResolvedValue({data: [], nextCursor: null, backwardsCursor: null});

        expect(await fixture.getCodexAcpClient().readSessionThread("empty")).toEqual({id: "empty", turns: []});
        expect(pages).toHaveBeenCalledTimes(1);
    });

    it.each([
        {name: "repeated cursor", cursors: ["page-a", "page-a"]},
        {name: "cursor cycle", cursors: ["page-a", "page-b", "page-a"]},
    ])("rejects a $name before requesting another page", async ({cursors}) => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockRejectedValue(new Error("Unexpected extra page request"));
        for (const nextCursor of cursors) {
            pages.mockResolvedValueOnce({data: [], nextCursor, backwardsCursor: null});
        }

        await expect(fixture.getCodexAcpClient().readSessionThread("history"))
            .rejects.toThrow("Codex returned a repeated thread history cursor");
        expect(pages).toHaveBeenCalledTimes(cursors.length);
    });

    it("rejects an incomplete history if a later page fails", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [messageTurn("first")], nextCursor: "next-page", backwardsCursor: null})
            .mockRejectedValueOnce(new Error("History unavailable"));

        await expect(fixture.getCodexAcpClient().readSessionThread("history")).rejects.toThrow("History unavailable");
    });
});
