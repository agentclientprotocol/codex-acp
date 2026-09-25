import type {UpdateSessionEvent} from "./ACPSessionConnection";
import {logger} from "./Logger";
import {isRecord} from "./permissions/json";

type ToolCallReport = Extract<UpdateSessionEvent, {sessionUpdate: "tool_call" | "tool_call_update"}>;

/** The client appends these metadata values, so the adapter never compares them with an earlier value. */
const OUTPUT_DELTA_META_KEYS = new Set(["terminal_output", "terminal_output_delta", "terminal_input", "mcp_output_delta"]);
const COMPARED_FIELDS = ["title", "kind", "status", "name", "content", "locations", "rawInput", "rawOutput"] as const;
/** The small fields that the adapter keeps for a finished tool call. */
const FINISHED_FIELDS = new Set<string>(["title", "kind", "status", "name"]);
const META_FIELD_PREFIX = "_meta.";
const MAX_FINISHED_TOOL_CALLS = 1024;

/**
 * Keeps the fields that the adapter reported for each open tool call in one session.
 *
 * ACP clients merge a `tool_call_update` into the stored tool call, and a present field replaces the stored value.
 * So an update carries only the top-level fields that changed since the last report.
 * ACP defines no merge for `_meta` keys. AIR replaces a stored `_meta` key with the key of an update,
 * so only AIR also gets `_meta` without the unchanged keys, see `compareMeta`.
 * The record of a tool call shrinks when the tool call reaches a terminal status.
 * A bounded set of finished tool calls keeps the small fields, so that late output chunks can be dropped
 * and a completion after a replayed start does not repeat the status.
 */
export class ToolCallReports {
    private readonly openToolCalls = new Map<string, Map<string, string>>();
    private readonly finishedToolCalls = new Map<string, Map<string, string>>();

    /**
     * Also drop the unchanged `_meta` keys. The adapter sets it for AIR in `initialize`.
     * Every other client gets the whole `_meta` of each report, as before the tool call contract.
     */
    compareMeta = true;

    /**
     * Returns the update to send, without the fields that did not change.
     * Returns `null` when nothing is left to send.
     */
    prepare(sessionId: string, update: UpdateSessionEvent): UpdateSessionEvent | null {
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
            return update;
        }
        const key = `${sessionId}\u0000${update.toolCallId}`;
        const prepared = update.sessionUpdate === "tool_call"
            ? this.recordStart(key, update)
            : this.recordUpdate(key, update);
        if (prepared !== null && (prepared.status === "completed" || prepared.status === "failed")) {
            this.finish(key);
        }
        return prepared;
    }

    /**
     * Forgets the open tool calls of one session when its turn ends, or when a native child session ends.
     * A tool call that never reached a terminal status would otherwise keep its fields until the session closes.
     * A later update for a forgotten tool call carries every field again, which the client merges as usual.
     */
    releaseOpen(sessionId: string): void {
        const prefix = `${sessionId}\u0000`;
        for (const key of [...this.openToolCalls.keys()]) {
            if (key.startsWith(prefix)) this.openToolCalls.delete(key);
        }
    }

    /** Forgets the open record of one tool call. The next update of the tool call carries every field again. */
    forgetOpen(sessionId: string, toolCallId: string): void {
        this.openToolCalls.delete(`${sessionId}\u0000${toolCallId}`);
    }

    private recordStart(key: string, update: ToolCallReport): ToolCallReport {
        this.finishedToolCalls.delete(key);
        const fields = new Map<string, string>();
        for (const [name, value] of reportedFields(update, this.compareMeta)) {
            fields.set(name, value);
        }
        this.openToolCalls.set(key, fields);
        return update;
    }

    private recordUpdate(key: string, update: ToolCallReport): ToolCallReport | null {
        const finished = this.finishedToolCalls.get(key);
        if (finished !== undefined) {
            const current = this.withoutLateOutput(update);
            return current === null ? null : this.withoutUnchangedFields(current, finished, FINISHED_FIELDS);
        }
        const fields = this.openToolCalls.get(key) ?? new Map<string, string>();
        this.openToolCalls.set(key, fields);
        return this.withoutUnchangedFields(update, fields);
    }

    /** Drops the fields whose value `fields` already has, and records the other fields, or only `recorded` ones. */
    private withoutUnchangedFields(
        update: ToolCallReport,
        fields: Map<string, string>,
        recorded?: Set<string>,
    ): ToolCallReport | null {
        const prepared: Record<string, unknown> = {...update};
        const meta = isRecord(update._meta) ? {...update._meta} : undefined;
        for (const [name, value] of reportedFields(update, this.compareMeta)) {
            if (fields.get(name) === value) {
                if (name.startsWith(META_FIELD_PREFIX)) {
                    delete meta?.[name.slice(META_FIELD_PREFIX.length)];
                } else {
                    delete prepared[name];
                }
                continue;
            }
            if (recorded === undefined || recorded.has(name)) fields.set(name, value);
        }
        if (meta !== undefined) {
            if (Object.keys(meta).length > 0) {
                prepared["_meta"] = meta;
            } else {
                delete prepared["_meta"];
            }
        }
        return hasPayload(prepared) ? prepared as ToolCallReport : null;
    }

    private withoutLateOutput(update: ToolCallReport): ToolCallReport | null {
        // An update with a status is a completion report, for example after a history replay
        // started the tool call with its final status. Its output is not late.
        if (update.status != null || !isRecord(update._meta)) {
            return update;
        }
        const meta = {...update._meta};
        const dropped = Object.keys(meta).filter(name => OUTPUT_DELTA_META_KEYS.has(name));
        if (dropped.length === 0) {
            return update;
        }
        for (const name of dropped) {
            delete meta[name];
        }
        logger.log("Dropped output for a finished tool call", {toolCallId: update.toolCallId, keys: dropped});
        const prepared: Record<string, unknown> = {...update};
        if (Object.keys(meta).length > 0) {
            prepared["_meta"] = meta;
        } else {
            delete prepared["_meta"];
        }
        return hasPayload(prepared) ? prepared as ToolCallReport : null;
    }

    private finish(key: string): void {
        const fields = this.openToolCalls.get(key) ?? this.finishedToolCalls.get(key) ?? new Map<string, string>();
        this.openToolCalls.delete(key);
        this.finishedToolCalls.delete(key);
        this.finishedToolCalls.set(key, new Map([...fields].filter(([name]) => FINISHED_FIELDS.has(name))));
        if (this.finishedToolCalls.size > MAX_FINISHED_TOOL_CALLS) {
            const oldest = this.finishedToolCalls.keys().next().value;
            if (oldest !== undefined) this.finishedToolCalls.delete(oldest);
        }
    }
}

function reportedFields(update: ToolCallReport, withMeta: boolean): Array<[string, string]> {
    const fields: Array<[string, string]> = [];
    const record = update as Record<string, unknown>;
    for (const name of COMPARED_FIELDS) {
        const value = record[name];
        if (value !== undefined) fields.push([name, JSON.stringify(value)]);
    }
    if (withMeta && isRecord(update._meta)) {
        for (const [name, value] of Object.entries(update._meta)) {
            if (value === undefined || OUTPUT_DELTA_META_KEYS.has(name)) continue;
            fields.push([`${META_FIELD_PREFIX}${name}`, JSON.stringify(value)]);
        }
    }
    return fields;
}

function hasPayload(update: Record<string, unknown>): boolean {
    return Object.keys(update).some(name => name !== "sessionUpdate" && name !== "toolCallId");
}
