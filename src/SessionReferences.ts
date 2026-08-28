import type {ContentBlock} from "@agentclientprotocol/sdk";

export function toCodexSessionLinks(prompt: ContentBlock[]): ContentBlock[] {
    return prompt.map((block): ContentBlock => {
        if (block.type !== "resource_link") return block;
        const sessionId = acpSessionId(block.uri);
        if (sessionId === null) return block;
        return {
            type: "text",
            text: [
                "Referenced Codex task. Call `read_thread` before relying on its contents.",
                JSON.stringify({threadId: sessionId}),
                `codex://threads/${sessionId}`,
            ].join("\n"),
        };
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
