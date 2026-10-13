import {afterEach, describe, expect, it, vi} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {ResponseError, type MessageConnection} from "vscode-jsonrpc/node";
import {explainCodexError} from "../CodexErrorExplanations";
import {CodexAppServerClient} from "../CodexAppServerClient";
import {createMockConnections} from "./CodexACPAgent/test-utils";
import {createCodexMockTestFixture} from "./acp-test-utils";

// The texts Codex 0.159.1 answers with when its working directory is gone (IJAI-2923).
const configReadFailure = () => new ResponseError(
    -32603, "failed to resolve feature override precedence: No such file or directory (os error 2)", {extra: 1});
const threadStartFailure = () => new ResponseError(
    -32600, "failed to load configuration: No such file or directory (os error 2)");

const context = {codexHome: "/home/codex"};
const originalDirectory = process.cwd();
const directories: string[] = [];

afterEach(() => {
    process.chdir(originalDirectory);
    directories.splice(0).forEach(directory => fs.rmSync(directory, {recursive: true, force: true}));
});

/** Loads the module as in an agent started in a new directory, then runs `change` on that directory. */
async function explainerStartedIn(change: (directory: string) => void = () => {}) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-cwd-")));
    directories.push(directory);
    process.chdir(directory);
    vi.resetModules();
    const {explainCodexError} = await import("../CodexErrorExplanations");
    change(directory);
    return (err: Error) => {
        const result = explainCodexError(err, context) as ResponseError<unknown>;
        return {
            code: result.code,
            message: result.message.replace(directory, "<working directory>"),
            data: result.data ?? null,
        };
    };
}

describe("CodexErrorExplanations", () => {
    it.skipIf(process.platform === "win32")("explains config load failures", async () => {
        // Each explanation runs while the process is still in the directory of its agent.
        const deleted = await explainerStartedIn(fs.rmdirSync);
        const withDeletedDirectory = {
            configReadWithDeletedDirectory: deleted(configReadFailure()),
            threadStartWithDeletedDirectory: deleted(threadStartFailure()),
            otherConfigReadFailureWithDeletedDirectory: deleted(new ResponseError(
                -32603, "failed to resolve feature override precedence: invalid TOML in config.toml")),
        };
        const recreated = await explainerStartedIn(directory => {
            fs.rmdirSync(directory);
            fs.mkdirSync(directory);
        });
        const withRecreatedDirectory = {threadStartWithRecreatedDirectory: recreated(threadStartFailure())};
        const present = await explainerStartedIn();
        const results = {
            ...withDeletedDirectory,
            ...withRecreatedDirectory,
            configReadWithPresentDirectory: present(configReadFailure()),
            threadStartWithPresentDirectory: present(threadStartFailure()),
            reloadFailure: present(new Error("failed to reload config: filesystem path `/tmp` must be absolute")),
            reloadFailureThatNeedsLogout: present(new ResponseError(-32603, "failed to reload config: "
                + "Your refresh token was already used. Please log out and sign in again.")),
        };
        await expect(`${JSON.stringify(results, null, 2)}\n`)
            .toMatchFileSnapshot("data/codex-error-explanations/config-load-failures.json");
    });

    it("keeps other errors unchanged", () => {
        const unrelated = new ResponseError(-32600, "thread not found: thread-1");
        expect(explainCodexError(unrelated, context)).toBe(unrelated);
    });

    it("explains the errors of app-server requests", async () => {
        const mocks = createMockConnections();
        mocks.mockCodexConnection.sendRequest.mockRejectedValue(configReadFailure());
        const client = new CodexAppServerClient(mocks.mockCodexConnection as unknown as MessageConnection);

        await expect(client.configRead({includeLayers: false})).rejects.toMatchObject({
            code: -32603,
            message: expect.stringMatching(/^failed to load configuration: No such file or directory \(os error 2\)\n\nCheck global /),
        });
    });

    it.skipIf(process.platform === "win32")("does not point to the config files when the working directory was deleted", async () => {
        const explain = await explainerStartedIn(fs.rmdirSync);
        const fixture = createCodexMockTestFixture();
        vi.spyOn(fixture.getCodexAcpClient(), "readAuthRequirement").mockResolvedValue({required: false, account: null});
        const {code, message} = explain(threadStartFailure());
        vi.spyOn(fixture.getCodexAppServerClient(), "threadStart").mockRejectedValue(new ResponseError(code, message));

        const error = await fixture.getCodexAcpAgent().newSession({cwd: "", mcpServers: []}).catch(e => e);
        expect(error.message).toMatch(/was deleted or replaced after the agent started/);
        expect(error.message).not.toContain("config.toml");
    });
});
