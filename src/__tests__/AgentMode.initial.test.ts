import {afterEach, describe, expect, it, vi} from "vitest";
import {AgentMode} from "../AgentMode";
import type {SandboxPolicy} from "../app-server/v2";

describe("initial mode from resolved Codex permissions", () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
        {sandbox: {type: "dangerFullAccess"} as SandboxPolicy, approvalPolicy: "never" as const, approvalsReviewer: "user" as const, expected: "agent-full-access"},
        {sandbox: {type: "readOnly", networkAccess: false} as SandboxPolicy, approvalPolicy: "on-request" as const, approvalsReviewer: "user" as const, expected: "read-only"},
        {sandbox: {type: "readOnly", networkAccess: true} as SandboxPolicy, approvalPolicy: "never" as const, approvalsReviewer: "user" as const, expected: "configured"},
    ])("selects $expected and preserves its resolved permissions", ({expected, ...resolved}) => {
        vi.stubEnv("INITIAL_AGENT_MODE", undefined);
        const modes = AgentMode.all([], "on-request", "user", resolved);
        const selected = AgentMode.getInitialAgentMode(modes, null, resolved);
        expect(selected.id).toBe(expected);
        expect(selected.sandboxPolicy).toEqual(resolved.sandbox);
        expect(selected.approvalPolicy).toEqual(resolved.approvalPolicy);
        expect(selected.approvalsReviewer).toEqual(resolved.approvalsReviewer);
    });

    it("prioritizes explicit mode and active named profile", () => {
        const resolved = {sandbox: {type: "dangerFullAccess"} as SandboxPolicy, approvalPolicy: "never" as const, approvalsReviewer: "user" as const};
        const modes = AgentMode.all([{id: "team", description: null, allowed: true}], "on-request", "user", resolved);
        vi.stubEnv("INITIAL_AGENT_MODE", undefined);
        expect(AgentMode.getInitialAgentMode(modes, "team", resolved).id).toBe("permission-profile:team");
        vi.stubEnv("INITIAL_AGENT_MODE", "read-only");
        expect(AgentMode.getInitialAgentMode(modes, "team", resolved).id).toBe("read-only");
    });
});
