import type * as acp from "@agentclientprotocol/sdk";
import type {AgentSideConnection, AvailableCommand} from "@agentclientprotocol/sdk";
import {ACPSessionConnection} from "./ACPSessionConnection";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {SkillsListEntry} from "./app-server/v2";
import type {SessionState} from "./CodexAcpServer";

export class CodexCommands {
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

    async tryHandle(prompt: acp.ContentBlock[], sessionState: SessionState): Promise<boolean> {
        const command = this.parseCommand(prompt);
        if (command) {
            return this.handleCommand(command, sessionState);
        }
        return false;
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

    private parseCommand(prompt: acp.ContentBlock[]): ParsedCommand | null {
        if (prompt.length !== 1) return null;
        const [single] = prompt;
        if (!single) return null;

        if (single.type !== "text") return null;
        const trimmed = single.text.trim();
        if (!trimmed.startsWith("/")) return null;

        const commandText = trimmed.slice(1).trim();
        if (commandText.length === 0) return null;

        const [name, ...rest] = commandText.split(/\s+/);
        const input = rest.join(" ").trim();
        return {
            name: name!!.toLowerCase(),
            input: input.length > 0 ? input : null
        };
    }

    async handleCommand(command: ParsedCommand, sessionState: SessionState): Promise<boolean> {
        const {name, input} = command;
        const sessionId = sessionState.sessionMetadata.sessionId;

        switch (name) {
            case "status": {
                const session = new ACPSessionConnection(this.connection, sessionId);
                const usage = sessionState.lastTokenUsage;
                const usageText = usage
                    ? `tokens: total=${usage.totalTokens}, input=${usage.inputTokens} (cached=${usage.cachedInputTokens}), output=${usage.outputTokens}, reasoning=${usage.reasoningOutputTokens}`
                    : "tokens: not available (no turn yet)";

                const message = [
                    "Session status:",
                    `- mode: ${sessionState.sessionMetadata.agentMode.name}`,
                    `- model: ${sessionState.sessionMetadata.currentModelId}`,
                    `- ${usageText}`
                ].join("\n");

                await session.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: message }
                });
                return true;
            }
            case "logout": {
                await this.runWithProcessCheck(() => this.codexAcpClient.logout());
                const session = new ACPSessionConnection(this.connection, sessionId);
                await session.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Logged out from Codex account." }
                });
                return true;
            }
            case "skills": {
                const response = await this.runWithProcessCheck(() => this.codexAcpClient.listSkills());
                const skills = (response?.data ?? []).flatMap(entry => entry.skills);
                const lines = skills.map(skill => {
                    const description = skill.shortDescription ?? skill.description ?? "";
                    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
                });
                const text = lines.length > 0
                    ? ["Available skills:", ...lines].join("\n")
                    : "No skills configured.";
                const session = new ACPSessionConnection(this.connection, sessionId);
                await session.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text }
                });
                return true;
            }
            case "mcp": {
                const servers = await this.runWithProcessCheck(() => this.codexAcpClient.listMcpServers());
                const lines = servers.data.map(server => {
                    const toolCount = Object.keys(server.tools ?? {}).length;
                    const resourceCount = (server.resources ?? []).length;
                    return `- ${server.name}: ${toolCount} tools, ${resourceCount} resources, auth=${server.authStatus}`;
                });
                const text = lines.length > 0
                    ? ["Configured MCP servers:", ...lines].join("\n")
                    : "No MCP servers configured.";
                const session = new ACPSessionConnection(this.connection, sessionId);
                await session.update({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text }
                });
                return true;
            }
            default:
                await this.sendUnknownCommandMessage(name, sessionId);
                return true;
        }
    }

    private async sendUnknownCommandMessage(name: string, sessionId: string): Promise<void> {
        const lines = this.getBuiltinCommands().map(command => `- /${command.name}: ${command.description}`);
        const text = [
            `Unknown command "/${name}".`,
            "Available commands:"
        ];
        if (lines.length > 0) {
            text.push(...lines);
        }
        const session = new ACPSessionConnection(this.connection, sessionId);
        await session.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text.join("\n") }
        });
    }
}

type ParsedCommand = { name: string; input: string | null };
