import {describe, expect, it, vi} from "vitest";
import {
    createCodexMockTestFixture,
    createTestModel,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import type {CodexAcpServer} from "../../CodexAcpServer";
import type {CodexAcpClient} from "../../CodexAcpClient";

const sessionId = "session-id";

describe("ACP session delete", () => {
    it("advertises session delete support", async () => {
        const fixture = createCodexMockTestFixture();

        const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});

        expect(response.agentCapabilities?.sessionCapabilities?.delete).toEqual({});
    });

    it("archives sessions that are not active locally", async () => {
        const fixture = createCodexMockTestFixture();

        await expect(fixture.getCodexAcpAgent().deleteSession({sessionId})).resolves.toEqual({});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-delete-unknown-local.json"
        );
    });

    it("closes local session resources before archiving", async () => {
        const {fixture, codexAcpAgent} = await createSession();

        await expect(codexAcpAgent.deleteSession({sessionId})).resolves.toEqual({});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-delete-idle.json"
        );
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("does not close again when deleting a previously closed session", async () => {
        const {fixture, codexAcpAgent} = await createSession();

        await codexAcpAgent.closeSession({sessionId});
        fixture.clearCodexConnectionDump();

        await expect(codexAcpAgent.deleteSession({sessionId})).resolves.toEqual({});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-delete-unknown-local.json"
        );
    });

    it("interrupts active turns before archiving", async () => {
        const {fixture, codexAcpAgent} = await createSession();
        codexAcpAgent.getSessionState(sessionId).currentTurnId = "turn-id";

        await expect(codexAcpAgent.deleteSession({sessionId})).resolves.toEqual({});

        await expect(fixture.getCodexConnectionDump([])).toMatchFileSnapshot(
            "data/session-delete-active-turn.json"
        );
        expect(() => codexAcpAgent.getSessionState(sessionId)).toThrow(`Session ${sessionId} not found`);
    });

    it("rejects resume while unknown-local delete archive is in flight", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const archive = deferred<void>();
        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "deleteSession").mockReturnValue(archive.promise);
        const resumeSessionSpy = vi.spyOn(codexAcpClient, "resumeSession");

        const deletePromise = codexAcpAgent.deleteSession({sessionId});
        await vi.waitFor(() => {
            expect(codexAcpClient.deleteSession).toHaveBeenCalledWith(sessionId);
        });

        await expect(codexAcpAgent.resumeSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("Invalid request");
        expect(resumeSessionSpy).not.toHaveBeenCalled();

        archive.resolve(undefined);
        await expect(deletePromise).resolves.toEqual({});
    });

    it("rejects load after local close completes while delete archive is in flight", async () => {
        const {codexAcpAgent, codexAcpClient} = await createSession();
        const archive = deferred<void>();
        vi.spyOn(codexAcpClient, "deleteSession").mockReturnValue(archive.promise);
        const loadSessionSpy = vi.spyOn(codexAcpClient, "loadSession");

        const deletePromise = codexAcpAgent.deleteSession({sessionId});
        await vi.waitFor(() => {
            expect(codexAcpClient.deleteSession).toHaveBeenCalledWith(sessionId);
        });

        await expect(codexAcpAgent.loadSession({
            sessionId,
            cwd: "/test/cwd",
            mcpServers: [],
        })).rejects.toThrow("Invalid request");
        expect(loadSessionSpy).not.toHaveBeenCalled();

        archive.resolve(undefined);
        await expect(deletePromise).resolves.toEqual({});
    });
});

async function createSession(): Promise<{
    fixture: CodexMockTestFixture,
    codexAcpAgent: CodexAcpServer,
    codexAcpClient: CodexAcpClient,
}> {
    const fixture = createCodexMockTestFixture();
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAcpClient = fixture.getCodexAcpClient();
    const model = createTestModel();

    vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
    vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
    vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
        sessionId,
        currentModelId: "model-id[medium]",
        models: [model],
        collaborationMode: "default",
        currentServiceTier: null,
        additionalDirectories: [],
    });

    await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
    fixture.clearCodexConnectionDump();
    fixture.clearAcpConnectionDump();

    return {fixture, codexAcpAgent, codexAcpClient};
}

function deferred<T>(): {promise: Promise<T>, resolve: (value: T) => void} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}
