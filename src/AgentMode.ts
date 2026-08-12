import type {AskForApproval, PermissionProfileSummary, SandboxMode, SandboxPolicy} from "./app-server/v2";
import type {SessionConfigOption, SessionMode, SessionModeState} from "@agentclientprotocol/sdk";

export const MODE_CONFIG_ID = "mode";
const PERMISSION_PROFILE_MODE_PREFIX = "permission-profile:";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly approvalPolicy: AskForApproval;
    readonly sandboxPolicy: SandboxPolicy | null;
    readonly sandboxMode: SandboxMode | null;
    readonly permissionProfileId: string | null;

    private constructor(
        id: string,
        name: string,
        description: string,
        approval: AskForApproval,
        sandbox: SandboxPolicy | null,
        sandboxMode: SandboxMode | null,
        permissionProfileId: string | null = null,
    ) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.approvalPolicy = approval;
        this.sandboxPolicy = sandbox;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
        this.permissionProfileId = permissionProfileId;
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

    static DEFAULT_AGENT_MODE = AgentMode.Agent;

    toSessionMode(): SessionMode {
        return {
            id: this.id,
            name: this.name,
            description: this.description,
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
    ): AgentMode[] {
        const profileModes = permissionProfiles
            .filter(profile => profile.allowed && !profile.id.startsWith(":"))
            .map(profile => new AgentMode(
                `${PERMISSION_PROFILE_MODE_PREFIX}${profile.id}`,
                profile.id,
                profile.description ?? `Use the ${profile.id} Codex permission profile.`,
                permissionProfileApprovalPolicy,
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
