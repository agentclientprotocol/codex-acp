import {canonical, type RecordedMessage} from "./scenario-harness";

/**
 * The comparison of the messages for a client that is not AIR with the messages of the adapter before the AIR extensions.
 *
 * `data/baseline/<profile>/<scenario>.jsonl` holds the messages that origin/main at {@link BASELINE_COMMIT} sends.
 * The functions here apply the allowed differences of the compatibility rule in `docs/air-extensions.md`.
 * The messages of the current adapter must then equal the baseline.
 *
 * To record the baseline again, copy `src/__tests__/scenarios/` to a checkout of the baseline commit and run
 * `RECORD_SCENARIO_BASELINE=1 npx vitest run src/__tests__/scenarios/client-profiles.test.ts -t baseline` there.
 * Then copy `data/baseline/` back.
 */
export const BASELINE_COMMIT = "1cc62233fb6f2abde7cadd518a53de9d0826ea77";

type Json = Record<string, unknown>;

export type MetaObject = {meta: Json; owner: Json};

/** Every `_meta` object of the messages with the object that holds it, except inside `rawInput` and `rawOutput`. */
export function metaObjects(value: unknown): MetaObject[] {
    if (value === null || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(metaObjects);
    const owner = value as Json;
    return Object.entries(owner).flatMap(([key, child]) => {
        if (key === "rawInput" || key === "rawOutput") return [];
        if (key === "_meta" && child !== null && typeof child === "object") {
            return [{meta: child as Json, owner}, ...metaObjects(child)];
        }
        return metaObjects(child);
    });
}

const AIR_ONLY_CODEX_KEYS = ["phase", "subagent", "collaboration", "kind", "planItemId"];

/**
 * The metadata keys that exist only for AIR, including the keys that AIR used before `_meta.jetbrains.air`.
 * The `kind` of a diff is the ACP diff kind, not the AIR mode kind.
 */
export function airOnlyKeys({meta, owner}: MetaObject): string[] {
    const codex = meta["codex"] as Json | undefined;
    const keys = ["jetbrains", "goal", "commandAction", "permission", "contextCompaction",
        ...(owner["type"] === "diff" ? [] : ["kind"])];
    return [
        ...keys.filter(key => key in meta),
        ...AIR_ONLY_CODEX_KEYS
            .filter(key => codex !== undefined && codex !== null && typeof codex === "object" && key in codex)
            .map(key => `codex.${key}`),
    ];
}

/** The value without the AIR-only keys. A `_meta` without keys is removed. */
function withoutAirOnlyKeys(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(withoutAirOnlyKeys);
    const owner = value as Json;
    const result: Json = {};
    for (const [key, child] of Object.entries(owner)) {
        if (key === "rawInput" || key === "rawOutput") {
            result[key] = child;
            continue;
        }
        if (key !== "_meta" || child === null || typeof child !== "object" || Array.isArray(child)) {
            result[key] = withoutAirOnlyKeys(child);
            continue;
        }
        const meta = structuredClone(child) as Json;
        for (const airKey of airOnlyKeys({meta, owner})) {
            if (!airKey.startsWith("codex.")) {
                delete meta[airKey];
                continue;
            }
            const codex = meta["codex"] as Json;
            delete codex[airKey.slice("codex.".length)];
            if (Object.keys(codex).length === 0) delete meta["codex"];
        }
        const kept = withoutAirOnlyKeys(meta) as Json;
        if (Object.keys(kept).length > 0) result[key] = kept;
    }
    return result;
}

function sessionUpdate(message: RecordedMessage): Json | undefined {
    return message.method === "session/update" ? (message.params as {update: Json}).update : undefined;
}

/**
 * The client gets no AIR-only key. A `session_info_update` that had only AIR-only keys, such as a goal, is not sent.
 */
function withoutAirOnlyMessages(messages: RecordedMessage[]): RecordedMessage[] {
    return (withoutAirOnlyKeys(messages) as RecordedMessage[]).filter(message => {
        const update = sessionUpdate(message);
        return update === undefined || update["sessionUpdate"] !== "session_info_update" || Object.keys(update).length > 1;
    });
}

/** The result of a dynamic tool that the baseline did not send, by scenario and tool call id. */
const DYNAMIC_TOOL_RESULTS: Record<string, Record<string, string>> = {
    "dynamic-tool": {"dyn-1": "Found 2 apps"},
    "history-replay": {"h-dyn": "No apps"},
};

/**
 * The bug fixes of the compatibility rule that change the messages of the scenarios:
 * - the MCP startup tool call id is unique, so it ends with a random id;
 * - the report that completes a dynamic tool call has the result of the tool in `content`.
 */
function withBugFixes(scenario: string, messages: RecordedMessage[]): RecordedMessage[] {
    const results = {...DYNAMIC_TOOL_RESULTS[scenario]};
    return messages.map(message => {
        const update = sessionUpdate(message);
        if (update === undefined || typeof update["toolCallId"] !== "string") return message;
        const toolCallId = update["toolCallId"];
        const fixed: Json = {...update};
        if (/^mcp_startup\.[^.]+$/.test(toolCallId)) fixed["toolCallId"] = `${toolCallId}.<uuid>`;
        const result = results[toolCallId];
        if (result !== undefined && update["status"] === "completed") {
            fixed["content"] = [{type: "content", content: {type: "text", text: result}}];
            delete results[toolCallId];
        }
        return {...message, params: {...(message.params as Json), update: fixed}};
    });
}

const OUTPUT_CHUNK_KEYS = ["terminal_output", "terminal_output_delta"];

/**
 * The output of each command as one text, however it arrived.
 *
 * The adapter sends the output of a command once: as chunks when the client has a chunk channel for the command,
 * and as `content` text otherwise. Before the tool call contract it sent `rawOutput.formatted_output` as well. The
 * function removes the chunks, the output text and `formatted_output`, and it puts the text on the last report of the
 * tool call in `output`.
 * An exit code that `terminal_exit` carries is removed from `rawOutput`.
 */
export function withOutputOnce(messages: RecordedMessage[]): RecordedMessage[] {
    const chunks = new Map<string, string>();
    const formatted = new Map<string, string>();
    const last = new Map<string, number>();
    const result = messages.map((message, index) => {
        const update = sessionUpdate(message);
        if (update === undefined || typeof update["toolCallId"] !== "string") return message;
        const key = `${String((message.params as Json)["sessionId"])} ${update["toolCallId"]}`;
        const fixed: Json = {...update};
        const meta = update["_meta"] as Json | undefined;
        if (meta !== undefined) {
            const kept: Json = {...meta};
            for (const chunkKey of OUTPUT_CHUNK_KEYS) {
                const chunk = kept[chunkKey] as {data?: string} | undefined;
                if (chunk === undefined) continue;
                chunks.set(key, (chunks.get(key) ?? "") + (chunk.data ?? ""));
                delete kept[chunkKey];
            }
            if (Object.keys(kept).length > 0) fixed["_meta"] = kept;
            else delete fixed["_meta"];
        }
        const rawOutput = update["rawOutput"] as Json | undefined;
        // The end of a command carries its exit code. A client without a chunk channel gets the output as content text.
        const content = update["content"] as Json[] | undefined;
        const text = content?.length === 1 && content[0]!["type"] === "content"
            ? (content[0]!["content"] as Json)["text"] : undefined;
        if (rawOutput !== null && typeof rawOutput === "object" && "exit_code" in rawOutput && typeof text === "string") {
            formatted.set(key, text);
            delete fixed["content"];
        }
        if (rawOutput !== undefined && rawOutput !== null && typeof rawOutput === "object" && "formatted_output" in rawOutput) {
            formatted.set(key, String(rawOutput["formatted_output"]));
            const kept: Json = {...rawOutput};
            delete kept["formatted_output"];
            if (meta !== undefined && "terminal_exit" in meta) delete kept["exit_code"];
            if (Object.keys(kept).length > 0) fixed["rawOutput"] = kept;
            else delete fixed["rawOutput"];
        }
        last.set(key, index);
        return {...message, params: {...(message.params as Json), update: fixed}};
    });
    for (const [key, index] of last) {
        const text = chunks.get(key) ?? formatted.get(key);
        if (text === undefined || text.length === 0) continue;
        const message = result[index]!;
        const update = sessionUpdate(message)!;
        result[index] = {...message, params: {...(message.params as Json), update: {...update, output: text}}};
    }
    return result;
}

/** The baseline messages with the allowed differences applied, except the merge of the tool call reports. */
export function expectedFromBaseline(scenario: string, baseline: RecordedMessage[]): RecordedMessage[] {
    return withBugFixes(scenario, withoutAirOnlyMessages(baseline));
}

/**
 * Each tool call report as the client stores it after the merge.
 *
 * A `tool_call_update` can omit a top-level field that did not change, because the client merges the update into the
 * stored tool call. Each `tool_call_update` becomes the whole stored tool call. A `tool_call_update` that changes no
 * field and has no `_meta` is removed.
 * The tool call of a permission request stays as it is, because the client shows it before it merges it.
 * Its fields still go into the stored tool call.
 * The `_meta` of each report stays as it is, because ACP defines no merge for the `_meta` keys.
 */
export function mergedReports(messages: RecordedMessage[]): RecordedMessage[] {
    const stored = new Map<string, Json>();
    const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    return messages.flatMap((message): RecordedMessage[] => {
        const params = message.params as Json;
        const update = sessionUpdate(message);
        if (update !== undefined && (update["sessionUpdate"] === "tool_call" || update["sessionUpdate"] === "tool_call_update")) {
            const {sessionUpdate: kind, toolCallId, _meta, ...fields} = update;
            const key = `${String(params["sessionId"])} ${String(toolCallId)}`;
            const previous = kind === "tool_call" ? {} : stored.get(key) ?? {};
            const next = {...previous, ...fields};
            stored.set(key, next);
            if (kind === "tool_call_update" && _meta === undefined && same(previous, next)) return [];
            const report = {sessionUpdate: kind, toolCallId, fields: next, ...(_meta === undefined ? {} : {_meta})};
            return [{...message, params: {...params, update: report}}];
        }
        if (message.method === "session/request_permission") {
            const {toolCallId, _meta, ...fields} = params["toolCall"] as Json;
            const key = `${String(params["sessionId"])} ${String(toolCallId)}`;
            stored.set(key, {...stored.get(key) ?? {}, ...fields});
            return [message];
        }
        return [message];
    });
}

/** One canonical JSON line per message, for a readable failure diff. */
export function lines(messages: RecordedMessage[]): string[] {
    return messages.map(message => JSON.stringify(canonical(message)));
}
