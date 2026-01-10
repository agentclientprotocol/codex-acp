import type {AgentSideConnection, AvailableCommand} from "@agentclientprotocol/sdk";
import {ACPSessionConnection} from "./ACPSessionConnection";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {SkillsListEntry} from "./app-server/v2";

export class AvailableCommandsPublisher {
    private readonly connection: AgentSideConnection;
    private readonly codexAcpClient: CodexAcpClient;
    private readonly runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>;

    constructor(
        connection: AgentSideConnection,
        codexAcpClient: CodexAcpClient,
        runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>
    ) {
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.runWithProcessCheck = runWithProcessCheck;
    }

    async publish(sessionId: string): Promise<void> {
        try {
            const skillsResponse = await this.runWithProcessCheck(() => this.codexAcpClient.listSkills());
            const availableCommands = this.buildAvailableCommands(skillsResponse?.data ?? []);
            if (availableCommands.length === 0) {
                return;
            }

            const session = new ACPSessionConnection(this.connection, sessionId);
            await session.update({
                sessionUpdate: "available_commands_update",
                availableCommands
            });
        } catch (err) {
            console.error(`Failed to publish available commands for session ${sessionId}:`, err);
        }
    }

    private buildAvailableCommands(skillsEntries: SkillsListEntry[]): AvailableCommand[] {
        const commands = new Map<string, AvailableCommand>();

        for (const builtin of this.getBuiltinCommands()) {
            commands.set(builtin.name, builtin);
        }

        for (const entry of skillsEntries) {
            for (const skill of entry.skills) {
                const name = `$${skill.name}`;
                if (commands.has(name)) continue;
                const description = skill.shortDescription ?? skill.description ?? skill.name;
                commands.set(name, {
                    name,
                    description,
                    input: null,
                });
            }
        }
        return Array.from(commands.values());
    }

    /**
     * See the original cli commands documentation here: https://developers.openai.com/codex/cli/slash-commands/
     */
    private getBuiltinCommands(): AvailableCommand[] {
        return [
            {
                name: "mcp",
                description: "List configured Model Context Protocol (MCP) tools.",
                input: null
            },
            {
                name: "skills",
                description: "List available skills.",
                input: null
            },
            {
                name: "status",
                description: "Display session configuration and token usage.",
                input: null
            },
            {
                name: "logout",
                description: "Sign out of Codex. This option is available when you are logged in via ChatGPT.",
                input: null
            }
        ];
    }
}
