import type {ContentBlock} from "@agentclientprotocol/sdk";

const CODEX_THREAD_ID = /^[A-Za-z0-9._:-]{1,256}$/;

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
        const sessionId = parsed.searchParams.get("sessionId")?.trim();
        return sessionId !== undefined && CODEX_THREAD_ID.test(sessionId) ? sessionId : null;
    } catch {
        return null;
    }
}
