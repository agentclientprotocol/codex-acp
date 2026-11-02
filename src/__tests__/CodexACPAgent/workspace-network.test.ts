import {describe, expect, it, vi} from "vitest";
import {AgentMode} from "../../AgentMode";
import {CodexAcpClient} from "../../CodexAcpClient";
import {ModelId} from "../../ModelId";
import type {ConfigReadResponse, TurnCompletedNotification} from "../../app-server/v2";
import {createCodexMockTestFixture} from "../acp-test-utils";

const completedTurn: TurnCompletedNotification = {
    threadId: "session",
    turn: {
        id: "turn",
        status: "completed",
        items: [],
        error: null,
        itemsView: "notLoaded",
        startedAt: null,
        completedAt: null,
        durationMs: null,
    },
};

function configResponse(networkAccess?: boolean): ConfigReadResponse {
    return {
        config: {
            sandbox_workspace_write: networkAccess === undefined ? null : {
                network_access: networkAccess,
                writable_roots: null,
                exclude_tmpdir_env_var: null,
                exclude_slash_tmp: null,
            },
        } as ConfigReadResponse["config"],
        origins: {},
        layers: null,
    };
}

function createFixture(inlineNetwork?: boolean | string) {
    const fixture = createCodexMockTestFixture();
    const server = fixture.getCodexAppServerClient();
    vi.spyOn(server, "listSkills").mockResolvedValue({data: []});
    const configRead = vi.spyOn(server, "configRead").mockResolvedValue(configResponse());
    const runTurn = vi.spyOn(server, "runTurn").mockResolvedValue(completedTurn);
    const client = new CodexAcpClient(server, inlineNetwork === undefined ? {} : {
        sandbox_workspace_write: {network_access: inlineNetwork},
    });
    return {
        configRead,
        runTurn,
        prompt: (mode = AgentMode.Agent, shouldCancel?: () => boolean) => client.sendPrompt(
            {sessionId: "session", prompt: [{type: "text", text: "Hello"}]},
            mode,
            ModelId.create("test-model", "medium"),
            null,
            false,
            "/workspace",
            ["/workspace/extra"],
            undefined,
            shouldCancel,
        ),
    };
}

describe("workspace-write network configuration", () => {
    it.each([
        {name: "explicit session enable", inline: true, file: false, expected: true},
        {name: "explicit session disable", inline: false, file: true, expected: false},
        {name: "enabled config.toml", inline: undefined, file: true, expected: true},
        {name: "disabled config.toml", inline: undefined, file: false, expected: false},
        {name: "preset default", inline: undefined, file: undefined, expected: false},
        {name: "malformed inline flag", inline: "true", file: undefined, expected: false},
    ])("honors $name without widening filesystem access", async ({inline, file, expected}) => {
        const fixture = createFixture(inline);
        fixture.configRead.mockResolvedValue(configResponse(file));
        await fixture.prompt();

        expect(fixture.runTurn.mock.calls[0]![0]).toMatchObject({
            approvalPolicy: AgentMode.Agent.approvalPolicy,
            approvalsReviewer: AgentMode.Agent.approvalsReviewer,
            sandboxPolicy: {
                ...AgentMode.Agent.sandboxPolicy,
                writableRoots: ["/workspace/extra"],
                networkAccess: expected,
            },
        });
        if (typeof inline === "boolean") {
            expect(fixture.configRead).not.toHaveBeenCalled();
        } else {
            expect(fixture.configRead).toHaveBeenCalledWith({includeLayers: false, cwd: "/workspace"});
        }
        expect(AgentMode.Agent.sandboxPolicy).toHaveProperty("networkAccess", false);
    });

    it("applies resolved config to workspace access mode", async () => {
        const fixture = createFixture();
        fixture.configRead.mockResolvedValue(configResponse(true));
        await fixture.prompt(AgentMode.WorkspaceWrite);
        expect(fixture.runTurn.mock.calls[0]![0]).toMatchObject({
            approvalsReviewer: AgentMode.WorkspaceWrite.approvalsReviewer,
            sandboxPolicy: {type: "workspaceWrite", networkAccess: true},
        });
    });

    it.each([AgentMode.ReadOnly, AgentMode.AgentFullAccess])("preserves $id mode", async mode => {
        const fixture = createFixture(true);
        fixture.configRead.mockResolvedValue(configResponse(true));
        await fixture.prompt(mode);
        expect(fixture.runTurn.mock.calls[0]![0].sandboxPolicy).toEqual(mode.sandboxPolicy);
        expect(fixture.configRead).not.toHaveBeenCalled();
    });

    it("does not start a turn cancelled while resolving file config", async () => {
        const fixture = createFixture();
        let cancelled = false;
        fixture.configRead.mockImplementation(async () => {
            cancelled = true;
            return configResponse(true);
        });
        await expect(fixture.prompt(AgentMode.Agent, () => cancelled)).resolves.toBeNull();
        expect(fixture.runTurn).not.toHaveBeenCalled();
    });
});
