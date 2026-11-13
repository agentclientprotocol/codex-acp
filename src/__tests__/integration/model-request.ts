type TextBlock = {type: string; text?: string};
type Message = {type: "message"; role: string; content: TextBlock[]};

function messages(request: unknown, role: string): Message[] {
    if (request === null || typeof request !== "object" || !("input" in request) || !Array.isArray(request.input)) {
        return [];
    }
    return request.input.filter((item): item is Message =>
        item !== null && typeof item === "object" && item.type === "message"
        && item.role === role && Array.isArray(item.content));
}

function text(message: Message): string[] {
    return message.content.flatMap(block =>
        block.type === "input_text" && typeof block.text === "string" ? [block.text] : []);
}

/** Match the user message, not a concurrent title request that quotes it. */
export function findPromptRequest(requests: unknown[], prompt: string): unknown {
    return requests.find(request => messages(request, "user").some(message => text(message).includes(prompt)));
}

/** Additional-tools items can also have role "developer", but are not messages. */
export function developerText(request: unknown): string {
    return messages(request, "developer").flatMap(text).join("\n");
}
