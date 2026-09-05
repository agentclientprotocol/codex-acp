import {describe, expect, it, vi} from "vitest";
import type {Turn} from "../../app-server/v2";
import {createCodexMockTestFixture} from "../acp-test-utils";

function messageTurn(id: string): Turn {
    return {
        id,
        items: [{type: "agentMessage", id: `${id}-message`, text: `Answer ${id}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null}],
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
            .mockResolvedValueOnce({data: [messageTurn("first")], nextCursor: "next-page", backwardsCursor: null})
            .mockResolvedValueOnce({data: [messageTurn("second")], nextCursor: null, backwardsCursor: "previous-page"});

        const thread = await fixture.getCodexAcpClient().readSessionThread("history");

        await expect(JSON.stringify({
            reads: metadataRead.mock.calls,
            pages: pages.mock.calls,
            thread,
        }, null, 2)).toMatchFileSnapshot("data/paginated-thread-history.json");
    });

    it("returns an empty history when the first page is empty", async () => {
        const fixture = createCodexMockTestFixture();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "threadRead").mockResolvedValue({thread: {id: "empty", turns: []} as any});
        const pages = vi.spyOn(appServer, "threadTurnsList").mockResolvedValue({data: [], nextCursor: null, backwardsCursor: null});

        expect(await fixture.getCodexAcpClient().readSessionThread("empty")).toEqual({id: "empty", turns: []});
        expect(pages).toHaveBeenCalledTimes(1);
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
