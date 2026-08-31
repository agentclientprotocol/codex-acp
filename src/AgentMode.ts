import type {ApprovalsReviewer, AskForApproval, SandboxMode, SandboxPolicy} from "./app-server/v2";
import type {SessionConfigOption, SessionMode, SessionModeState} from "@agentclientprotocol/sdk";

export const MODE_CONFIG_ID = "mode";

type AgentModeKind = "plan" | "auto_review" | "standard" | "full_access";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: AgentModeKind;
    readonly approvalPolicy: AskForApproval;
    readonly approvalsReviewer: ApprovalsReviewer;
    readonly sandboxPolicy: SandboxPolicy;
    readonly sandboxMode: SandboxMode;

    private constructor(
        id: string,
        name: string,
        description: string,
        kind: AgentModeKind,
        approvalPolicy: AskForApproval,
        approvalsReviewer: ApprovalsReviewer,
        sandboxPolicy: SandboxPolicy,
        sandboxMode: SandboxMode,
    ) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.kind = kind;
        this.approvalPolicy = approvalPolicy;
        this.approvalsReviewer = approvalsReviewer;
        this.sandboxPolicy = sandboxPolicy;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
    }

    static readonly ReadOnly = new AgentMode(
        "read-only",
        "Ask for approval",
        "Always ask to edit external files and use the internet",
        "standard",
        "on-request",
        "user",
        {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        },
        "workspace-write",
    );
    static readonly Agent = new AgentMode(
        "agent",
        "Approve for me",
        "Only ask for actions detected as potentially unsafe",
        "auto_review",
        "on-request",
        "auto_review",
        {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
        },
        "workspace-write",
    );
    static readonly AgentFullAccess = new AgentMode(
        "agent-full-access",
        "Full access",
        "Unrestricted access to the internet and any file on your computer",
        "full_access",
        "never",
        "user",
        {"type": "dangerFullAccess"},
        "danger-full-access",
    );

    static DEFAULT_AGENT_MODE = AgentMode.Agent;

    toSessionMode(): SessionMode {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            _meta: {kind: this.kind},
        };
    }

    toSessionModeState(): SessionModeState {
        return {
            availableModes: AgentMode.all().map(mode => mode.toSessionMode()),
            currentModeId: this.id
        };
    }

    toConfigOption(): SessionConfigOption {
        return {
            id: MODE_CONFIG_ID,
            name: "Mode",
            description: "Approval and sandboxing preset for the session",
            category: "mode",
            type: "select",
            currentValue: this.id,
            options: AgentMode.all().map(mode => ({
                value: mode.id,
                name: mode.name,
                description: mode.description,
                _meta: {kind: mode.kind},
            })),
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
