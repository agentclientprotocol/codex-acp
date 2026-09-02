import type {Thread, UserInput} from "../app-server/v2";
import type {PaginatedThread, PaginatedThreadItem, PaginatedTurn, ThreadItemEntry} from "./app-server-api";
import {THREAD_TOOLS_MCP_NAME} from "./catalog";
import {truncate} from "./output";

const LEGACY_NAMESPACE = "codex_tui";
const DEFAULT_OUTPUT_CHARS = 2_000;

export function threadSummary(thread: PaginatedThread): unknown {
    return {
        id: thread.id,
        kind: "codex",
        projectId: thread.projectId ?? null,
        title: thread.name === null ? null : truncate(thread.name, DEFAULT_OUTPUT_CHARS),
        summary: truncate(thread.preview, 300),
        status: thread.status.type,
        cwd: thread.cwd,
        updatedAt: thread.updatedAt,
    };
}

export function turnSummary(turn: PaginatedTurn, includeOutputs: boolean, outputChars: number): unknown {
    return {
        id: turn.id,
        status: turn.status,
        error: turn.error === null ? null : {message: turn.error.message, additionalDetails: turn.error.additionalDetails},
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs,
        items: turn.items.slice(-20).map(item => summarizeItem(item, includeOutputs, outputChars)),
    };
}

function summarizeItem(item: PaginatedThreadItem, includeOutputs: boolean, outputChars: number): unknown {
    switch (item.type) {
        case "userMessage": return {type: item.type, id: item.id, content: item.content.map(summarizeUserInput)};
        case "hookPrompt": return {type: item.type, id: item.id, fragmentCount: item.fragments.length};
        case "functionCallOutput": {
            const summary: Record<string, unknown> = {type: item.type, id: item.id, name: item.name, namespace: item.namespace};
            const text = outputText(item.output);
            const delegation = parseDelegatedOutput(item.name, item.namespace, text);
            if (delegation !== null) summary["codexDelegation"] = delegation;
            if (includeOutputs) summary["output"] = outputSummary(text ?? "[non-text output]", outputChars);
            return summary;
        }
        case "agentMessage": return {type: item.type, id: item.id, text: truncate(item.text, DEFAULT_OUTPUT_CHARS), phase: item.phase};
        case "plan": return {type: item.type, id: item.id, text: truncate(item.text, DEFAULT_OUTPUT_CHARS)};
        case "reasoning": return {
            type: item.type,
            id: item.id,
            summary: item.summary.map(text => truncate(text, DEFAULT_OUTPUT_CHARS)),
            ...(includeOutputs && {content: item.content.map(text => outputSummary(text, outputChars))}),
        };
        case "commandExecution": return {
            type: item.type,
            id: item.id,
            command: truncate(item.command, DEFAULT_OUTPUT_CHARS),
            cwd: item.cwd,
            exitCode: item.exitCode,
            status: item.status,
            durationMs: item.durationMs,
            ...(includeOutputs && item.aggregatedOutput !== null && {output: outputSummary(item.aggregatedOutput, outputChars)}),
        };
        case "fileChange": return {
            type: item.type,
            id: item.id,
            status: item.status,
            changes: item.changes.map(change => ({
                path: change.path,
                kind: change.kind,
                ...(includeOutputs && {diff: outputSummary(change.diff, outputChars)}),
            })),
        };
        case "mcpToolCall": return {type: item.type, id: item.id, server: item.server, tool: item.tool, arguments: item.arguments, status: item.status, durationMs: item.durationMs};
        case "dynamicToolCall": return {type: item.type, id: item.id, namespace: item.namespace, tool: item.tool, arguments: item.arguments, status: item.status, success: item.success, durationMs: item.durationMs};
        case "collabAgentToolCall": return {type: item.type, id: item.id, tool: item.tool, status: item.status, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds, prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort};
        case "subAgentActivity": return {type: item.type, id: item.id, kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath};
        case "webSearch": return {type: item.type, id: item.id, query: truncate(item.query, DEFAULT_OUTPUT_CHARS), action: item.action};
        case "imageView": return {type: item.type, id: item.id, path: item.path};
        case "sleep": return {type: item.type, id: item.id, durationMs: item.durationMs};
        case "imageGeneration": return {
            type: item.type,
            id: item.id,
            status: item.status,
            revisedPrompt: item.revisedPrompt === null ? null : truncate(item.revisedPrompt, DEFAULT_OUTPUT_CHARS),
            savedPath: item.savedPath,
            ...(includeOutputs && {result: outputSummary(item.result, outputChars)}),
        };
        case "enteredReviewMode":
        case "exitedReviewMode": return {type: item.type, id: item.id, review: truncate(item.review, DEFAULT_OUTPUT_CHARS)};
        case "contextCompaction": return {type: item.type, id: item.id};
    }
}

function summarizeUserInput(input: UserInput): unknown {
    switch (input.type) {
        case "text": {
            const summary: Record<string, unknown> = {type: input.type, text: truncate(input.text, DEFAULT_OUTPUT_CHARS)};
            const delegation = parseDelegatedPrompt(input.text);
            if (delegation !== null) summary["codexDelegation"] = delegation;
            return summary;
        }
        case "image": return {type: input.type, url: input.url};
        case "localImage": return {type: input.type, path: input.path};
        case "audio": return {type: input.type, url: input.url};
        case "localAudio": return {type: input.type, path: input.path};
        case "skill":
        case "mention": return {type: input.type, name: input.name, path: input.path};
    }
}

export function latestTurnSummary(turn: PaginatedTurn): unknown {
    return {id: turn.id, status: turn.status, error: turn.error === null ? null : {message: turn.error.message}, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs};
}

export function latestAgentMessage(turn: PaginatedTurn | null): {id: string, turnId: string, phase: unknown, text: string} | null {
    if (turn === null) return null;
    const message = [...turn.items].reverse().find(item => item.type === "agentMessage");
    return message === undefined ? null : {id: message.id, turnId: turn.id, phase: message.phase, text: truncate(message.text, DEFAULT_OUTPUT_CHARS)};
}

export function latestToolMarker(turn: PaginatedTurn | null, entries: ThreadItemEntry[]): Record<string, unknown> | null {
    if (turn === null) return null;
    for (const {item} of entries) {
        switch (item.type) {
            case "commandExecution":
            case "fileChange":
            case "imageGeneration": return {id: item.id, turnId: turn.id, type: item.type, name: item.type, status: item.status};
            case "mcpToolCall":
            case "dynamicToolCall":
            case "collabAgentToolCall": return {id: item.id, turnId: turn.id, type: item.type, name: item.tool, status: item.status};
            case "sleep":
            case "webSearch": return {id: item.id, turnId: turn.id, type: item.type, name: item.type, status: null};
            default: continue;
        }
    }
    return null;
}

export function wakeReason(thread: Thread, turn: PaginatedTurn | null, changed: boolean): unknown {
    switch (thread.status.type) {
        case "idle":
            if (turn !== null && changed && turn.status !== "inProgress") return {threadId: thread.id, reason: "turnCompleted", turnId: turn.id};
            return turn === null ? {threadId: thread.id, reason: "inactiveStatus"} : null;
        case "notLoaded":
        case "systemError": return {threadId: thread.id, reason: "inactiveStatus"};
        case "active": return thread.status.activeFlags.length === 0 ? null : {threadId: thread.id, reason: "actionableStatus"};
    }
}

function parseDelegatedOutput(name: string, namespace: string | null, output: string | null): unknown {
    if ((namespace !== THREAD_TOOLS_MCP_NAME && namespace !== LEGACY_NAMESPACE && namespace !== "codex_app")
        || (name !== "create_thread" && name !== "send_message_to_thread")
        || output === null) return null;
    return parseDelegatedPrompt(output);
}

function parseDelegatedPrompt(value: string): {sourceThreadId: string, input: string} | null {
    const prefix = "<codex_delegation>\n  <source_thread_id>";
    const separator = "</source_thread_id>\n  <input>";
    const suffix = "</input>\n</codex_delegation>";
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
    const body = value.slice(prefix.length, -suffix.length);
    const index = body.indexOf(separator);
    if (index < 0) return null;
    return {sourceThreadId: unxml(body.slice(0, index)), input: truncate(unxml(body.slice(index + separator.length)), DEFAULT_OUTPUT_CHARS)};
}

function unxml(value: string): string {
    return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function outputText(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return null;
    const parts = value.flatMap(item => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
        const content = item as Record<string, unknown>;
        return content["type"] === "input_text" && typeof content["text"] === "string" && content["text"].trim().length > 0
            ? [content["text"]]
            : [];
    });
    return parts.length === 0 ? null : parts.join("\n");
}

function outputSummary(text: string, limit: number): unknown {
    const characters = Array.from(text);
    return characters.length <= limit ? {text, truncated: false} : {text: characters.slice(0, limit).join(""), truncated: true, originalChars: characters.length};
}
