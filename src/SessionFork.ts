import {createHash} from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, ThreadForkParams} from "./app-server/v2";
import type {SessionMetadata} from "./SessionMetadata";

export type SessionForkDependencies = {
    codexClient: CodexAppServerClient;
    refreshSkills(cwd: string, additionalDirectories: string[]): Promise<void>;
    createSessionConfig(
        cwd: string,
        additionalDirectories: string[],
        mcpServers: acp.McpServer[],
    ): Promise<NonNullable<ThreadForkParams["config"]>>;
    getResumeModelProviderParams(): Promise<{modelProvider?: string}>;
    fetchAvailableModels(): Promise<Model[]>;
    createCurrentModelId(models: Model[], model: string, reasoningEffort: string | null): string;
    getCollaborationMode(sessionId: string): ModeKind;
};

export async function forkSession(
    request: acp.ForkSessionRequest,
    additionalDirectories: string[],
    dependencies: SessionForkDependencies,
): Promise<SessionMetadata> {
    await dependencies.refreshSkills(request.cwd, additionalDirectories);
    const lastTurnId = await resolveForkTurnId(request, dependencies.codexClient);
    const response = await dependencies.codexClient.threadFork({
        config: await dependencies.createSessionConfig(
            request.cwd,
            additionalDirectories,
            request.mcpServers ?? [],
        ),
        cwd: request.cwd,
        ...(lastTurnId !== undefined && {lastTurnId}),
        ...(await dependencies.getResumeModelProviderParams()),
        threadId: request.sessionId,
    });
    await dependencies.codexClient.threadUnsubscribe({threadId: response.thread.id});

    const models = await dependencies.fetchAvailableModels();
    return {
        sessionId: response.thread.id,
        currentModelId: dependencies.createCurrentModelId(models, response.model, response.reasoningEffort),
        models,
        collaborationMode: dependencies.getCollaborationMode(response.thread.id),
        modelProvider: response.modelProvider,
        currentServiceTier: response.serviceTier as ServiceTier ?? null,
        additionalDirectories,
    };
}

async function resolveForkTurnId(
    request: acp.ForkSessionRequest,
    codexClient: CodexAppServerClient,
): Promise<string | undefined> {
    const forkPoint = readAirForkPoint(request._meta);
    if (!forkPoint) return undefined;

    const history = await codexClient.threadRead({
        threadId: request.sessionId,
        includeTurns: true,
    });
    const candidateIds = airForkMessageIdCandidates(forkPoint.messageId);
    const itemTurnId = candidateIds
        .map(candidateId => history.thread.turns.find(turn => turn.items.some(item => item.id === candidateId))?.id)
        .find(turnId => turnId !== undefined);
    if (itemTurnId) return itemTurnId;

    if (forkPoint.messageFingerprint) {
        const matchingTurns = history.thread.turns.flatMap(turn => turn.items
            .filter(item => item.type === "agentMessage"
                && fingerprintAgentMessage(item.text) === forkPoint.messageFingerprint)
            .map(() => turn.id));
        const fingerprintTurnId = matchingTurns[forkPoint.messageOccurrence - 1];
        if (fingerprintTurnId) return fingerprintTurnId;
    }

    throw RequestError.invalidParams(
        {messageId: forkPoint.messageId},
        `Fork point message ${forkPoint.messageId} was not found in session ${request.sessionId}`,
    );
}

type AirForkPoint = {
    messageId: string;
    messageFingerprint?: string;
    messageOccurrence: number;
};

function readAirForkPoint(meta?: Record<string, unknown> | null): AirForkPoint | undefined {
    const jetbrains = meta?.["jetbrains"];
    if (!isUnknownRecord(jetbrains)) return undefined;
    const air = jetbrains["air"];
    if (!isUnknownRecord(air)) return undefined;
    const fork = air["fork"];
    if (!isUnknownRecord(fork) || fork["version"] !== 1) return undefined;
    const messageId = fork["messageId"];
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
        throw RequestError.invalidParams(undefined, "AIR fork messageId must be a non-empty string");
    }
    const messageFingerprint = fork["messageFingerprint"];
    if (messageFingerprint !== undefined
        && (typeof messageFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(messageFingerprint))) {
        throw RequestError.invalidParams(undefined, "AIR fork messageFingerprint must be a SHA-256 fingerprint");
    }
    const messageOccurrence = fork["messageOccurrence"] ?? 1;
    if (!Number.isSafeInteger(messageOccurrence) || (messageOccurrence as number) < 1) {
        throw RequestError.invalidParams(undefined, "AIR fork messageOccurrence must be a positive integer");
    }
    return {
        messageId: messageId.trim(),
        ...(typeof messageFingerprint === "string" && {messageFingerprint}),
        messageOccurrence: messageOccurrence as number,
    };
}

function fingerprintAgentMessage(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function airForkMessageIdCandidates(messageId: string): string[] {
    // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
    const visibleSegmentSuffix = /:segment:\d+$/;
    const protocolMessageId = messageId.replace(visibleSegmentSuffix, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
