import type {ContentBlock} from "@agentclientprotocol/sdk";

export function toCodexSessionLinks(prompt: ContentBlock[]): ContentBlock[] {
    return prompt.map((block): ContentBlock => {
        if (block.type !== "resource_link") return block;
        const sessionId = acpSessionId(block.uri);
        return sessionId === null ? block : {type: "text", text: `codex://threads/${sessionId}`};
    });
}

function acpSessionId(uri: string): string | null {
    try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "acp-session:" || parsed.hostname !== "reference") return null;
        return parsed.searchParams.get("sessionId")?.trim() || null;
    } catch {
        return null;
    }
}
