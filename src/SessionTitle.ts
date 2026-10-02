/**
 * The maximum length of a session title that the adapter publishes, the ellipsis included.
 * AIR ignores a longer agent title.
 */
export const MAX_SESSION_TITLE_LENGTH = 160;

/**
 * Collapses the whitespace of [title] and cuts it to [MAX_SESSION_TITLE_LENGTH] characters with a trailing ellipsis.
 * Returns `null` for a blank title.
 */
export function normalizeSessionTitle(title: string | null | undefined): string | null {
    const normalized = title?.replace(/\s+/g, " ").trim() ?? "";
    if (normalized.length === 0) return null;
    if (normalized.length <= MAX_SESSION_TITLE_LENGTH) return normalized;
    let cut = normalized.slice(0, MAX_SESSION_TITLE_LENGTH - 1);
    // Do not leave half of a surrogate pair before the ellipsis.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
}
