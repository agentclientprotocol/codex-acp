import {randomUUID} from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {CodexAcpClient} from "../CodexAcpClient";
import {clientSupportsUrlElicitation} from "../ElicitationCapabilities";
import {logger} from "../Logger";

/** The result of an MCP OAuth sign-in. `unsupported` means that the client cannot open a sign-in URL. */
export type McpSignInResult = "signedIn" | "failed" | "unsupported";

/**
 * Signs in to an MCP server for a session. It never throws: an error is a `failed` result.
 * When `signal` aborts, the sign-in closes its dialog, stops the wait, and returns `failed`.
 */
export type McpServerSignIn = (sessionId: string, serverName: string, signal?: AbortSignal) => Promise<McpSignInResult>;

/**
 * Creates the MCP OAuth sign-in. The sign-in opens the authorization URL through an ACP URL elicitation,
 * so it works only when the client supports URL elicitation.
 */
export function createMcpServerSignIn(
    connection: AcpClientConnection,
    codexAcpClient: () => CodexAcpClient,
    clientCapabilities: () => acp.ClientCapabilities | null,
): McpServerSignIn {
    return async (sessionId, serverName, signal) => {
        if (!clientSupportsUrlElicitation(clientCapabilities())) {
            return "unsupported";
        }
        try {
            return await signInWithUrlElicitation(connection, codexAcpClient(), sessionId, serverName, signal)
                ? "signedIn"
                : "failed";
        } catch (err) {
            if (!signal?.aborted) {
                logger.error(`Failed to authenticate MCP server ${serverName}`, err);
            }
            return "failed";
        }
    };
}

async function signInWithUrlElicitation(
    connection: AcpClientConnection,
    codexAcpClient: CodexAcpClient,
    sessionId: string,
    serverName: string,
    signal: AbortSignal | undefined,
): Promise<boolean> {
    signal?.throwIfAborted();
    // The stop ends the completion wait on every exit, so a declined or aborted sign-in leaves no waiter.
    const stop = new AbortController();
    const onAbort = () => stop.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, {once: true});
    const stopped = new Promise<never>((_, reject) => {
        stop.signal.addEventListener("abort", () => reject(stop.signal.reason), {once: true});
    });
    void stopped.catch(() => {});
    const elicitationId = `mcp-oauth-${randomUUID()}`;
    /** True while the client shows the dialog that the sign-in must close. */
    let dialogOpen = false;
    try {
        const completed = codexAcpClient.awaitMcpServerOauthLoginCompleted(serverName, sessionId, stop.signal);
        void completed.catch(() => {});
        const login = await Promise.race([
            codexAcpClient.mcpServerOauthLogin({name: serverName, threadId: sessionId}),
            stopped,
        ]);
        const elicitation = Promise.resolve(connection.request(
            acp.methods.client.elicitation.create,
            {
                mode: "url",
                sessionId,
                message: `Authenticate with MCP server ${serverName}`,
                url: login.authorizationUrl,
                elicitationId,
            },
        ));
        void elicitation.catch(() => {});
        dialogOpen = true;
        const first = await Promise.race([
            completed.then(result => ({type: "completed" as const, result})),
            elicitation.then(response => ({type: "elicitation" as const, response})),
            stopped,
        ]);
        if (first.type === "elicitation" && !acp.CreateElicitationResponse.isAccept(first.response)) {
            dialogOpen = false;
            return false;
        }
        const result = first.type === "completed" ? first.result : await Promise.race([completed, stopped]);
        return result.success;
    } finally {
        stop.abort();
        signal?.removeEventListener("abort", onAbort);
        if (dialogOpen) {
            await connection.notify(acp.methods.client.elicitation.complete, {elicitationId});
        }
    }
}
