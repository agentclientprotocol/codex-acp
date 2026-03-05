import type {AskForApproval, SandboxMode, SandboxPolicy} from "./app-server/v2";
import type {SessionMode, SessionModeState} from "@agentclientprotocol/sdk";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly approvalPolicy: AskForApproval;
    readonly sandboxPolicy: SandboxPolicy;
    readonly sandboxMode: SandboxMode;

    private constructor(id: string, name: string, description: string, approval: AskForApproval, sandbox: SandboxPolicy, sandboxMode: SandboxMode) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.approvalPolicy = approval;
        this.sandboxPolicy = sandbox;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
    }

    static readonly ReadOnly = new AgentMode(
        "read-only",
        "Read-only",
        "Requires approval to edit files and run commands.",
        "on-request",
        {
            "type": "readOnly",
            "access": {"type": "fullAccess"},
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
            readOnlyAccess: {"type": "fullAccess"},
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
        return [AgentMode.ReadOnly, AgentMode.Agent, AgentMode.AgentFullAccess];
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
