import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {RequestError} from "@agentclientprotocol/sdk";
import {AgentMode} from "../../AgentMode";
import {
    KANDEV_GUARDED_TTY_CAPABILITY,
    KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
    KANDEV_GUARDED_TTY_EXEC_METHOD,
    KANDEV_GUARDED_TTY_VERSION,
} from "../../AcpExtensions";
import {GUARDED_TTY_OUTPUT_BYTES_MAX, GUARDED_TTY_TIMEOUT_MS} from "../../GuardedTtyExec";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";
import type {CodexMockTestFixture} from "../acp-test-utils";
import type {SessionState} from "../../CodexAcpServer";
import type {CommandExecParams, CommandExecResponse} from "../../app-server/v2";

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {promise, resolve};
}

function installSession(
    fixture: CodexMockTestFixture,
    overrides: Partial<SessionState> = {},
): SessionState {
    const state = createTestSessionState({
        sessionId: "session-id",
        cwd: "/trusted/task/worktree",
        agentMode: AgentMode.ReadOnly,
        ...overrides,
    });
    const agent = fixture.getCodexAcpAgent() as unknown as {
        sessions: Map<string, SessionState>;
    };
    agent.sessions.set(state.sessionId, state);
    return state;
}

function outputDelta(processId: string, stream: "stdout" | "stderr", bytes: Uint8Array, capReached = false) {
    return {
        method: "command/exec/outputDelta" as const,
        params: {
            processId,
            stream,
            deltaBase64: Buffer.from(bytes).toString("base64"),
            capReached,
        },
    };
}

describe("Kandev guarded TTY ACP extension", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("advertises and probes the exact version for an active session", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);

        const initialized = await fixture.getCodexAcpAgent().initialize({protocolVersion: 1});
        expect(initialized._meta).toMatchObject({
            guardedTtyExec: {
                capability: KANDEV_GUARDED_TTY_CAPABILITY,
                version: KANDEV_GUARDED_TTY_VERSION,
                capabilityMethod: KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
                execMethod: KANDEV_GUARDED_TTY_EXEC_METHOD,
            },
        });
        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_CAPABILITY_METHOD, {
            sessionId: "session-id",
        })).resolves.toEqual({
            capability: KANDEV_GUARDED_TTY_CAPABILITY,
            version: KANDEV_GUARDED_TTY_VERSION,
            supported: true,
            capability_method: KANDEV_GUARDED_TTY_CAPABILITY_METHOD,
            exec_method: KANDEV_GUARDED_TTY_EXEC_METHOD,
            session_id: "session-id",
        });
    });

    it("fails closed for unsupported, malformed, and stale capability probes", async () => {
        const fixture = createCodexMockTestFixture();

        await expect(fixture.getCodexAcpAgent().extMethod("_kandev/guarded_tty/v0", {
            sessionId: "session-id",
        })).resolves.toEqual({});
        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_CAPABILITY_METHOD, {
            sessionId: "session-id",
            version: 1,
        })).rejects.toThrow(RequestError);
        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_CAPABILITY_METHOD, {
            sessionId: "stale-session",
        })).rejects.toThrow("Unknown or stale session");
    });

    it("rejects empty, oversized, malformed, and security-field requests before dispatch", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        const commandExec = vi.spyOn(fixture.getCodexAppServerClient(), "commandExec");
        const invalidRequests = [
            {sessionId: "session-id", argv: []},
            {sessionId: "session-id", argv: Array.from({length: 65}, () => "x")},
            {sessionId: "session-id", argv: ["x".repeat(4 * 1024 + 1)]},
            {sessionId: "session-id", argv: ["x".repeat(4 * 1024), "y".repeat(4 * 1024), "z"]},
            {sessionId: "session-id", argv: ["contains\0nul"]},
            {sessionId: "session-id", argv: ["printf", 123]},
            {sessionId: "session-id", argv: ["pwd"], cwd: "/tmp"},
            {sessionId: "session-id", argv: ["pwd"], tty: false},
            {sessionId: "session-id", argv: ["pwd"], processId: "forged"},
            {sessionId: "session-id", argv: ["pwd"], sandboxPolicy: {type: "dangerFullAccess"}},
            {sessionId: "session-id", argv: ["pwd"], permissionProfile: "full"},
            {sessionId: "session-id", argv: ["pwd"], env: {TOKEN: "forged"}},
            {sessionId: "session-id", argv: ["pwd"], stdin: "secret"},
            {sessionId: "session-id", argv: ["pwd"], write: "secret"},
            {sessionId: "session-id", argv: ["pwd"], resize: {rows: 100}},
            {sessionId: "session-id", argv: ["pwd"], attach: true},
        ];

        for (const request of invalidRequests) {
            await expect(fixture.getCodexAcpAgent().extMethod(
                KANDEV_GUARDED_TTY_EXEC_METHOD,
                request as Record<string, unknown>,
            )).rejects.toThrow(RequestError);
        }
        expect(commandExec).not.toHaveBeenCalled();
    });

    it("dispatches tty:true with a generated id and trusted session execution state", async () => {
        const fixture = createCodexMockTestFixture();
        const state = installSession(fixture);
        const configBefore = process.env["CODEX_CONFIG"];
        const commandExec = vi.spyOn(fixture.getCodexAppServerClient(), "commandExec")
            .mockImplementation(async (params: CommandExecParams) => {
                fixture.sendServerNotification(outputDelta("wrong-process", "stdout", Buffer.from("ignored")));
                const emoji = Buffer.from("TTY ✅\n");
                fixture.sendServerNotification(outputDelta(params.processId!, "stdout", emoji.subarray(0, 5)));
                fixture.sendServerNotification(outputDelta(params.processId!, "stdout", emoji.subarray(5)));
                fixture.sendServerNotification(outputDelta(params.processId!, "stderr", Buffer.from("stty ok\n")));
                return {exitCode: 0, stdout: "", stderr: ""};
            });

        const receipt = await fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: state.sessionId,
            argv: ["sh", "-lc", "test -t 0 && test -t 1 && stty && pwd && git status --short"],
        });

        expect(commandExec).toHaveBeenCalledOnce();
        const request = commandExec.mock.calls[0]![0];
        expect(request).toEqual({
            command: ["sh", "-lc", "test -t 0 && test -t 1 && stty && pwd && git status --short"],
            processId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            tty: true,
            streamStdin: true,
            streamStdoutStderr: true,
            outputBytesCap: GUARDED_TTY_OUTPUT_BYTES_MAX,
            timeoutMs: GUARDED_TTY_TIMEOUT_MS,
            cwd: "/trusted/task/worktree",
            sandboxPolicy: state.agentMode.sandboxPolicy,
        });
        expect(request).not.toHaveProperty("env");
        expect(request).not.toHaveProperty("permissionProfile");
        expect(receipt).toMatchObject({
            capability: KANDEV_GUARDED_TTY_CAPABILITY,
            version: 1,
            session_id: "session-id",
            method: "command/exec",
            requested_tty: true,
            dispatched_tty: true,
            process_id: request.processId,
            cwd: "/trusted/task/worktree",
            outcome: "completed",
            denial_code: null,
            stdout: "TTY ✅\n",
            stderr: "stty ok\n",
            exit_code: 0,
        });
        expect(process.env["CODEX_CONFIG"]).toBe(configBefore);
    });

    it("terminates and finalizes once when App Server reports output overflow", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate")
            .mockResolvedValue({});
        vi.spyOn(fixture.getCodexAppServerClient(), "commandExec")
            .mockImplementation(async (params: CommandExecParams) => {
                fixture.sendServerNotification(outputDelta(params.processId!, "stdout", Buffer.from("bounded"), true));
                return {exitCode: 0, stdout: "", stderr: ""};
            });

        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["yes"],
        })).resolves.toMatchObject({
            outcome: "failed",
            denial_code: "output_overflow",
            stdout: "",
            output_bytes: 0,
            exit_code: null,
        });
        expect(terminate).toHaveBeenCalledOnce();
    });

    it("cancels a dispatched command promptly and ignores its later completion", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        const response = deferred<CommandExecResponse>();
        vi.spyOn(fixture.getCodexAppServerClient(), "commandExec").mockReturnValue(response.promise);
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate")
            .mockResolvedValue({});
        const controller = new AbortController();
        const execution = fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["sh", "-lc", "sleep 30"],
        }, controller.signal);
        await vi.waitFor(() => expect(fixture.getCodexAppServerClient().commandExec).toHaveBeenCalled());

        controller.abort();
        await expect(execution).resolves.toMatchObject({
            outcome: "failed",
            denial_code: "cancelled",
            dispatched_tty: true,
            exit_code: null,
        });
        expect(terminate).toHaveBeenCalledOnce();
        response.resolve({exitCode: 0, stdout: "", stderr: ""});
    });

    it("aborts an in-flight execution when its session closes", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        vi.spyOn(fixture.getCodexAppServerClient(), "commandExec")
            .mockReturnValue(new Promise<CommandExecResponse>(() => {}));
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate")
            .mockResolvedValue({});
        vi.spyOn(fixture.getCodexAcpClient(), "closeSession").mockResolvedValue();
        const execution = fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["sh", "-lc", "sleep 30"],
        });
        await vi.waitFor(() => expect(fixture.getCodexAppServerClient().commandExec).toHaveBeenCalled());

        await fixture.getCodexAcpAgent().closeSession({sessionId: "session-id"});
        await expect(execution).resolves.toMatchObject({
            outcome: "failed",
            denial_code: "stale_session",
            dispatched_tty: true,
        });
        expect(terminate).toHaveBeenCalledOnce();
    });

    it("returns stable failures for invalid output and App Server errors", async () => {
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate")
            .mockResolvedValue({});
        vi.spyOn(fixture.getCodexAppServerClient(), "commandExec")
            .mockImplementationOnce(async (params: CommandExecParams) => {
                fixture.sendServerNotification({
                    method: "command/exec/outputDelta",
                    params: {processId: params.processId!, stream: "stdout", deltaBase64: "***", capReached: false},
                });
                return {exitCode: 0, stdout: "", stderr: ""};
            })
            .mockRejectedValueOnce(new Error("secret-bearing App Server failure"));

        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["pwd"],
        })).resolves.toMatchObject({denial_code: "invalid_output"});
        const appServerFailure = await fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["pwd"],
        });
        expect(appServerFailure).toMatchObject({denial_code: "app_server_error"});
        expect(JSON.stringify(appServerFailure)).not.toContain("secret-bearing");
        expect(terminate).toHaveBeenCalledTimes(2);
    });

    it("terminates a command that outlives the fixed bridge deadline", async () => {
        vi.useFakeTimers();
        const fixture = createCodexMockTestFixture();
        installSession(fixture);
        vi.spyOn(fixture.getCodexAppServerClient(), "commandExec")
            .mockReturnValue(new Promise<CommandExecResponse>(() => {}));
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate")
            .mockResolvedValue({});

        const execution = fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "session-id",
            argv: ["sh", "-lc", "sleep 30"],
        });
        await vi.advanceTimersByTimeAsync(GUARDED_TTY_TIMEOUT_MS + 1_000);

        await expect(execution).resolves.toMatchObject({
            outcome: "failed",
            denial_code: "timeout",
        });
        expect(terminate).toHaveBeenCalledOnce();
    });

    it("denies unknown sessions without creating or terminating a process", async () => {
        const fixture = createCodexMockTestFixture();
        const commandExec = vi.spyOn(fixture.getCodexAppServerClient(), "commandExec");
        const terminate = vi.spyOn(fixture.getCodexAppServerClient(), "commandExecTerminate");

        await expect(fixture.getCodexAcpAgent().extMethod(KANDEV_GUARDED_TTY_EXEC_METHOD, {
            sessionId: "unknown-session",
            argv: ["pwd"],
        })).resolves.toMatchObject({
            outcome: "denied",
            denial_code: "stale_session",
            dispatched_tty: false,
            process_id: null,
            cwd: null,
        });
        expect(commandExec).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
    });
});
