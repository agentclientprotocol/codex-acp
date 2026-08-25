import type {
    ClientCapabilities,
    SessionCapabilities,
    SessionNotification,
} from "@agentclientprotocol/sdk";
import {
    AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
    clientSupportsAirCapability,
} from "../AirExtension";

/** Temporary typed surface for agentclientprotocol/agent-client-protocol#1992. */
export type SubagentSessionCapabilities = {
    cancel?: boolean;
    close?: boolean;
    _meta?: Record<string, unknown> | null;
};

export type SubagentSpawnedUpdate = {
    sessionUpdate: "subagent_spawned";
    subagentSessionId: string;
    name: string;
    task: string;
    capabilities: SubagentSessionCapabilities;
    _meta?: Record<string, unknown> | null;
};

export type SubagentState = "completed" | "failed" | "cancelled" | "disconnected";

export type SubagentStateUpdate = {
    sessionUpdate: "subagent_state_update";
    subagentSessionId: string;
    state: SubagentState;
    _meta?: Record<string, unknown> | null;
};

export type AcpSessionUpdate =
    | SessionNotification["update"]
    | SubagentSpawnedUpdate
    | SubagentStateUpdate;

export type AcpSessionNotification = Omit<SessionNotification, "update"> & {
    update: AcpSessionUpdate;
};

export type SubagentAwareSessionCapabilities = SessionCapabilities & {
    subagents?: Record<string, never>;
};

export function clientSupportsSubagents(
    capabilities?: ClientCapabilities | null,
): boolean {
    const subagents = (
        capabilities as (ClientCapabilities & { subagents?: unknown }) | null | undefined
    )?.subagents;
    if (typeof subagents === "object" && subagents !== null && !Array.isArray(subagents)) {
        return true;
    }

    return clientSupportsAirCapability(capabilities, AIR_NATIVE_SUBAGENT_SESSIONS_KEY);
}

/** The only cast needed until the TypeScript SDK publishes PR #1992. */
export function asSdkSessionNotification(
    notification: AcpSessionNotification,
): SessionNotification {
    return notification as SessionNotification;
}
