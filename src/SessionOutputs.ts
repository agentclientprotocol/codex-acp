import {constants} from "node:fs";
import {open, opendir, realpath, rm, type FileHandle} from "node:fs/promises";
import {basename, isAbsolute, join, resolve, sep} from "node:path";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import {z} from "zod";

export const OUTPUTS_CAPABILITY = "com.oomol.leina/sessionOutputs";
export const OUTPUTS_LIST = "_com.oomol.leina/outputs/list";
export const OUTPUTS_READ = "_com.oomol.leina/outputs/read";
const MAX_CHUNK = 1024 * 1024;
const MAX_OUTPUT_ID_LENGTH = 1028;
const MAX_LIST = 500;

export const outputSession = z.object({sessionId: z.string().uuid()});
export const outputRead = outputSession.extend({
    outputId: z.string().regex(/^acp_[A-Za-z0-9_-]+$/).max(MAX_OUTPUT_ID_LENGTH),
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(MAX_CHUNK),
    revision: z.string().max(160).optional(),
});

export interface SessionOutput {
    id: string;
    name: string;
    ref: string;
    size: number;
    revision: string;
}

export class SessionOutputs {
    static fromEnvironment(): SessionOutputs | undefined {
        const root = process.env["CODEX_ACP_SESSION_OUTPUTS_DIR"];
        return root ? new SessionOutputs(root) : undefined;
    }

    constructor(private readonly root: string) {
        if (process.platform === "win32" || !isAbsolute(root) || resolve(root) !== root || root === sep) {
            throw new Error("CODEX_ACP_SESSION_OUTPUTS_DIR must be an absolute, normalized POSIX directory");
        }
    }

    get instructions(): string {
        return [
            "For files you deliver to the user, use the session's dedicated output directory.",
            `In shell commands use OUTPUT_DIR=${shellQuote(this.root)}"/$CODEX_THREAD_ID" and mkdir -p "$OUTPUT_DIR" before saving.`,
            "Write only finished deliverables there. Use regular Markdown links with the full path to refer to them in your reply.",
        ].join(" ");
    }

    private directory(sessionId: string): string {
        return join(this.root, outputSession.parse({sessionId}).sessionId);
    }

    async list(sessionId: string): Promise<{outputs: SessionOutput[]}> {
        const directory = this.directory(sessionId);
        const outputs: SessionOutput[] = [];
        let remaining = 4096;
        const visit = async (parent: FileHandle, relative: string, depth: number) => {
            const logical = join(directory, relative);
            const entries = await opendir(handlePath(parent, logical));
            for await (const entry of entries) {
                if (--remaining < 0 || outputs.length >= MAX_LIST) break;
                if (entry.name.startsWith(".") || !validSegment(entry.name)) continue;
                const path = relative ? relative + "/" + entry.name : entry.name;
                if (outputId(path).length > MAX_OUTPUT_ID_LENGTH) continue;
                const child = join(handlePath(parent, logical), entry.name);
                const expected = join(logical, entry.name);
                try {
                    if (entry.isDirectory() && depth < 12) {
                        const handle = await openInside(child, expected, true);
                        try { await visit(handle, path, depth + 1); }
                        finally { await handle.close(); }
                    } else if (entry.isFile()) {
                        const handle = await openInside(child, expected, false);
                        try {
                            const stat = await handle.stat({bigint: true});
                            if (stat.isFile() && stat.nlink === 1n) {
                                outputs.push({
                                    id: outputId(path), name: entry.name, ref: expected,
                                    size: Number(stat.size), revision: fileRevision(stat),
                                });
                            }
                        } finally { await handle.close(); }
                    }
                } catch (error) {
                    if (!unavailable(error)) throw error;
                }
            }
        };
        try {
            const handle = await openInside(directory, directory, true);
            try { await visit(handle, "", 0); }
            finally { await handle.close(); }
        } catch (error) {
            if (!unavailable(error)) throw error;
        }
        return {outputs: outputs.sort((a, b) => a.ref.localeCompare(b.ref))};
    }

    async read(params: z.infer<typeof outputRead>) {
        const directory = this.directory(params.sessionId);
        const relative = Buffer.from(params.outputId.slice(4), "base64url").toString("utf8");
        if (outputId(relative) !== params.outputId || !relative.split("/").every(segment => validSegment(segment) && !segment.startsWith("."))) {
            throw RequestError.invalidParams(undefined, "Invalid session output ID");
        }
        const path = join(directory, relative);
        try {
            const handle = await openInside(path, path, false);
            try {
                const stat = await handle.stat({bigint: true});
                if (!stat.isFile() || stat.nlink !== 1n) throw missing();
                const revision = fileRevision(stat);
                if (params.revision !== undefined && revision !== params.revision) throw changed();
                const size = Number(stat.size);
                if (params.offset > size) throw RequestError.invalidParams(undefined, "Offset is beyond the end of the session output");
                const buffer = Buffer.allocUnsafe(Math.min(params.length, size - params.offset));
                let done = 0;
                while (done < buffer.length) {
                    const {bytesRead} = await handle.read(buffer, done, buffer.length - done, params.offset + done);
                    if (bytesRead === 0) throw changed();
                    done += bytesRead;
                }
                if (fileRevision(await handle.stat({bigint: true})) !== revision) throw changed();
                return {name: basename(path), size, revision, dataBase64: buffer.toString("base64")};
            } finally { await handle.close(); }
        } catch (error) {
            if (unavailable(error)) throw missing();
            throw error;
        }
    }

    async remove(sessionId: string): Promise<void> {
        const directory = this.directory(sessionId);
        let root: FileHandle;
        try {
            root = await openInside(this.root, this.root, true);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        try {
            await rm(join(handlePath(root, this.root), basename(directory)), {recursive: true, force: true});
        } finally { await root.close(); }
    }
}

function outputId(relative: string): string {
    return "acp_" + Buffer.from(relative).toString("base64url");
}

function validSegment(name: string): boolean {
    return name !== "" && name !== "." && name !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(name);
}

function shellQuote(value: string): string {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function handlePath(handle: FileHandle, path: string): string {
    return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
}

async function openInside(path: string, expected: string, directory: boolean): Promise<FileHandle> {
    if (await realpath(path) !== expected) throw missing();
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(path, flags | (directory ? constants.O_DIRECTORY : 0));
    try {
        // Linux resolves the opened fd, including any ancestor replaced during open.
        if (await realpath(handlePath(handle, path)) !== expected) throw missing();
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

function unavailable(error: unknown): boolean {
    return error instanceof RequestError && error.code === -32002
        || ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function missing(): RequestError {
    return new RequestError(-32002, "Session output not found");
}

function changed(): RequestError {
    return new RequestError(-32010, "Session output changed during download");
}

function fileRevision(stat: {dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
