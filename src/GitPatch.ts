/**
 * Builds the unified Git patches of the AIR diff patch extension.
 *
 * Each builder returns `null` when it cannot build a patch with at least one valid hunk.
 * The caller then sends the standard ACP diff.
 */

/** The largest diff or patch text that the adapter sends. The adapter sends no diff for a larger Codex diff. */
export const DIFF_PATCH_MAX_BYTES = 1024 * 1024;

/** Git reads a file as binary when its first 8000 bytes contain a NUL byte. */
const BINARY_PROBE_LENGTH = 8000;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const REGULAR_FILE_MODE = "100644";

/**
 * Adds Git file headers to the hunks that Codex supplied for an update.
 *
 * The builder drops the file headers that Codex supplied, so that all headers name the same paths.
 * It keeps the hunk bytes, including a carriage return.
 */
export function createUpdateGitPatch(oldPath: string, newPath: string, diff: string): string | null {
    if (overLimit(diff)) return null;
    const hunks = hunkText(diff);
    if (hunks === null || isBinary(hunks)) return null;
    const oldName = gitPath(oldPath);
    const newName = gitPath(newPath);
    const headers = [`diff --git ${quotedGitName("a/", oldName)} ${quotedGitName("b/", newName)}`];
    if (oldName !== newName) {
        headers.push(`rename from ${quotedGitName("", oldName)}`, `rename to ${quotedGitName("", newName)}`);
    }
    headers.push(fileHeader("---", "a/", oldName), fileHeader("+++", "b/", newName));
    return limited(`${headers.join("\n")}\n${hunks}`);
}

/** Builds a whole-file patch for an added file. */
export function createAddedFileGitPatch(filePath: string, text: string): string | null {
    return createWholeFilePatch(filePath, text, "added");
}

/** Builds a whole-file patch for a deleted file. */
export function createDeletedFileGitPatch(filePath: string, text: string): string | null {
    return createWholeFilePatch(filePath, text, "deleted");
}

function createWholeFilePatch(filePath: string, text: string, change: "added" | "deleted"): string | null {
    // A hunk cannot express an empty file, and a binary file has no text lines.
    if (text.length === 0 || overLimit(text) || isBinary(text)) return null;
    const name = gitPath(filePath);
    const lines = text.split("\n");
    const endsWithNewline = lines.at(-1) === "";
    if (endsWithNewline) lines.pop();
    const sign = change === "added" ? "+" : "-";
    const range = `1${lines.length === 1 ? "" : `,${lines.length}`}`;
    const patch = [
        `diff --git ${quotedGitName("a/", name)} ${quotedGitName("b/", name)}`,
        `${change === "added" ? "new" : "deleted"} file mode ${REGULAR_FILE_MODE}`,
        change === "added" ? "--- /dev/null" : fileHeader("---", "a/", name),
        change === "added" ? fileHeader("+++", "b/", name) : "+++ /dev/null",
        change === "added" ? `@@ -0,0 +${range} @@` : `@@ -${range} +0,0 @@`,
        ...lines.map(line => `${sign}${line}`),
        ...(endsWithNewline ? [] : [NO_NEWLINE_MARKER]),
        "",
    ].join("\n");
    return limited(patch);
}

/**
 * Returns the hunks of a Codex diff, or `null` when a hunk is malformed.
 * Codex can put file headers before the first hunk. They are dropped.
 *
 * The hunks must follow each other in the old file without an overlap.
 * The new start of each hunk must equal its old start plus the line count change of the hunks before it.
 */
function hunkText(diff: string): string | null {
    const lines = diff.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const first = lines.findIndex(line => line.startsWith("@@"));
    if (first < 0) return null;
    const leading = lines.slice(0, first);
    if (!leading.every(isFileHeaderLine)) return null;
    const hunks = lines.slice(first);

    let index = 0;
    /** The first old line after the previous hunk. */
    let oldEnd = 1;
    /** The line count change of the previous hunks. */
    let offset = 0;
    while (index < hunks.length) {
        const header = HUNK_HEADER.exec(hunks[index]!);
        if (header === null) return null;
        const old = hunkRange(header[1]!, header[2]);
        const current = hunkRange(header[3]!, header[4]);
        if (old === null || current === null || old.first < oldEnd || current.first - old.first !== offset) return null;
        oldEnd = old.first + old.count;
        offset += current.count - old.count;
        let oldLines = old.count;
        let newLines = current.count;
        index++;
        while (oldLines > 0 || newLines > 0) {
            const line = hunks[index];
            if (line === undefined) return null;
            switch (line[0]) {
                case " ":
                case undefined:
                    oldLines--;
                    newLines--;
                    break;
                case "-":
                    oldLines--;
                    break;
                case "+":
                    newLines--;
                    break;
                case "\\":
                    if (line !== NO_NEWLINE_MARKER) return null;
                    break;
                default:
                    return null;
            }
            index++;
        }
        if (oldLines !== 0 || newLines !== 0) return null;
        while (hunks[index] === NO_NEWLINE_MARKER) index++;
    }
    return `${hunks.join("\n")}\n`;
}

/**
 * Reads the start and the line count of one side of a hunk header.
 * An empty range starts after the line that the header names, so its first line is one more.
 * Returns `null` for a number that is not a safe integer, or for start 0 with lines.
 */
function hunkRange(start: string, count: string | undefined): {first: number; count: number} | null {
    const startLine = Number(start);
    const lineCount = count === undefined ? 1 : Number(count);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(lineCount)) return null;
    if (lineCount === 0) return {first: startLine + 1, count: 0};
    return startLine === 0 ? null : {first: startLine, count: lineCount};
}

function isFileHeaderLine(line: string): boolean {
    return line.length === 0
        || line.startsWith("diff --git ")
        || line.startsWith("index ")
        || line.startsWith("--- ")
        || line.startsWith("+++ ");
}

function isBinary(text: string): boolean {
    return text.slice(0, BINARY_PROBE_LENGTH).includes("\0");
}

function limited(patch: string): string | null {
    return Buffer.byteLength(patch, "utf8") <= DIFF_PATCH_MAX_BYTES ? patch : null;
}

/**
 * Converts a file path to a Git path without the leading slash.
 * For example, `/workspace/src/App.ts` becomes `workspace/src/App.ts`.
 * A Windows path such as `C:\work\App.ts` becomes `C:/work/App.ts`.
 */
function gitPath(filePath: string): string {
    const slashed = /^[A-Za-z]:\\/.test(filePath) ? filePath.replace(/\\/g, "/") : filePath;
    return slashed.replace(/^\/+/, "");
}

/** A `---` or `+++` line ends with a tab when an unquoted name contains a space, as Git does. */
function fileHeader(marker: "---" | "+++", prefix: string, name: string): string {
    const quoted = quotedGitName(prefix, name);
    return `${marker} ${quoted}${!quoted.startsWith("\"") && quoted.includes(" ") ? "\t" : ""}`;
}

/**
 * Quotes a name as Git does when the name contains a double quote, a backslash or a control character.
 * The adapter keeps non-ASCII characters, like Git with `core.quotePath=false`.
 */
function quotedGitName(prefix: string, name: string): string {
    const full = `${prefix}${name}`;
    if (!/["\\\x00-\x1f\x7f]/.test(full)) return full;
    let quoted = "";
    for (const char of full) {
        switch (char) {
            case "\"": quoted += "\\\""; break;
            case "\\": quoted += "\\\\"; break;
            case "\x07": quoted += "\\a"; break;
            case "\b": quoted += "\\b"; break;
            case "\t": quoted += "\\t"; break;
            case "\n": quoted += "\\n"; break;
            case "\v": quoted += "\\v"; break;
            case "\f": quoted += "\\f"; break;
            case "\r": quoted += "\\r"; break;
            default: {
                const code = char.codePointAt(0)!;
                quoted += code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, "0")}` : char;
            }
        }
    }
    return `"${quoted}"`;
}

/**
 * Whether a source text alone is larger than the patch limit. A patch is never smaller than its source text, so the
 * builder can stop before it copies the text. The UTF-16 length is a lower bound of the UTF-8 size.
 */
function overLimit(text: string): boolean {
    return text.length > DIFF_PATCH_MAX_BYTES;
}
