import {describe, expect, it} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {createRecoveryFixture, initialize, requestsOf} from "./recovery-fixture";

async function setup() {
    const fixture = createRecoveryFixture();
    await initialize(fixture);
    const {sessionId} = await fixture.agent.newSession({cwd: "/work", mcpServers: []});
    return {...fixture, sessionId};
}

describe("session extensions after an app-server crash", () => {
    it("restores the session before runtime reads and refreshes", async () => {
        const fixture = await setup();
        const old = fixture.current();
        await fixture.kill();
        await expect(fixture.agent.readSessionRuntime({sessionId: fixture.sessionId, resource: "commands"}))
            .resolves.toMatchObject({status: "ok", data: {data: []}});
        await expect(fixture.agent.controlSessionRuntime({sessionId: fixture.sessionId, action: "reloadSkills"}))
            .resolves.toMatchObject({status: "ok"});
        expect(fixture.servers).toHaveLength(2);
        expect(requestsOf(fixture.current(), "thread/resume")).toHaveLength(1);
        expect(requestsOf(fixture.current(), "skills/list")).toContainEqual({cwds: ["/work"], forceReload: true});
        expect(requestsOf(old, "skills/list")).not.toContainEqual({cwds: ["/work"], forceReload: true});
    });

    it("refuses lazy native resume when a persisted queue would auto-dispatch", async () => {
        const fixture = await setup();
        await fixture.kill();
        fixture.answers.set("initialize", () => ({userAgent: "codex-test/0.160.1 (test)", codexHome: "/codex-home"}));
        fixture.answers.set("thread/queue/list", params => (params as {threadId?: string}).threadId
            ? {data: [{id: "persisted-message"}], nextCursor: null}
            : new ResponseError(-32600, "Invalid request: missing field `threadId`"));
        await expect(fixture.agent.readSessionRuntime({sessionId: fixture.sessionId, resource: "commands"}))
            .rejects.toMatchObject({code: 1001, message: expect.stringContaining("Could not reopen session")});
        expect(requestsOf(fixture.current(), "thread/queue/list")).toContainEqual({threadId: fixture.sessionId, limit: 1});
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual([]);
        expect(requestsOf(fixture.current(), "turn/start")).toEqual([]);
        // The integrated queue capability probes registration with invalid, target-free params only.
        expect(requestsOf(fixture.current(), "thread/queue/start")).toEqual([{}]);
    });

    it("restarts before archiving a legacy client session without resuming it", async () => {
        const fixture = await setup();
        await fixture.kill();
        await expect(fixture.agent.archiveSession(fixture.sessionId, true))
            .resolves.toEqual({sessionId: fixture.sessionId, archived: true});
        expect(requestsOf(fixture.current(), "thread/archive")).toEqual([{threadId: fixture.sessionId}]);
        expect(requestsOf(fixture.current(), "thread/resume")).toEqual([]);
    });
});
