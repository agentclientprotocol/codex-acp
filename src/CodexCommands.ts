import type * as acp from "@agentclientprotocol/sdk";
import type {AvailableCommand} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection} from "./ACPSessionConnection";
import type {CodexAcpClient} from "./CodexAcpClient";
import type {RateLimitSnapshot, ReviewTarget, SkillsListEntry, SkillsListParams, TurnCompletedNotification} from "./app-server/v2";
import type {SessionState} from "./CodexAcpServer";
import type {RateLimitsMap} from "./RateLimitsMap";
import type {TokenCount} from "./TokenCount";
import {logger} from "./Logger";
import {createAgentTextMessageChunk} from "./ContentChunks";

type ParsedSlashCommand = {
    name: string;
    rest: string;
};

export type CommandHandleResult =
    | { handled: false }
    | { handled: true, turnCompleted?: TurnCompletedNotification };

export type CommandHandleOptions = {
    onTurnStartPending?: () => void;
    onTurnStarted?: (turnId: string, threadId: string) => void;
};

export type LogoutHandler = () => void | Promise<void>;

export class CodexCommands {
    private readonly connection: AcpClientConnection;
    private readonly codexAcpClient: CodexAcpClient;
    private readonly runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>;
    private readonly onLogout: LogoutHandler;

    constructor(
        connection: AcpClientConnection,
        codexAcpClient: CodexAcpClient,
        runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>,
        onLogout: LogoutHandler = () => {}
    ) {
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.runWithProcessCheck = runWithProcessCheck;
        this.onLogout = onLogout;
    }

    async publish(sessionState: SessionState): Promise<void> {
        try {
            const skillsResponse = await this.runWithProcessCheck(() => this.codexAcpClient.listSkills(this.createSkillsListParams(sessionState)));
            const availableCommands = this.buildAvailableCommands(skillsResponse?.data ?? []);
            if (availableCommands.length === 0) {
                return;
            }

            const session = new ACPSessionConnection(this.connection, sessionState.sessionId);
            await session.update({
                sessionUpdate: "available_commands_update",
                availableCommands
            });
        } catch (err) {
            logger.error(`Failed to publish available commands for session ${sessionState.sessionId}`, err);
        }
    }

    private createSkillsListParams(sessionState: SessionState): SkillsListParams {
        return {
            cwds: [sessionState.cwd, ...sessionState.additionalDirectories],
        };
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
                name: "review",
                description: "Review uncommitted changes, or review with custom instructions.",
                input: { hint: "optional review instructions" }
            },
            {
                name: "review-branch",
                description: "Review changes relative to a base branch.",
                input: { hint: "branch name" }
            },
            {
                name: "review-commit",
                description: "Review a specific commit.",
                input: { hint: "commit sha" }
            },
            {
                name: "compact",
                description: "Summarize conversation to avoid hitting the context limit.",
                input: null
            },
            {
                name: "goal",
                description: "Set, pause, resume, or clear a task goal.",
                input: { hint: "[<objective>|clear|pause|resume]" }
            },
            {
                name: "logout",
                description: "Sign out of Codex. This option is available when you are logged in via ChatGPT.",
                input: null
            }
        ];
    }

    private parseCommand(prompt: acp.ContentBlock[]): ParsedSlashCommand | null {
        const firstBlock = prompt[0];
        if (!firstBlock || firstBlock.type != "text") return null;

        const text = firstBlock.text.trim();
        if (!text.startsWith("/")) return null;

        const commandText = text.slice(1).trim();
        if (commandText.length === 0) return null;

        const [name] = commandText.split(/\s+/);
        if (!name) return null;

        return {
            name: name.toLowerCase(),
            rest: commandText.slice(name.length).trim(),
        };
    }

    async tryHandleCommand(
        prompt: acp.ContentBlock[],
        sessionState: SessionState,
        options: CommandHandleOptions = {},
    ): Promise<CommandHandleResult> {
        const command = this.parseCommand(prompt);
        if (command === null) return { handled: false };
        const commandName = command.name;
        if (commandName.startsWith("$")) return { handled: false };

        const sessionId = sessionState.sessionId;
        switch (commandName) {
            case "compact": {
                await this.runWithProcessCheck(() => this.codexAcpClient.runCompact(sessionId));
                return { handled: true };
            }
            case "goal": {
                return await this.runGoalCommand(sessionState, command.rest, options);
            }
            case "review": {
                const target = this.buildReviewTarget(command.rest);
                const turnCompleted = await this.runReviewCommand(sessionState, target, options);
                return { handled: true, turnCompleted };
            }
            case "review-branch": {
                if (command.rest.length === 0) {
                    await this.sendCommandUsageMessage(commandName, "branch name", sessionId);
                    return { handled: true };
                }
                const turnCompleted = await this.runReviewCommand(sessionState, {
                    type: "baseBranch",
                    branch: command.rest,
                }, options);
                return { handled: true, turnCompleted };
            }
            case "review-commit": {
                if (command.rest.length === 0) {
                    await this.sendCommandUsageMessage(commandName, "commit sha", sessionId);
                    return { handled: true };
                }
                const turnCompleted = await this.runReviewCommand(sessionState, {
                    type: "commit",
                    sha: command.rest,
                    title: null,
                }, options);
                return { handled: true, turnCompleted };
            }
            case "status": {
                const session = new ACPSessionConnection(this.connection, sessionId);
                const message = this.buildStatusMessage(sessionState);
                await session.update(createAgentTextMessageChunk(message));
                return { handled: true };
            }
            case "logout": {
                await this.runWithProcessCheck(() => this.codexAcpClient.logout());
                await this.onLogout();
                const session = new ACPSessionConnection(this.connection, sessionId);
                await session.update(createAgentTextMessageChunk("Logged out from Codex account."));
                return { handled: true };
            }
            case "skills": {
                const response = await this.runWithProcessCheck(() => this.codexAcpClient.listSkills(this.createSkillsListParams(sessionState)));
                const skills = (response?.data ?? []).flatMap(entry => entry.skills);
                const lines = skills.map(skill => {
                    const description = skill.shortDescription ?? skill.description ?? "";
                    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
                });
                const text = lines.length > 0
                    ? ["Available skills:", ...lines].join("\n")
                    : "No skills configured.";
                const session = new ACPSessionConnection(this.connection, sessionId);
                await session.update(createAgentTextMessageChunk(text));
                return { handled: true };
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
                await session.update(createAgentTextMessageChunk(text));
                return { handled: true };
            }
            default:
                // Let Codex resolve unrecognized commands as raw prompts.
                return { handled: false };
        }
    }

    private async runReviewCommand(
        sessionState: SessionState,
        target: ReviewTarget,
        options: CommandHandleOptions,
    ): Promise<TurnCompletedNotification> {
        options.onTurnStartPending?.();
        return await this.runWithProcessCheck(() => this.codexAcpClient.runReview(
            sessionState.sessionId,
            target,
            (turnId, threadId) => {
                this.handleCommandTurnStarted(sessionState, options, turnId, threadId);
            },
        ));
    }

    private async runGoalCommand(
        sessionState: SessionState,
        rest: string,
        options: CommandHandleOptions,
    ): Promise<CommandHandleResult> {
        const sessionId = sessionState.sessionId;
        const argument = rest.trim();
        if (argument.length === 0) {
            await this.sendCommandUsageMessage("goal", "[<objective>|clear|pause|resume]", sessionId);
            return { handled: true };
        }

        switch (argument.toLowerCase()) {
            case "pause":
                await this.runWithProcessCheck(() => this.codexAcpClient.setGoalStatus(sessionId, "paused"));
                return { handled: true };
            case "resume":
                options.onTurnStartPending?.();
                return this.createGoalCommandResult(await this.runWithProcessCheck(() => this.codexAcpClient.resumeGoal(
                    sessionId,
                    (turnId) => {
                        this.handleCommandTurnStarted(sessionState, options, turnId, sessionId);
                    },
                )));
            case "clear":
                await this.runWithProcessCheck(() => this.codexAcpClient.clearGoal(sessionId));
                return { handled: true };
        }

        if (argument.length > 4000) {
            const session = new ACPSessionConnection(this.connection, sessionId);
            await session.update(createAgentTextMessageChunk('Command "/goal" requires goal text of at most 4000 characters.'));
            return { handled: true };
        }

        options.onTurnStartPending?.();
        return this.createGoalCommandResult(await this.runWithProcessCheck(() => this.codexAcpClient.setGoal(
            sessionId,
            argument,
            (turnId) => {
                this.handleCommandTurnStarted(sessionState, options, turnId, sessionId);
            },
        )));
    }

    private handleCommandTurnStarted(
        sessionState: SessionState,
        options: CommandHandleOptions,
        turnId: string,
        threadId: string,
    ): void {
        if (options.onTurnStarted) {
            options.onTurnStarted(turnId, threadId);
        } else {
            sessionState.currentTurnId = turnId;
        }
    }

    private createGoalCommandResult(turnCompleted: TurnCompletedNotification | null): CommandHandleResult {
        if (turnCompleted === null) {
            return { handled: true };
        }
        return {
            handled: true,
            turnCompleted,
        };
    }

    private buildReviewTarget(instructions: string): ReviewTarget {
        if (instructions.length === 0) {
            return { type: "uncommittedChanges" };
        }
        return {
            type: "custom",
            instructions,
        };
    }

    private async sendCommandUsageMessage(name: string, inputHint: string, sessionId: string): Promise<void> {
        const session = new ACPSessionConnection(this.connection, sessionId);
        await session.update(createAgentTextMessageChunk(`Command "/${name}" requires ${inputHint}.`));
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

type ParsedCommand = { name: string; };
