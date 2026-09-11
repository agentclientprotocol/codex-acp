import type {
    ApprovalsReviewer,
    AskForApproval,
    PermissionProfileSummary,
    SandboxMode,
    SandboxPolicy,
} from "./app-server/v2";
import type {SessionConfigOption, SessionMode, SessionModeState} from "@agentclientprotocol/sdk";

export const MODE_CONFIG_ID = "mode";
const PERMISSION_PROFILE_MODE_PREFIX = "permission-profile:";

type AgentModeKind = "plan" | "auto_review" | "standard" | "full_access";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: AgentModeKind | null;
    readonly approvalPolicy: AskForApproval;
    readonly approvalsReviewer: ApprovalsReviewer;
    readonly sandboxPolicy: SandboxPolicy | null;
    readonly sandboxMode: SandboxMode | null;
    readonly permissionProfileId: string | null;

    private constructor(
        id: string,
        name: string,
        description: string,
        kind: AgentModeKind | null,
        approvalPolicy: AskForApproval,
        approvalsReviewer: ApprovalsReviewer,
        sandboxPolicy: SandboxPolicy | null,
        sandboxMode: SandboxMode | null,
        permissionProfileId: string | null = null,
    ) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.kind = kind;
        this.approvalPolicy = approvalPolicy;
        this.approvalsReviewer = approvalsReviewer;
        this.sandboxPolicy = sandboxPolicy;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
        this.permissionProfileId = permissionProfileId;
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
            ...(this.kind === null ? {} : {_meta: {kind: this.kind}}),
        };
    }

    toSessionModeState(availableModes: AgentMode[] = AgentMode.all()): SessionModeState {
        return {
            availableModes: availableModes.map(mode => mode.toSessionMode()),
            currentModeId: this.id
        };
    }

    toConfigOption(availableModes: AgentMode[] = AgentMode.all()): SessionConfigOption {
        const toOptions = (modes: AgentMode[]) => modes.map(mode => ({
            value: mode.id,
            name: mode.name,
            description: mode.description,
            ...(mode.kind === null ? {} : {_meta: {kind: mode.kind}}),
        }));
        const permissionProfileModes = availableModes.filter(mode => mode.permissionProfileId !== null);
        const options = permissionProfileModes.length === 0
            ? toOptions(availableModes)
            : [
                {
                    group: "sandbox-modes",
                    name: "Sandbox Modes",
                    options: toOptions(availableModes.filter(mode => mode.permissionProfileId === null)),
                },
                {
                    group: "permission-profiles",
                    name: "Permission Profiles",
                    options: toOptions(permissionProfileModes),
                },
            ];
        return {
            id: MODE_CONFIG_ID,
            name: "Mode",
            description: "Approval and sandboxing preset for the session",
            category: "mode",
            type: "select",
            currentValue: this.id,
            options,
        };
    }

    static all(
        permissionProfiles: PermissionProfileSummary[] = [],
        permissionProfileApprovalPolicy: AskForApproval = "on-request",
        permissionProfileApprovalsReviewer: ApprovalsReviewer = "user",
    ): AgentMode[] {
        const profileModes = permissionProfiles
            .filter(profile => profile.allowed && !profile.id.startsWith(":"))
            .map(profile => new AgentMode(
                `${PERMISSION_PROFILE_MODE_PREFIX}${profile.id}`,
                profile.id,
                profile.description ?? `Use the ${profile.id} Codex permission profile.`,
                null,
                permissionProfileApprovalPolicy,
                permissionProfileApprovalsReviewer,
                null,
                null,
                profile.id,
            ));
        return [AgentMode.ReadOnly, AgentMode.Agent, AgentMode.AgentFullAccess, ...profileModes];
    }

    static find(modeId: string, availableModes: AgentMode[] = AgentMode.all()): AgentMode | null {
        const match = availableModes.find(m => m.id === modeId);
        return match ?? null;
    }

    static getInitialAgentMode(
        availableModes: AgentMode[] = AgentMode.all(),
        activePermissionProfileId: string | null = null,
    ): AgentMode {
        const predefinedAgentMode = process.env["INITIAL_AGENT_MODE"];
        if (predefinedAgentMode) {
            return AgentMode.find(predefinedAgentMode, availableModes) ?? AgentMode.DEFAULT_AGENT_MODE;
        }
        if (activePermissionProfileId !== null) {
            const profileMode = availableModes.find(mode => mode.permissionProfileId === activePermissionProfileId);
            if (profileMode) {
                return profileMode;
            }
        }
        switch (activePermissionProfileId) {
            case ":read-only":
                return AgentMode.ReadOnly;
            case ":workspace":
                return AgentMode.Agent;
            case ":danger-full-access":
                return AgentMode.AgentFullAccess;
        }
        return AgentMode.DEFAULT_AGENT_MODE;
    }
}
