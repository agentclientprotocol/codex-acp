/**
 * The renames that any Codex process writes, read from `<CODEX_HOME>/session_index.jsonl`.
 *
 * `thread/name/set` appends `{"id", "thread_name", "updated_at"}` to that file and does not move the
 * `updated_at` of the thread in the state DB, so a scan of the threads by `updated_at` cannot see a rename of
 * another process. The log is read from where the last read stopped: only appended lines count.
 */

import fs from "node:fs";
import path from "node:path";
import {logger} from "./Logger";

export const SESSION_NAME_LOG_FILE = "session_index.jsonl";

/** The most that one read takes in. A longer append is skipped: the client re-reads the list anyway. */
const MAX_READ_BYTES = 1024 * 1024;

export class SessionNameLog {
    private readonly file: string;
    /** Where the next read starts: the end of the last complete line read. */
    private offset: number;

    /** Starts at the current end of the log: renames written before do not count. */
    constructor(home: string) {
        this.file = path.join(home, SESSION_NAME_LOG_FILE);
        this.offset = fileSize(this.file);
    }

    /** The ids of the threads renamed since the last read, in log order, without repeats. */
    readRenamedThreads(): string[] {
        const size = fileSize(this.file);
        if (size < this.offset) {
            // Rewritten from scratch: what it holds now is not new.
            this.offset = size;
            return [];
        }
        if (size === this.offset) return [];
        if (size - this.offset > MAX_READ_BYTES) {
            logger.log("Skipping a long append to the session name log", {bytes: size - this.offset});
            this.offset = size;
            return [];
        }
        let text: string;
        try {
            const length = size - this.offset;
            const buffer = Buffer.alloc(length);
            const fd = fs.openSync(this.file, "r");
            try {
                fs.readSync(fd, buffer, 0, length, this.offset);
            } finally {
                fs.closeSync(fd);
            }
            text = buffer.toString("utf8");
        } catch {
            return [];
        }
        // A line that Codex is still writing is read again next time.
        const end = text.lastIndexOf("\n");
        if (end < 0) return [];
        this.offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
        const ids = new Set<string>();
        for (const line of text.slice(0, end).split("\n")) {
            try {
                const id = (JSON.parse(line) as {id?: unknown}).id;
                if (typeof id === "string") ids.add(id);
            } catch {
                // Not a line of Codex: skipped.
            }
        }
        return [...ids];
    }
}

function fileSize(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}
