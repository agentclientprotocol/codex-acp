/**
 * Codex models may cite files with `:codex-file-citation{path="..." purpose="..."}`. The Codex TUI
 * renders it as a file link; ACP clients only get Markdown, so the directive becomes a Markdown link.
 *
 * The directive parser is a direct reimplementation of Codex's own Rust parser
 * (`codex-rs/tui/src/assistant_directives.rs`), so it accepts the same directive syntax that Codex renders.
 */
import path from "node:path";

const CITATION_NAME = "codex-file-citation";
// A longer directive is not treated as a citation, which bounds both the scan and the held-back text.
const MAX_CITATION_LENGTH = 4096;
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

type Citation = { path: string; end: number };

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
     * Citations inside code spans and fences, or escaped with `\`, stay as written.
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

            // A citation starts at the first `:` of a run, outside code; `\:` escapes it.
            const before = index > 0 ? text[index - 1] : this.previous;
            const citation = char === ":" && this.codeRun === 0 && before !== ":" && before !== "\\"
                ? parseCitation(text, index)
                : null;

            // Wait for the rest of an unfinished citation.
            if (citation === "partial") break;

            if (citation !== null) {
                output += markdownFileLink(citation.path, this.cwd);
                index = citation.end;
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
    if (!text.includes(CITATION_NAME)) return text;
    const stream = new FileCitationStream(cwd);
    return stream.push(text) + stream.flush();
}

/**
 * Parses a citation that starts at `start`: its path and the index after it, `"partial"` if the text ends
 * before the directive does, or `null` if it is not a citation.
 * Paths keep backslashes literally, so Windows paths work; `\"` is read as a quote only if that is the
 * only way to parse the directive.
 *
 * This reimplements `parse_assistant_directive_with_budget` from Codex's `codex-rs/tui/src/assistant_directives.rs`,
 * including the literal-then-backslash quoting that Codex uses for citations. It differs only where this adapter
 * needs it: it parses citations alone (no other directives or `[label]`s), reports `"partial"` for streaming,
 * and limits a directive's length instead of sharing a scan budget across attempts.
 */
function parseCitation(text: string, start: number): Citation | "partial" | null {
    return parseCitationWith(text, start, false) ?? parseCitationWith(text, start, true);
}

/**
 * The directive is one to three colons, the name, and `key=value` attributes in braces.
 * A value is quoted with `"` or `'`, or unquoted up to whitespace or `}`.
 */
function parseCitationWith(text: string, start: number, backslashEscapesQuote: boolean): Citation | "partial" | null {
    const limit = Math.min(text.length, start + MAX_CITATION_LENGTH);
    // Reaching the end of the text, not the length limit, means the directive may continue in the next delta.
    const ended = () => limit === text.length ? "partial" : null;
    let index = start;

    while (index < limit && text[index] === ":") index++;
    if (index === limit) return ended();
    if (index - start > 3) return null;

    for (const expected of `${CITATION_NAME}{`) {
        if (index === limit) return ended();
        if (text[index] !== expected) return null;
        index++;
    }

    const keys = new Set<string>();
    let citedPath = "";
    while (true) {
        index = skipSpaces(text, index, limit);
        if (index === limit) return ended();
        if (text[index] === "}") break;

        // The key, then `=` with optional spaces around it.
        const keyStart = index;
        while (index < limit && isNameChar(text[index]!)) index++;
        if (index === limit) return ended();
        const key = text.slice(keyStart, index);
        if (key === "" || keys.has(key)) return null;
        keys.add(key);

        index = skipSpaces(text, index, limit);
        if (index === limit) return ended();
        if (text[index] !== "=") return null;
        index = skipSpaces(text, index + 1, limit);
        if (index === limit) return ended();

        let value = "";
        const quote = text[index];
        if (quote === "\"" || quote === "'") {
            // A quoted value ends at the matching quote and may contain spaces and braces, but no line break.
            index++;
            while (true) {
                if (index === limit) return ended();
                const char = text[index]!;
                if (char === quote) break;
                if (char === "\n" || char === "\r") return null;
                if (backslashEscapesQuote && char === "\\" && text[index + 1] === quote) index++;
                value += text[index];
                index++;
            }
            index++;
        } else {
            const valueStart = index;
            while (index < limit && !" \t}\n\r".includes(text[index]!)) index++;
            if (index === limit) return ended();
            if (index === valueStart) return null;
            value = text.slice(valueStart, index);
        }
        if (key === "path") citedPath = value;
    }

    // Only a citation with a path can become a link.
    return citedPath === "" ? null : {path: citedPath, end: index + 1};
}

function skipSpaces(text: string, index: number, limit: number): number {
    while (index < limit && (text[index] === " " || text[index] === "\t")) index++;
    return index;
}

function isNameChar(char: string): boolean {
    return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9")
        || char === "_" || char === "-";
}

function markdownFileLink(citedPath: string, cwd: string): string {
    // Absolute paths, Windows drive paths, and URLs such as `file://` are kept as cited.
    const destination = path.isAbsolute(citedPath) || /^(?:[A-Za-z]:[\\/]|[A-Za-z][\w+.-]*:\/\/)/.test(citedPath)
        ? citedPath
        : path.join(cwd, citedPath);
    const label = escapeMarkdown(citedPath, "[]");
    const target = [...destination].some(char => " \t\n\r()<>".includes(char))
        ? `<${escapeMarkdown(destination, "<>")}>`
        : escapeMarkdown(destination, "");
    return `[${label}](${target})`;
}

/** Escapes the `special` characters, and a backslash that CommonMark would read as an escape. */
function escapeMarkdown(text: string, special: string): string {
    let escaped = "";
    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        const next = text[index + 1];
        if (special.includes(char) || (char === "\\" && next !== undefined && ASCII_PUNCTUATION.includes(next))) {
            escaped += "\\";
        }
        escaped += char;
    }
    return escaped;
}
