import type {
    ClientCapabilities,
    SessionCapabilities,
} from "@agentclientprotocol/sdk/unstable";
import {
    AIR_NATIVE_SUBAGENT_SESSIONS_KEY,
    clientSupportsAirCapability,
    isAirClient,
} from "../AirExtension";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";

/** AIR's existing private contract, retained independently of standard subagent sessions. */
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

export type SubagentAwareSessionCapabilities = SessionCapabilities & {
    subagents?: Record<string, never>;
};

export type SubagentProtocol = "hidden" | "air" | "standard";

/** Standard snapshots share their wire shape across versions; controls remain deliberately empty. */
export type StandardSubagentUpdate = Omit<acpV2.SubagentUpdate, "capabilities"> & {
    sessionUpdate: "subagent_update";
    capabilities?: Record<string, never>;
};

export function subagentProtocol(
    capabilities?: ClientCapabilities | null,
    version: 1 | 2 = 1,
): SubagentProtocol {
    const subagents = (
        capabilities as (ClientCapabilities & { subagents?: unknown }) | null | undefined
    )?.subagents;
    const standard = typeof subagents === "object" && subagents !== null && !Array.isArray(subagents);
    const air = isAirClient(capabilities);
    if (clientSupportsAirCapability(capabilities, AIR_NATIVE_SUBAGENT_SESSIONS_KEY)
        || (version === 1 && air && standard)) return "air";
    // AIR keeps its existing opt-in and fallback until its client migrates to the standard contract.
    if (air) return "hidden";
    return version === 2 || standard ? "standard" : "hidden";
}
