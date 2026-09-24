import {describe, expect, it, vi} from "vitest";
import type {ThreadItem, ThreadItemsListParams, ThreadTurnsListParams, Turn} from "../../app-server/v2";
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

/**
 * A fake of thread/turns/list over `stored`. A descending read without a
 * cursor starts at the newest turn, and the cursor `turn:<id>` starts at that
 * turn. An ascending read starts at the oldest turn.
 */
function turnStore(stored: Turn[], pageSize = 2) {
    return async ({cursor, limit, sortDirection}: ThreadTurnsListParams) => {
        if (sortDirection === "desc") {
            const index = cursor === null || cursor === undefined
                ? stored.length - 1
                : stored.findIndex(turn => `turn:${turn.id}` === cursor);
            const data = index < 0 ? [] : stored.slice(Math.max(0, index + 1 - (limit ?? 1)), index + 1).reverse();
            return {data: data.map(turn => ({...turn, items: [], itemsView: "notLoaded" as const})), nextCursor: null, backwardsCursor: null};
        }
        const start = cursor === null || cursor === undefined ? 0 : Number(cursor.slice("asc:".length));
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {data: stored.slice(start, end), nextCursor: end < stored.length ? `asc:${end}` : null, backwardsCursor: null};
    };
}

/**
 * A fake of thread/items/list over the items of `turns`. A descending read
 * without a cursor starts at the newest item, and the cursor `item:<id>`
 * starts at that item. An ascending read starts at the oldest item.
 */
function itemStore(turns: Turn[], pageSize = 2) {
    const entries = turns.flatMap(turn => turn.items.map(item => ({turnId: turn.id, item})));
    return async ({turnId, cursor, limit, sortDirection}: ThreadItemsListParams) => {
        const scoped = entries.filter(entry => !turnId || entry.turnId === turnId);
        if (sortDirection === "desc") {
            const index = cursor === null || cursor === undefined
                ? scoped.length - 1
                : scoped.findIndex(entry => `item:${entry.item.id}` === cursor);
            return {data: index < 0 ? [] : [scoped[index]!], nextCursor: null, backwardsCursor: null};
        }
        const start = cursor === null || cursor === undefined ? 0 : Number(cursor.slice("asc:".length));
        const end = start + Math.min(limit ?? pageSize, pageSize);
        return {data: scoped.slice(start, end), nextCursor: end < scoped.length ? `asc:${end}` : null, backwardsCursor: null};
    };
}

async function collect(history: AsyncIterable<ThreadItem[]> | null): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of history ?? []) ids.push(...page.map(item => item.id));
    return ids;
}

describe("paginated thread history", () => {
    it("loads every page in chronological order with complete messages", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const metadataRead = vi.spyOn(appServer, "threadRead").mockResolvedValue({
            thread: {id: "history", turns: [], name: "Saved conversation"} as any,
        });
        const pages = vi.spyOn(appServer, "threadTurnsList")
            .mockImplementation(turnStore([messageTurn("first"), messageTurn("second"), messageTurn("third")]));

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");

        await expect(JSON.stringify({
            reads: metadataRead.mock.calls,
            pages: pages.mock.calls,
            thread,
        }, null, 2)).toMatchFileSnapshot("data/paginated-thread-history.json");
    });

    it.each([
        {mode: "paginated", boundary: "item:second-message", expectedIds: ["first-input", "first-message", "second-input", "second-message"], pageCalls: 3},
        {mode: "paginated", boundary: null, expectedIds: [], pageCalls: 0},
        {mode: "legacy", boundary: null, expectedIds: ["first-input", "first-message", "second-input", "second-message", "new-after-resume-input", "new-after-resume-message"], pageCalls: 0},
    ] as const)("loads $mode history with resume boundary $boundary", async ({mode, boundary, expectedIds, pageCalls}) => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const client = fixture.getCodexAcpClient();
        const stored = ["first", "second", "new-after-resume"].map(messageTurn);
        vi.spyOn(appServer, "skillsExtraRootsSet").mockResolvedValue(undefined);
        vi.spyOn(appServer, "listSkills").mockResolvedValue({data: []});
        vi.spyOn(appServer, "listModels").mockResolvedValue({data: [createTestModel({id: "gpt-5"})], nextCursor: null});
        vi.spyOn(appServer, "threadResume").mockResolvedValue({
            thread: {id: "history", historyMode: mode, name: "Resume metadata", turns: []},
            itemsBackwardsCursor: boundary,
            model: "gpt-5", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null,
        } as any);
        const read = vi.spyOn(appServer, "threadRead").mockImplementation(async ({includeTurns}) => ({
            thread: {
                id: "history", historyMode: mode, name: "Later metadata",
                turns: includeTurns ? stored : [],
            } as any,
        }));
        // A turn persisted after resume, before history is requested, is after the boundary.
        const pages = vi.spyOn(appServer, "threadItemsList").mockImplementation(itemStore(stored));

        const loaded = await client.loadSession({sessionId: "history", cwd: "/workspace", mcpServers: []});

        expect(loaded.thread.turns).toEqual([]);
        expect(await collect(loaded.history)).toEqual(expectedIds);
        expect(loaded.thread.name).toBe(mode === "paginated" ? "Resume metadata" : "Later metadata");
        expect(read.mock.calls).toEqual(mode === "paginated" ? [] : [
            [{threadId: "history"}],
            [{threadId: "history", includeTurns: true}],
        ]);
        expect(pages).toHaveBeenCalledTimes(pageCalls);
    });

    it("fails a history page that Codex does not answer instead of waiting forever", async () => {
        vi.useFakeTimers();
        try {
            const fixture = createCodexMockTestFixture();
            const appServer = fixture.getCodexAppServerClient();
            vi.spyOn(appServer, "threadItemsList").mockReturnValue(new Promise(() => {}));

            const pages = appServer.threadItemPages("history")[Symbol.asyncIterator]();
            const next = expect(pages.next()).rejects.toThrow("Codex did not answer thread/items/list for thread history within 60 s");
            await vi.advanceTimersByTimeAsync(60_000);
            await next;
        } finally {
            vi.useRealTimers();
        }
    });

    it("pages the items of one large turn", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const turn = messageTurn("large");
        turn.items = Array.from({length: 7}, (_, index) => ({...turn.items[1]!, id: `message-${index}`}));
        const pages = vi.spyOn(appServer, "threadItemsList").mockImplementation(itemStore([turn], 3));

        const received: number[] = [];
        for await (const page of appServer.threadItemPages("history")) received.push(page.length);

        expect(received).toEqual([3, 3, 1]);
        expect(pages).toHaveBeenCalledTimes(4);
    });

    it("reads standalone legacy history without requiring a pagination API", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const history = {id: "legacy", historyMode: "legacy", turns: [messageTurn("first"), messageTurn("second")]};
        const read = vi.spyOn(appServer, "threadRead")
            .mockResolvedValueOnce({thread: {...history, turns: []} as any})
            .mockResolvedValueOnce({thread: history as any});
        const pages = vi.spyOn(appServer, "threadTurnsList").mockRejectedValue(new Error("Method not found"));

        expect(await fixture.getCodexAcpClient().readSessionThread("legacy")).toEqual(history);
        expect(read.mock.calls).toEqual([
            [{threadId: "legacy"}],
            [{threadId: "legacy", includeTurns: true}],
        ]);
        expect(pages).not.toHaveBeenCalled();
    });

    it("does not include turns appended while standalone history is being paged", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        const stored = [messageTurn("first"), messageTurn("second")];
        const store = turnStore(stored, 1);
        vi.spyOn(appServer, "threadTurnsList").mockImplementation(async (params) => {
            const page = await store(params);
            if (params.sortDirection === "desc") stored.push(messageTurn("appended-during-read"));
            return page;
        });

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");
        expect(thread.turns.map(turn => turn.id)).toEqual(["first", "second"]);
        expect(stored).toHaveLength(3);
    });

    it("reads the items of one turn of a child session", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        const stored = ["one", "two", "three", "four", "five"].map(messageTurn);
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "child", turns: []} as any});
        const turnPages = vi.spyOn(appServer, "threadTurnsList").mockImplementation(turnStore(stored, 2));
        vi.spyOn(appServer, "threadItemsList").mockImplementation(itemStore(stored));

        const client = fixture.getCodexAcpClient();
        expect(await collect(await client.readSessionTurnItems("child", 2))).toEqual(["three-input", "three-message"]);
        // The second page of turns holds the third turn; the third page is never read.
        expect(turnPages).toHaveBeenCalledTimes(2);
        expect(await client.readSessionTurnItems("child", 5)).toBeNull();
    });

    it("returns an empty history when the thread has no turns", async () => {
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
            .mockRejectedValue(new Error("Unexpected extra page request"))
            .mockResolvedValueOnce({data: [messageTurn("last")], nextCursor: null, backwardsCursor: null});
        for (const nextCursor of cursors) {
            pages.mockResolvedValueOnce({data: [], nextCursor, backwardsCursor: null});
        }

        await expect(fixture.getCodexAcpClient().readSessionThread("history"))
            .rejects.toThrow("Codex returned a repeated thread history cursor");
        expect(pages).toHaveBeenCalledTimes(cursors.length + 1);
    });

    it("rejects an incomplete history if a later page fails", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "history", turns: []} as any});
        vi.spyOn(appServer, "threadTurnsList")
            .mockResolvedValueOnce({data: [messageTurn("last")], nextCursor: null, backwardsCursor: null})
            .mockResolvedValueOnce({data: [messageTurn("first")], nextCursor: "next-page", backwardsCursor: null})
            .mockRejectedValueOnce(new Error("History unavailable"));

        await expect(fixture.getCodexAcpClient().readSessionThread("history")).rejects.toThrow("History unavailable");
    });
});
