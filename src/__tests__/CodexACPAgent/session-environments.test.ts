import {describe, expect, it, vi} from "vitest";
import {connectSession, cwd} from "./v2-prompt-harness";

describe.each([1, 2] as const)("ACP v%s session environments", version => {
    it.each([
        {name: "selected", snapshot: "selected", meta: {environments: [
            {environmentId: "devbox", cwd: "/remote/project", runtimeWorkspaceRoots: ["/ignored"], extra: true},
            {environmentId: "windows", cwd: "C:\\workspace"},
        ]}},
        {name: "empty", snapshot: "empty", meta: {environments: []}},
        {name: "omitted metadata", snapshot: "absent", meta: undefined},
        {name: "null metadata", snapshot: "absent", meta: null},
        {name: "unrelated metadata", snapshot: "absent", meta: {other: true}},
        {name: "null environments", snapshot: "absent", meta: {environments: null}},
    ])("forwards $name environments", async ({meta, snapshot}) => {
        const h = await connectSession(version);
        try {
            const threadStart = vi.spyOn(h.appServer, "threadStart");
            await h.request("session/new", {cwd, mcpServers: [], ...(meta !== undefined && {_meta: meta})});
            expect(threadStart).toHaveBeenCalledOnce();
            await expect(JSON.stringify(threadStart.mock.calls[0]![0], null, 2) + "\n")
                .toMatchFileSnapshot(`data/session-environments-${snapshot}.json`);
        } finally { h.connection.close(); }
    });

    it.each([
        {name: "a non-array", environments: {}},
        {name: "a null entry", environments: [null]},
        {name: "a string entry", environments: ["devbox"]},
        {name: "an array entry", environments: [[]]},
        {name: "a missing environmentId", environments: [{cwd: "/remote"}]},
        {name: "a non-string environmentId", environments: [{environmentId: 1, cwd: "/remote"}]},
        {name: "an empty environmentId", environments: [{environmentId: " ", cwd: "/remote"}]},
        {name: "a missing cwd", environments: [{environmentId: "devbox"}]},
        {name: "a non-string cwd", environments: [{environmentId: "devbox", cwd: null}]},
        {name: "an empty cwd", environments: [{environmentId: "devbox", cwd: ""}]},
    ])("rejects $name before starting a thread", async ({environments}) => {
        const h = await connectSession(version);
        try {
            const threadStart = vi.spyOn(h.appServer, "threadStart");
            await expect(h.request("session/new", {cwd, mcpServers: [], _meta: {environments}}))
                .rejects.toMatchObject({code: -32602});
            expect(threadStart).not.toHaveBeenCalled();
        } finally { h.connection.close(); }
    });
});
