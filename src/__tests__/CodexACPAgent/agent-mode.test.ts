import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {AgentMode} from "../../AgentMode";

describe("AgentMode plan mode", () => {
    it("resolves the plan mode by id", () => {
        expect(AgentMode.find("plan")).toBe(AgentMode.Plan);
    });

    it("carries planning instructions only for Plan mode", () => {
        expect(AgentMode.Plan.planInstructions).toBeTruthy();
        expect(AgentMode.Plan.planInstructions?.length ?? 0).toBeGreaterThan(0);
        expect(AgentMode.ReadOnly.planInstructions).toBeNull();
        expect(AgentMode.Agent.planInstructions).toBeNull();
        expect(AgentMode.AgentFullAccess.planInstructions).toBeNull();
    });

    it("uses a read-only sandbox with no approvals", () => {
        expect(AgentMode.Plan.sandboxMode).toBe("read-only");
        expect(AgentMode.Plan.sandboxPolicy).toEqual({type: "readOnly", networkAccess: false});
        expect(AgentMode.Plan.approvalPolicy).toBe("never");
    });

    it("includes plan in the available modes exposed to clients", () => {
        expect(AgentMode.all().map((mode) => mode.id)).toContain("plan");

        const state = AgentMode.Agent.toSessionModeState();
        expect(state.availableModes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({id: "plan", name: "Plan"}),
            ]),
        );
    });

    describe("getInitialAgentMode", () => {
        let previous: string | undefined;

        beforeEach(() => {
            previous = process.env["INITIAL_AGENT_MODE"];
        });

        afterEach(() => {
            if (previous === undefined) {
                delete process.env["INITIAL_AGENT_MODE"];
            } else {
                process.env["INITIAL_AGENT_MODE"] = previous;
            }
        });

        it("honors INITIAL_AGENT_MODE=plan", () => {
            process.env["INITIAL_AGENT_MODE"] = "plan";
            expect(AgentMode.getInitialAgentMode()).toBe(AgentMode.Plan);
        });

        it("falls back to the default mode for unknown values", () => {
            process.env["INITIAL_AGENT_MODE"] = "does-not-exist";
            expect(AgentMode.getInitialAgentMode()).toBe(AgentMode.DEFAULT_AGENT_MODE);
        });
    });
});
