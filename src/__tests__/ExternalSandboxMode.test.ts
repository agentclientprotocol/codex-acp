import {afterEach, describe, expect, it, vi} from "vitest";
import {AgentMode} from "../AgentMode";

describe("host-managed external sandbox", () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([undefined, "", "false", "1"])("does not advertise a host sandbox without explicit opt-in (%s)", value => {
        vi.stubEnv("CODEX_ACP_EXTERNAL_SANDBOX", value);
        expect(AgentMode.find("external-sandbox")).toBeNull();
    });

    it("advertises an approval-preserving policy only to an opted-in host", () => {
        vi.stubEnv("CODEX_ACP_EXTERNAL_SANDBOX", "true");
        const mode = AgentMode.find("external-sandbox");
        expect(mode).toMatchObject({
            approvalPolicy: "untrusted",
            approvalsReviewer: "user",
            sandboxPolicy: {type: "externalSandbox", networkAccess: "enabled"},
            sandboxMode: null,
        });
        expect(AgentMode.DEFAULT_AGENT_MODE).toBe(AgentMode.Agent);
    });
});
