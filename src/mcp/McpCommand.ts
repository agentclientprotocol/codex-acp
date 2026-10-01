import type {CodexAcpClient} from "../CodexAcpClient";
import type {McpServerStatus} from "../app-server/v2";
import type {SessionState} from "../CodexAcpServer";
import {isThreadNotFoundError, isUnknownThreadError} from "../CodexThreadErrors";
import {logger} from "../Logger";
import {listMcpServerStatus} from "./McpServerStatusList";
import type {McpServerSignIn} from "./McpServerSignIn";
import type {McpStartupResult} from "./McpStartupTracker";
import {
    formatNoteDetail,
    formatStatus,
    inlineCode,
    type McpServerEntry,
    NO_SERVERS_MESSAGE,
    toEntry,
} from "./McpStatusMarkdown";

/** The maximum time that `/mcp reconnect` waits for the MCP servers to start. */
export const MCP_RECONNECT_STARTUP_TIMEOUT_MS = 30_000;

export const MCP_COMMAND_INPUT_HINT = "[reconnect [server]]";

/** The MCP servers of a session. `live` is false when the list has no live status of the session thread. */
type McpServerList = {
    servers: McpServerEntry[];
    live: boolean;
};

/** The result of one reload. A `null` startup means that some servers were still starting at the timeout. */
type ReloadResult = {
    error: string | null;
    startup: McpStartupResult | null;
    list: McpServerList;
};

/** Runs `/mcp` and `/mcp reconnect [server]`, and returns the markdown answer. */
export class McpCommand {
    private readonly codexAcpClient: CodexAcpClient;
    private readonly runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>;
    private readonly signIn: McpServerSignIn;

    constructor(
        codexAcpClient: CodexAcpClient,
        runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>,
        signIn: McpServerSignIn,
    ) {
        this.codexAcpClient = codexAcpClient;
        this.runWithProcessCheck = runWithProcessCheck;
        this.signIn = signIn;
    }

    /** Returns the answer, or `null` when `signal` aborted. After an abort, the caller must send nothing. */
    async run(rest: string, sessionState: SessionState, signal?: AbortSignal): Promise<string | null> {
        const args = rest.split(/\s+/).filter(arg => arg.length > 0);
        if (args.length === 0) {
            const list = await this.listServers(sessionState);
            return signal?.aborted ? null : formatStatus(list.servers, new Map());
        }
        if (args[0]!.toLowerCase() === "reconnect" && args.length <= 2) {
            return await this.reconnect(sessionState, args[1] ?? null, signal);
        }
        return `Command "/mcp" accepts no arguments, or \`reconnect [server]\`.`;
    }

    private async reconnect(sessionState: SessionState, serverName: string | null, signal?: AbortSignal): Promise<string | null> {
        const before = await this.listServers(sessionState);
        if (before.servers.length === 0) {
            return NO_SERVERS_MESSAGE;
        }
        if (serverName !== null && !before.servers.some(server => server.name === serverName)) {
            const knownNames = before.servers.map(server => inlineCode(server.name)).join(", ");
            return `Unknown MCP server ${inlineCode(serverName)}. Known servers: ${knownNames}.`;
        }

        const notes: string[] = [];
        if (serverName !== null) {
            notes.push(`Codex cannot reconnect a single server. The reload applies to all MCP servers, not only ${inlineCode(serverName)}.`);
        }

        let reload = await this.reloadAndWait(sessionState, signal);
        if (reload.error !== null) {
            notes.push(`Could not reload the MCP configuration: ${formatNoteDetail(reload.error)}`);
        } else {
            notes.push(RELOAD_NOTE);
            const signIn = await this.signInServers(sessionState, reload, signal);
            notes.push(...signIn.notes);
            if (signIn.signedIn && !signal?.aborted) {
                const secondReload = await this.reloadAndWait(sessionState, signal);
                if (secondReload.error !== null) {
                    notes.push(`Could not reload the MCP configuration after the sign-in: ${formatNoteDetail(secondReload.error)}`);
                    reload = {...secondReload, startup: reload.startup};
                } else {
                    reload = secondReload;
                }
            }
        }

        if (signal?.aborted) {
            return null;
        }
        if (reload.startup === null) {
            notes.push("Some MCP servers are still starting. Run `/mcp` again later to see their status.");
        }
        return `${formatNotes(notes)}\n\n${formatStatus(reload.list.servers, startupErrors(reload.startup))}`;
    }

    /** Reloads the MCP configuration, and waits for the startup of the servers that the reloaded list contains. */
    private async reloadAndWait(sessionState: SessionState, signal: AbortSignal | undefined): Promise<ReloadResult> {
        const afterVersion = this.codexAcpClient.getMcpServerStartupVersion();
        try {
            await this.runWithProcessCheck(() => this.codexAcpClient.reloadMcpServers());
        } catch (err) {
            logger.error(`Failed to reload the MCP configuration for session ${sessionState.sessionId}`, err);
            return {error: errorMessage(err), startup: emptyStartupResult(), list: await this.listServers(sessionState)};
        }
        const reloaded = await this.listServers(sessionState);
        if (!reloaded.live) {
            // Without the live status, Codex sends no startup events for the session thread.
            return {error: null, startup: emptyStartupResult(), list: reloaded};
        }
        const serverNames = reloaded.servers
            .filter(server => server.listedByCodex && server.status !== "disabled")
            .map(server => server.name);
        const startup = await this.waitForStartup(sessionState.sessionId, serverNames, afterVersion, signal);
        if (signal?.aborted) {
            return {error: null, startup, list: reloaded};
        }
        return {error: null, startup, list: await this.listServers(sessionState)};
    }

    /** Returns `null` at the timeout or when `signal` aborts. */
    private async waitForStartup(
        threadId: string,
        serverNames: string[],
        afterVersion: number,
        signal: AbortSignal | undefined,
    ): Promise<McpStartupResult | null> {
        if (signal?.aborted) {
            return null;
        }
        const stop = new AbortController();
        const onAbort = () => stop.abort();
        signal?.addEventListener("abort", onAbort, {once: true});
        const timer = setTimeout(() => stop.abort(), MCP_RECONNECT_STARTUP_TIMEOUT_MS);
        try {
            return await this.runWithProcessCheck(() => this.codexAcpClient.awaitMcpServerStartup(
                serverNames,
                afterVersion,
                {threadId, signal: stop.signal},
            ));
        } catch (err) {
            if (stop.signal.aborted) {
                return null;
            }
            throw err;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    }

    private async signInServers(
        sessionState: SessionState,
        reload: ReloadResult,
        signal: AbortSignal | undefined,
    ): Promise<{notes: string[], signedIn: boolean}> {
        const names = new Set(reload.list.servers.filter(server => server.status === "authenticationRequired").map(server => server.name));
        for (const failure of reload.startup?.failed ?? []) {
            if (failure.failureReason === "reauthenticationRequired") {
                names.add(failure.server);
            }
        }
        const notes: string[] = [];
        let signedIn = false;
        for (const name of names) {
            if (signal?.aborted) {
                break;
            }
            const label = inlineCode(name);
            switch (await this.signIn(sessionState.sessionId, name, signal)) {
                case "unsupported":
                    notes.push(`MCP server ${label} needs authentication, but this client cannot open a sign-in page.`);
                    break;
                case "signedIn":
                    notes.push(`Signed in to MCP server ${label}.`);
                    signedIn = true;
                    break;
                case "failed":
                    notes.push(`The sign-in to MCP server ${label} failed or was cancelled.`);
                    break;
            }
        }
        return {notes, signedIn};
    }

    private async listServers(sessionState: SessionState): Promise<McpServerList> {
        const {servers, live} = await this.listServerStatus(sessionState.sessionId);
        const entries = servers.map(toEntry);
        for (const name of sessionState.sessionMcpServers ?? []) {
            if (!entries.some(entry => entry.name === name)) {
                entries.push({name, status: null, toolCount: null, toolsError: null, authStatus: null, listedByCodex: false});
            }
        }
        return {servers: entries, live};
    }

    private async listServerStatus(threadId: string): Promise<{servers: McpServerStatus[], live: boolean}> {
        try {
            const servers = await this.runWithProcessCheck(() => listMcpServerStatus(this.codexAcpClient, threadId));
            return {servers, live: true};
        } catch (err) {
            if (!isThreadNotFoundError(err) && !isUnknownThreadError(err)) {
                throw err;
            }
            // The list without a thread has no live status.
            logger.log(`Codex does not know thread ${threadId}, so the MCP server list has no live status`);
            const servers = await this.runWithProcessCheck(() => listMcpServerStatus(this.codexAcpClient));
            return {servers, live: false};
        }
    }
}

const RELOAD_NOTE = "Reloaded the MCP configuration of all open sessions. "
    + "Codex restarted the servers that failed, stopped, or changed. "
    + "A connected server with unchanged settings keeps its connection.";

function startupErrors(result: McpStartupResult | null): Map<string, string> {
    return new Map((result?.failed ?? []).map(failure => [failure.server, failure.error]));
}

function emptyStartupResult(): McpStartupResult {
    return {ready: [], failed: [], cancelled: []};
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/** Formats the reconnect notes as a list under a bold label, so that each note is a separate item. */
function formatNotes(notes: string[]): string {
    return ["**Reconnect:**", ...notes.map(note => `- ${note}`)].join("\n");
}
