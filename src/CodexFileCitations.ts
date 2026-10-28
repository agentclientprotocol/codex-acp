/**
 * Codex models may cite files with `:codex-file-citation{path="..." purpose="..."}`. The Codex TUI
 * renders it as a file link; ACP clients only get Markdown, so the directive becomes a Markdown link.
 */
import path from "node:path";

const PREFIX = ":codex-file-citation{";
const DIRECTIVE = /^:codex-file-citation\{(?:\s*[A-Za-z][\w-]*=(?:"[^"\n]*"|[^\s"}]+))*\s*\}/;
const ATTRIBUTE = /([A-Za-z][\w-]*)=(?:"([^"\n]*)"|([^\s"}]+))/g;
// An unfinished directive longer than this is passed through as plain text.
const MAX_PENDING_LENGTH = 4096;

/** Rewrites file citations in streamed agent message text, holding back a directive split across deltas. */
export class FileCitationStream {
    private pending = "";
    private previous = "";
    // Length of the backtick run that opened the current code span or fence; 0 outside code.
    private codeRun = 0;

    constructor(private readonly cwd: string) {}

    /**
     * Returns the text of `delta` that is safe to send now, with complete citations replaced by links.
     * Text that may still become a citation, or a backtick run that may continue, waits for the next delta.
     * Citations inside code spans and fences, escaped with `\`, or preceded by another `:` stay as written.
     */
    push(delta: string): string {
        const text = this.pending + delta;
        let output = "";
        let index = 0;

        while (index < text.length) {
            const char = text[index]!;

            // A backtick run opens or closes a code span or fence; citations in code stay as written.
            if (char === "`") {
                let end = index;
                while (text[end] === "`") end++;
                // The run may continue in the next delta.
                if (end === text.length) break;

                const run = end - index;
                if (this.codeRun === 0) this.codeRun = run;
                else if (this.codeRun === run) this.codeRun = 0;

                output += text.slice(index, end);
                index = end;
                continue;
            }

            // A citation starts with `:` outside code; `\:` escapes it, and `::` is another directive.
            const before = index > 0 ? text[index - 1] : this.previous;
            const match = char === ":" && this.codeRun === 0 && before !== ":" && before !== "\\"
                ? matchCitation(text.slice(index))
                : null;

            // Wait for the rest of an unfinished citation, unless it is too long to be one.
            if (match === "partial" && text.length - index <= MAX_PENDING_LENGTH) break;

            if (match !== null && match !== "partial") {
                output += markdownFileLink(match.path, this.cwd);
                index += match.length;
                continue;
            }

            output += char;
            index++;
        }

        // Keep the unsent rest for the next delta, and the last sent character for the escape check.
        if (index > 0) this.previous = text[index - 1]!;
        this.pending = text.slice(index);
        return output;
    }

    /** Returns the held-back text as is, once the message is complete. */
    flush(): string {
        const rest = this.pending;
        this.pending = "";
        return rest;
    }
}

/** Rewrites file citations in a complete agent message. */
export function renderFileCitations(text: string, cwd: string): string {
    if (!text.includes(PREFIX)) return text;
    const stream = new FileCitationStream(cwd);
    return stream.push(text) + stream.flush();
}

/**
 * Matches a citation at the start of `source`: its path and length, `"partial"` if the text so far
 * could still become one, or `null` if it is not a citation.
 */
function matchCitation(source: string): { path: string; length: number } | "partial" | null {
    if (source.length < PREFIX.length) {
        return PREFIX.startsWith(source) ? "partial" : null;
    }
    if (!source.startsWith(PREFIX)) return null;
    const directive = DIRECTIVE.exec(source)?.[0];
    if (directive === undefined) {
        const body = source.slice(PREFIX.length);
        return body.includes("}") || body.includes("\n") ? null : "partial";
    }
    for (const [, name, quoted, unquoted] of directive.matchAll(ATTRIBUTE)) {
        const value = quoted ?? unquoted ?? "";
        if (name === "path" && value.length > 0) return {path: value, length: directive.length};
    }
    return null;
}

function markdownFileLink(citedPath: string, cwd: string): string {
    // Absolute paths, Windows drive paths, and URLs such as `file://` are kept as cited.
    const destination = path.isAbsolute(citedPath) || /^(?:[A-Za-z]:[\\/]|[A-Za-z][\w+.-]*:\/\/)/.test(citedPath)
        ? citedPath
        : path.join(cwd, citedPath);
    const label = citedPath.replace(/[\\[\]]/g, "\\$&");
    const target = /[\s()<>]/.test(destination)
        ? `<${destination.replace(/[<>]/g, "\\$&")}>`
        : destination;
    return `[${label}](${target})`;
}
