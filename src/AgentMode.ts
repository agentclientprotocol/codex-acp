import type {AskForApproval, SandboxMode, SandboxPolicy} from "./app-server/v2";
import type {SessionMode, SessionModeState} from "@agentclientprotocol/sdk";

/**
 * Instruction injected at the start of every turn while Plan mode is active.
 * Combined with the read-only sandbox, it turns a turn into a design-only
 * planning turn: the model investigates and proposes a step-by-step plan
 * (rendered via the update_plan tool) instead of making changes. This is what
 * differentiates Plan from the plain Read-only mode, which also blocks writes
 * but gives no planning directive.
 */
const PLAN_MODE_INSTRUCTIONS = `You are operating in PLAN MODE. Your task is to investigate and design, not to execute.

Rules for this turn:
- Do NOT edit, create, move, or delete any files. Do NOT run any command that mutates the workspace, git state, or environment, and do NOT make network changes. You are running in a read-only sandbox; mutating actions will be blocked.
- Investigate the codebase as needed using read-only actions (reading files, searching, listing directories, read-only shell commands) to ground your plan in the actual code.
- Produce a clear, step-by-step implementation plan. Use the update_plan tool to record the plan as ordered, verifiable steps. Reference concrete files, functions, and symbols you discovered.
- Call out key decisions, trade-offs, dependencies/sequencing, and risks or open questions.

When the plan is ready, present a short summary and explicitly ask the user to switch to "Agent" mode (the mode selector) to execute it. Do not attempt to implement the changes yourself while in Plan mode.`;

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly approvalPolicy: AskForApproval;
    readonly sandboxPolicy: SandboxPolicy;
    readonly sandboxMode: SandboxMode;
    readonly planInstructions: string | null;

    private constructor(id: string, name: string, description: string, approval: AskForApproval, sandbox: SandboxPolicy, sandboxMode: SandboxMode, planInstructions: string | null = null) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.approvalPolicy = approval;
        this.sandboxPolicy = sandbox;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
        this.planInstructions = planInstructions;
    }

    static readonly ReadOnly = new AgentMode(
        "read-only",
        "Read-only",
        "Requires approval to edit files and run commands.",
        "on-request",
        {
            "type": "readOnly",
            "networkAccess": false
        },
        "read-only"
    );
    static readonly Agent = new AgentMode(
        "agent",
        "Agent",
        "Read and edit files, and run commands.",
        "on-request",
        {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
        },
        "workspace-write"
    );
    static readonly AgentFullAccess = new AgentMode(
        "agent-full-access",
        "Agent (full access)",
        "Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.",
        "never",
        {"type": "dangerFullAccess"},
        "danger-full-access"
    );
    static readonly Plan = new AgentMode(
        "plan",
        "Plan",
        "Investigate read-only and produce a step-by-step implementation plan before making any changes.",
        "never",
        {
            "type": "readOnly",
            "networkAccess": false
        },
        "read-only",
        PLAN_MODE_INSTRUCTIONS
    );

    static DEFAULT_AGENT_MODE = AgentMode.Agent;

    toSessionMode(): SessionMode {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
        };
    }

    toSessionModeState(): SessionModeState {
        return {
            availableModes: AgentMode.all().map(mode => mode.toSessionMode()),
            currentModeId: this.id
        };
    }

    static all(): AgentMode[] {
        return [AgentMode.ReadOnly, AgentMode.Plan, AgentMode.Agent, AgentMode.AgentFullAccess];
    }

    static find(modeId: string): AgentMode | null {
        const match = AgentMode.all().find(m => m.id === modeId);
        return match ?? null;
    }

    static getInitialAgentMode(): AgentMode {
        const predefinedAgentMode = process.env["INITIAL_AGENT_MODE"];
        if (predefinedAgentMode) {
            return AgentMode.find(predefinedAgentMode) ?? AgentMode.DEFAULT_AGENT_MODE;
        } else {
            return AgentMode.DEFAULT_AGENT_MODE;
        }
    }
}
