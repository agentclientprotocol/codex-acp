import type * as acp from "@agentclientprotocol/sdk";
import type {AgentSideConnection, AvailableCommand} from "@agentclientprotocol/sdk";
import {ACPSessionConnection} from "./ACPSessionConnection";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {RateLimitSnapshot, SkillsListEntry} from "./app-server/v2";
import type {SessionState} from "./CodexAcpServer";
import type {RateLimitsMap} from "./RateLimitsMap";
import type {TokenCount} from "./TokenCount";
import {logger} from "./Logger";

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
            logger.error(`Failed to publish available commands for session ${sessionId}`, err);
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
        const sessionId = sessionState.sessionId;

        switch (command.name) {
            case "status": {
                const session = new ACPSessionConnection(this.connection, sessionId);
                const message = this.buildStatusMessage(sessionState);
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
                const configuredServers = servers.data.map(server => {
                    const toolCount = Object.keys(server.tools ?? {}).length;
                    const resourceCount = (server.resources ?? []).length;
                    return `- ${server.name}: ${toolCount} tools, ${resourceCount} resources, auth=${server.authStatus}`;
                });
                const sessionServers = sessionState.sessionMcpServers
                    ? sessionState.sessionMcpServers.map(serverName => `- ${serverName}`)
                    : [];
                const lines = [...configuredServers, ...sessionServers];
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
                await this.sendUnknownCommandMessage(command.name, sessionId);
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

    private buildStatusMessage(sessionState: SessionState): string {
        const agentMode = sessionState.agentMode;
        const accountText = this.formatAccountInfo(sessionState.account);
        const tokenUsageText = this.formatTokenUsage(sessionState.totalTokenUsage);
        const contextWindowText = this.formatContextWindow(
            sessionState.lastTokenUsage,
            sessionState.modelContextWindow
        );

        const lines = [
            `**Model:** ${sessionState.currentModelId}`,
            `**Directory:** ${sessionState.cwd}`,
            `**Approval:** ${agentMode.approvalPolicy}`,
            `**Sandbox:** ${agentMode.sandboxMode}`,
            `**Account:** ${accountText}`,
            `**Session:** \`${sessionState.sessionId}\``,
            ``,
            `**Token usage:** ${tokenUsageText}`,
            `**Context window:** ${contextWindowText}`,
            ...this.formatRateLimitLines(sessionState.rateLimits),
        ];

        return lines.join("  \n");
    }

    private formatAccountInfo(account: SessionState["account"]): string {
        if (!account) {
            return "not logged in";
        }
        if (account.type === "apiKey") {
            return "API key configured";
        }
        if (account.type === "chatgpt") {
            return `ChatGPT ${account.planType} (${account.email})`;
        }
        if (account.type === "amazonBedrock") {
            return "Amazon Bedrock";
        }
        return "unknown";
    }

    private formatTokenUsage(usage: TokenCount | null): string {
        if (!usage) {
            return "data not available yet";
        }
        const total = this.formatTokenCount(usage.totalTokens);
        const input = this.formatTokenCount(usage.inputTokens);
        const cachedInput = this.formatTokenCount(usage.cachedInputTokens);
        const output = this.formatTokenCount(usage.outputTokens);
        return `${total} total  (${input} input + ${cachedInput} cached input, ${output} output)`;
    }

    private formatContextWindow(usage: TokenCount | null, contextWindow: number | null): string {
        if (!usage || !contextWindow) {
            return "data not available yet";
        }
        const used = usage.totalTokens;
        const percentLeft = Math.round(((contextWindow - used) / contextWindow) * 100);
        const usedFormatted = this.formatTokenCount(used);
        const totalFormatted = this.formatTokenCount(contextWindow);
        return `${percentLeft}% left (${usedFormatted} used / ${totalFormatted})`;
    }

    private formatRateLimitLines(rateLimits: RateLimitsMap | null): string[] {
        if (!rateLimits || rateLimits.size === 0) {
            return [`**Limits:** data not available yet`];
        }

        const lines: string[] = [];

        for (const [, entry] of rateLimits) {
            lines.push(...this.formatSingleRateLimit(entry.limitName, entry.snapshot));
        }

        return lines.length > 0 ? lines : [`**Limits:** data not available yet`];
    }

    private formatSingleRateLimit(limitName: string, rateLimits: RateLimitSnapshot): string[] {
        const lines: string[] = [];
        const prefix = limitName ? `${limitName} ` : "";

        if (rateLimits.primary) {
            const percentLeft = Math.round(100 - rateLimits.primary.usedPercent);
            const resetText = this.formatResetTime(rateLimits.primary.resetsAt);
            const label = this.formatWindowLabel(rateLimits.primary.windowDurationMins);
            lines.push(`**${prefix}${label}:** ${percentLeft}% left${resetText}`);
        }

        if (rateLimits.secondary) {
            const percentLeft = Math.round(100 - rateLimits.secondary.usedPercent);
            const resetText = this.formatResetTime(rateLimits.secondary.resetsAt);
            const label = this.formatWindowLabel(rateLimits.secondary.windowDurationMins);
            lines.push(`**${prefix}${label}:** ${percentLeft}% left${resetText}`);
        }

        if (rateLimits.credits) {
            if (rateLimits.credits.unlimited) {
                lines.push(`**${prefix}Credits:** unlimited`);
            } else if (rateLimits.credits.balance) {
                lines.push(`**${prefix}Credits:** ${rateLimits.credits.balance}`);
            }
        }

        return lines;
    }

    private formatWindowLabel(windowDurationMins: number | null): string {
        if (windowDurationMins === null) {
            return "Limit";
        }
        if (windowDurationMins < 60) {
            return `${windowDurationMins}m limit`;
        }
        if (windowDurationMins < 1440) {
            const hours = Math.round(windowDurationMins / 60);
            return `${hours}h limit`;
        }
        if (windowDurationMins < 10080) {
            const days = Math.round(windowDurationMins / 1440);
            return `${days}d limit`;
        }
        return "Weekly limit";
    }

    private formatResetTime(resetsAt: number | null): string {
        if (resetsAt === null) {
            return "";
        }
        const resetDate = new Date(resetsAt * 1000);
        const now = new Date();
        const isToday = resetDate.toDateString() === now.toDateString();

        const timeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

        if (isToday) {
            return ` (resets ${timeStr})`;
        }

        const dateStr = resetDate.toLocaleDateString([], { day: 'numeric', month: 'short' });
        return ` (resets ${timeStr} on ${dateStr})`;
    }

    private formatTokenCount(count: number): string {
        if (count >= 1000000) {
            return `${(count / 1000000).toFixed(1)}M`;
        }
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}K`;
        }
        return count.toString();
    }
}

type ParsedCommand = { name: string; input: string | null };
