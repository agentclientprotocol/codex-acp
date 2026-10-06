import * as acp from "@agentclientprotocol/sdk";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {CodexAcpClient} from "../CodexAcpClient";
import {logger} from "../Logger";
import {sanitizeMcpServerName} from "../McpServerName";
import {settledWithin} from "../StdUtils";
import {AcpToolCallRenderer} from "../tool-calls/AcpToolCallRenderer";
import type {ClientCapabilities} from "../tool-calls/ClientCapabilities";
import {McpStartupReporter} from "../tool-calls/reporters/McpStartupReporter";
import type {McpServerSignIn} from "./McpServerSignIn";
import type {McpStartupResult} from "./McpStartupTracker";

interface PendingMcpStartupSession {
    requestedServers: Set<string>;
    skippedServers: Array<string>;
    startup: Promise<McpStartupResult>;
    /** Stops the startup wait and the sign-in of the startup report. */
    abort: AbortController;
}

/** The options of {@link McpSessionStartup.begin}. */
export interface McpSessionStartupOptions {
    /** When false, the session gets no startup report, and nothing waits for the rest of the startup. */
    publish: boolean;
    /** When positive, `begin` waits for the startup at most this time. */
    awaitTimeoutMs?: number | undefined;
    /** The requested servers that the Codex config already defines. Nothing waits for them, and the report shows them. */
    skippedServers?: Array<string> | undefined;
}

/**
 * Reports the MCP server startup of a session. The report shows the servers that failed to start, and the requested
 * servers that Codex replaces with its own entry.
 * Before the report, it signs in to each server that needs authentication.
 */
export class McpSessionStartup {
    private readonly connection: AcpClientConnection;
    private readonly codexAcpClient: () => CodexAcpClient;
    private readonly runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>;
    private readonly signIn: McpServerSignIn;
    private readonly capabilities: () => ClientCapabilities;
    /** True when the session is open and does not close. */
    private readonly isSessionOpen: (sessionId: string) => boolean;
    private readonly pendingSessions = new Map<string, PendingMcpStartupSession>();

    constructor(
        connection: AcpClientConnection,
        codexAcpClient: () => CodexAcpClient,
        runWithProcessCheck: <T>(operation: () => Promise<T>) => Promise<T>,
        signIn: McpServerSignIn,
        capabilities: () => ClientCapabilities,
        isSessionOpen: (sessionId: string) => boolean,
    ) {
        this.connection = connection;
        this.codexAcpClient = codexAcpClient;
        this.runWithProcessCheck = runWithProcessCheck;
        this.signIn = signIn;
        this.capabilities = capabilities;
        this.isSessionOpen = isSessionOpen;
    }

    /**
     * Starts the startup wait of the session and publishes the report when the startup ends.
     * It returns a promise only when it waits for the startup, and returns null otherwise.
     * The promise rejects when the startup fails before `awaitTimeoutMs`. Then the session has no pending startup.
     */
    begin(
        sessionId: string,
        mcpServers: Array<acp.McpServer>,
        afterVersion: number,
        options: McpSessionStartupOptions,
    ): Promise<void> | null {
        const pendingStartup = this.createPendingSession(sessionId, mcpServers, afterVersion, options.skippedServers ?? []);
        if (options.publish) {
            this.pendingSessions.set(sessionId, pendingStartup);
        }
        const awaitTimeoutMs = options.awaitTimeoutMs;
        if (awaitTimeoutMs !== undefined && awaitTimeoutMs > 0) {
            const startupWait = settledWithin(pendingStartup.startup, awaitTimeoutMs).then(() => undefined);
            // These handlers run before the caller resumes, because the caller awaits the same promise after them.
            void startupWait.then(
                () => this.publishOrAbort(sessionId, pendingStartup, options.publish),
                () => this.forget(sessionId, pendingStartup),
            );
            return startupWait;
        }
        this.publishOrAbort(sessionId, pendingStartup, options.publish);
        return null;
    }

    /** Stops the startup wait and the sign-in of the session. */
    close(sessionId: string): void {
        this.pendingSessions.get(sessionId)?.abort.abort();
        this.pendingSessions.delete(sessionId);
    }

    isPending(sessionId: string): boolean {
        return this.pendingSessions.has(sessionId);
    }

    private publishOrAbort(sessionId: string, pendingStartup: PendingMcpStartupSession, publish: boolean): void {
        if (publish) {
            this.publishAsync(sessionId);
        } else {
            pendingStartup.abort.abort();
        }
    }

    private forget(sessionId: string, pendingStartup: PendingMcpStartupSession): void {
        if (this.pendingSessions.get(sessionId) === pendingStartup) {
            this.pendingSessions.delete(sessionId);
        }
    }

    private publishAsync(sessionId: string): void {
        void this.doPublish(sessionId);
    }

    private createPendingSession(
        sessionId: string,
        mcpServers: Array<acp.McpServer>,
        afterVersion: number,
        skippedServers: Array<string>,
    ): PendingMcpStartupSession {
        const requestedServers = new Set(getRequestedMcpServerNames(mcpServers)
            .filter(server => !skippedServers.includes(server)));
        const abort = new AbortController();
        const startup = this.runWithProcessCheck(() => this.codexAcpClient().awaitMcpServerStartup(
            Array.from(requestedServers),
            afterVersion,
            {threadId: sessionId, signal: abort.signal},
        ));
        // An abort can reject the startup before a caller awaits it.
        void startup.catch(() => {});
        return {requestedServers, skippedServers, startup, abort};
    }

    private async doPublish(sessionId: string): Promise<void> {
        const pendingStartup = this.pendingSessions.get(sessionId);
        if (!pendingStartup) {
            return;
        }

        try {
            const mcpStartup = await pendingStartup.startup;
            if (!this.isSessionOpen(sessionId)
                || this.pendingSessions.get(sessionId) !== pendingStartup) {
                return;
            }
            await this.publish(sessionId, mcpStartup, pendingStartup);
        } catch (err) {
            if (!pendingStartup.abort.signal.aborted) {
                logger.error(`Failed to publish MCP startup status for session ${sessionId}`, err);
            }
        } finally {
            this.forget(sessionId, pendingStartup);
        }
    }

    private async publish(
        sessionId: string,
        mcpStartup: McpStartupResult,
        pendingStartup: PendingMcpStartupSession,
    ): Promise<void> {
        const {requestedServers, skippedServers, abort: {signal}} = pendingStartup;
        const filteredStartup = {
            ready: mcpStartup.ready.filter(server => requestedServers.has(server)),
            failed: mcpStartup.failed.filter(server => requestedServers.has(server.server)),
            cancelled: mcpStartup.cancelled.filter(server => requestedServers.has(server)),
        };

        const failuresAfterOauth: typeof filteredStartup.failed = [];
        const readyAfterOauth = [...filteredStartup.ready];
        for (const failure of filteredStartup.failed) {
            const signIn = failure.failureReason === "reauthenticationRequired"
                ? await this.signIn(sessionId, failure.server, signal)
                : "unsupported";
            if (signIn === "signedIn") {
                readyAfterOauth.push(failure.server);
            } else {
                failuresAfterOauth.push(failure);
            }
        }
        if (signal.aborted) {
            return;
        }

        const renderer = new AcpToolCallRenderer(this.capabilities());
        for (const facts of [
            ...McpStartupReporter.skipped(skippedServers),
            ...McpStartupReporter.failures({
                ...filteredStartup,
                ready: readyAfterOauth,
                failed: failuresAfterOauth,
            }),
        ]) {
            await this.connection.notify(acp.methods.client.session.update, {
                sessionId,
                update: renderer.render(facts),
            });
        }
    }
}

export function getRequestedMcpServerNames(mcpServers: Array<acp.McpServer>): Array<string> {
    return Array.from(new Set(mcpServers.map(server => sanitizeMcpServerName(server.name))));
}

const MCP_STARTUP_AWAIT_TIMEOUT_META_KEY = "mcpStartupAwaitTimeoutMs";

export function parseMcpStartupAwaitTimeoutMs(meta: Record<string, unknown> | null | undefined): number | undefined {
    const value = meta?.[MCP_STARTUP_AWAIT_TIMEOUT_META_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
