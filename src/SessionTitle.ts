import type {Thread} from "./app-server/v2";

/** The maximum length of a session title that the adapter publishes, the ellipsis included. */
export const MAX_SESSION_TITLE_LENGTH = 256;

/**
 * Collapses the whitespace of [title] and cuts it to [MAX_SESSION_TITLE_LENGTH] characters with a trailing ellipsis.
 * Returns `null` for a blank title.
 */
export function normalizeSessionTitle(title: string | null | undefined): string | null {
    const normalized = collapseSessionTitle(title);
    if (normalized === null || normalized.length <= MAX_SESSION_TITLE_LENGTH) return normalized;
    let cut = normalized.slice(0, MAX_SESSION_TITLE_LENGTH - 1);
    // Do not leave half of a surrogate pair before the ellipsis.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
}

/**
 * The title fields of a listed thread. The generated `Thread` has only `name` and `preview`; `title` and `summary`
 * are read when Codex sends them, as AIR's native Codex list reads them.
 */
export type ListedThreadTitleFields = Pick<Thread, "name" | "preview"> & {
    title?: string | null;
    summary?: string | null;
};

/**
 * The title of a thread's `session/list` row and of its `_session/list/changes` row: the first non-blank of
 * `name`, `title`, `summary` and `preview`, collapsed to one line, as AIR's native Codex list resolves it. It is not
 * cut, as the native list does not cut it either. `null` when all are blank: the ACP title is optional, and a client
 * shows its own fallback, AIR the session id.
 */
export function listedSessionTitle(thread: ListedThreadTitleFields): string | null {
    return collapseSessionTitle(thread.name)
        ?? collapseSessionTitle(thread.title)
        ?? collapseSessionTitle(thread.summary)
        ?? collapseSessionTitle(thread.preview);
}

/** Collapses the whitespace of [title] to single spaces and trims it; `null` for a blank title. */
function collapseSessionTitle(title: string | null | undefined): string | null {
    const collapsed = title?.replace(/\s+/g, " ").trim() ?? "";
    return collapsed.length === 0 ? null : collapsed;
}
