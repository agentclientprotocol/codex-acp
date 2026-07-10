// Strip Codex summary formatting before emitting ACP text.
export function normalizeReasoningSummary(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/<!--\s*-->/g, "")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}
