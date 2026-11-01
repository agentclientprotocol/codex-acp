import {describe, expect, it} from "vitest";
import {connectSession, createThread} from "./v2-prompt-harness";

describe.each(([1, 2] as const).flatMap(version =>
    (["plain", "index"] as const).map(profile => ({version, profile})),
))("ACP v$version $profile session list filters", ({version, profile}) => {
    const air = {_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}};
    const connect = () => connectSession(version, profile === "index"
        ? {clientCapabilities: air, v1ClientCapabilities: air} : {});

    it.each(["/workspace/project ", "/workspace/project\t"])("does not trim the exact directory %j", async cwd => {
        const h = await connect();
        const filters: unknown[] = [];
        h.setCodexResponse("thread/list", async params => {
            const filter = (params as {cwd: unknown}).cwd;
            filters.push(filter);
            const rows = [
                {...createThread(), id: "exact", cwd},
                {...createThread(), id: "trimmed", cwd: cwd.trim()},
                {...createThread(), id: "descendant", cwd: `${cwd}/subdir`},
            ];
            return {data: profile === "index" ? rows.filter(row => row.cwd === filter) : rows, nextCursor: null};
        });
        try {
            const result = await h.request("session/list", {cwd});
            expect(filters).toEqual([profile === "index" ? cwd : undefined]);
            expect(result.sessions.map((session: {cwd: string}) => session.cwd)).toEqual([cwd]);
        } finally {
            h.connection.close();
        }
    });

    it("passes an empty native cursor through instead of treating it as exhaustion", async () => {
        const h = await connect();
        const cursors: Array<string | null> = [];
        h.setCodexResponse("thread/list", async params => {
            cursors.push((params as {cursor: string | null}).cursor);
            return {data: [], nextCursor: cursors.length === 1 ? "" : null};
        });
        try {
            const first = await h.request("session/list", {});
            if (profile === "plain") {
                expect(first).toEqual({sessions: [], nextCursor: ""});
                expect(await h.request("session/list", {cursor: first.nextCursor})).toEqual({sessions: [], nextCursor: null});
            } else {
                expect(first).toEqual({sessions: [], nextCursor: null});
            }
            expect(cursors).toEqual([null, ""]);
        } finally {
            h.connection.close();
        }
    });
});
