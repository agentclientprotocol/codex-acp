import type {DynamicToolCallResponse, DynamicToolSpec} from "./app-server/v2";
import {normalizeSessionTitle} from "./SessionTitle";

export const SESSION_TITLE_TOOL: DynamicToolSpec = {
    type: "function",
    name: "set_thread_title",
    description: "Set the current conversation's title when the user requests a rename.",
    inputSchema: {
        type: "object",
        properties: {title: {type: "string"}},
        required: ["title"],
        additionalProperties: false,
    },
    deferLoading: false,
};

export function sessionTitleArgument(value: unknown): string | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "title") return null;
    const title = (value as {title: unknown}).title;
    return typeof title === "string" ? normalizeSessionTitle(title) : null;
}

export function sessionTitleToolResult(success: boolean, text: string): DynamicToolCallResponse {
    return {success, contentItems: [{type: "inputText", text}]};
}
