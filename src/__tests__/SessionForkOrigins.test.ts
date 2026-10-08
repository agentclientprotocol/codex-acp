import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Thread} from "../app-server/v2";
import {readForkOrigin, SessionForkOrigins} from "../SessionForkOrigins";

const PARENT = "01a0f400-0000-7000-8000-000000000001";
let dir: string;

function sessionMeta(forkedFrom?: string): string {
    return JSON.stringify({type: "session_meta", payload: {id: "x", base_instructions: {text: "b".repeat(100_000)},
        ...(forkedFrom === undefined ? {} : {forked_from_id: forkedFrom})}});
}

function rollout(name: string, content: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}

function thread(id: string, file: string | null, overrides: Partial<Thread> = {}): Thread {
    return {id, path: file, updatedAt: 100, forkedFromId: null, ...overrides} as Thread;
}

async function settled(origins: SessionForkOrigins): Promise<void> {
    await vi.waitFor(() => expect(origins.busy()).toBe(false));
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-fork-origin-"));
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, {recursive: true, force: true});
});

describe("readForkOrigin", () => {
    it("takes the fork parent from the session_meta line, also past the first read step", async () => {
        expect(await readForkOrigin(rollout("fork.jsonl", `${sessionMeta(PARENT)}\n{"type":"event_msg"}\n`))).toBe(PARENT);
        expect(await readForkOrigin(rollout("plain.jsonl", `${sessionMeta()}\n`))).toBe(null);
        expect(await readForkOrigin(rollout("other.jsonl", `{"type":"event_msg","payload":{"forked_from_id":"${PARENT}"}}\n`))).toBe(null);
    });

    it("answers undefined for a first line that is not complete and for a rollout not written yet", async () => {
        expect(await readForkOrigin(rollout("cut.jsonl", sessionMeta(PARENT).slice(0, 500)))).toBe(undefined);
        expect(await readForkOrigin(path.join(dir, "missing.jsonl"))).toBe(undefined);
    });
});

describe("SessionForkOrigins", () => {
    it("reads a fork in the background, reports it once and reads each thread once", async () => {
        const fork = rollout("fork.jsonl", `${sessionMeta(PARENT)}\n`);
        const plain = rollout("plain.jsonl", `${sessionMeta()}\n`);
        const onFound = vi.fn();
        const origins = new SessionForkOrigins({onFound});
        const open = vi.spyOn(fsPromises, "open");

        // Off the critical path: nothing is known and nothing is read before the call returns.
        expect(origins.originOf(thread("fork", fork))).toBe(null);
        expect(origins.originOf(thread("plain", plain))).toBe(null);
        expect(open).not.toHaveBeenCalled();
        await settled(origins);

        expect(onFound).toHaveBeenCalledExactlyOnceWith(["fork"]);
        // Cached for the thread's lifetime, a fork or not, also when the thread changes.
        expect(origins.originOf(thread("fork", fork, {updatedAt: 200}))).toBe(PARENT);
        expect(origins.originOf(thread("plain", plain, {updatedAt: 200}))).toBe(null);
        await settled(origins);
        expect(open).toHaveBeenCalledTimes(2);
        expect(onFound).toHaveBeenCalledTimes(1);
        origins.dispose();
    });

    it("reads a thread listed again during its read once, and keeps its parent when the rollout moves", async () => {
        const fork = rollout("fork.jsonl", `${sessionMeta(PARENT)}\n`);
        const onFound = vi.fn();
        const origins = new SessionForkOrigins({onFound});
        const realOpen = fsPromises.open.bind(fsPromises);
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const open = vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
            const handle = await realOpen(...args);
            await gate;
            return handle;
        }) as typeof fsPromises.open);

        origins.originOf(thread("fork", fork));
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        // Listed again while the read runs, and archived: the rollout moves.
        origins.originOf(thread("fork", fork, {updatedAt: 200}));
        const moved = path.join(dir, "moved.jsonl");
        fs.renameSync(fork, moved);
        origins.originOf(thread("fork", fork, {updatedAt: 300}));
        release();
        await settled(origins);

        expect(open).toHaveBeenCalledTimes(1);
        expect(onFound).toHaveBeenCalledExactlyOnceWith(["fork"]);
        expect(origins.originOf(thread("fork", moved, {updatedAt: 400}))).toBe(PARENT);
        origins.dispose();
    });

    it("reads a thread again that changed while a read found its first line cut", async () => {
        const file = rollout("cut.jsonl", sessionMeta(PARENT).slice(0, 500));
        const onFound = vi.fn();
        const origins = new SessionForkOrigins({onFound});
        const realOpen = fsPromises.open.bind(fsPromises);
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const open = vi.spyOn(fsPromises, "open").mockImplementationOnce((async (...args: Parameters<typeof fsPromises.open>) => {
            const handle = await realOpen(...args);
            // The first line is read cut, then Codex completes it while the read ends.
            const cut = Buffer.alloc(1000);
            const {bytesRead} = await handle.read(cut, 0, 1000, 0);
            await gate;
            return {
                read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                    if (position >= bytesRead) return {bytesRead: 0, buffer};
                    cut.copy(buffer, offset, position, Math.min(bytesRead, position + length));
                    return {bytesRead: Math.min(bytesRead - position, length), buffer};
                },
                close: () => handle.close(),
            } as unknown as fsPromises.FileHandle;
        }) as typeof fsPromises.open);

        origins.originOf(thread("fork", file));
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        fs.writeFileSync(file, `${sessionMeta(PARENT)}\n`);
        origins.originOf(thread("fork", file, {updatedAt: 101}));
        release();
        await settled(origins);

        expect(onFound).toHaveBeenCalledExactlyOnceWith(["fork"]);
        expect(origins.originOf(thread("fork", file, {updatedAt: 101}))).toBe(PARENT);
        origins.dispose();
    });

    it("reads nothing for a thread whose forkedFromId Codex gives, and that one wins", async () => {
        const fork = rollout("fork.jsonl", `${sessionMeta(PARENT)}\n`);
        const origins = new SessionForkOrigins({onFound: vi.fn()});
        const open = vi.spyOn(fsPromises, "open");

        expect(origins.originOf(thread("fork", fork, {forkedFromId: "from-codex"}))).toBe("from-codex");
        expect(origins.originOf(thread("none", null))).toBe(null);
        await settled(origins);

        expect(open).not.toHaveBeenCalled();
        origins.dispose();
    });

    it("reads a rollout whose first line was not complete again only once the thread changed", async () => {
        const file = rollout("cut.jsonl", sessionMeta(PARENT).slice(0, 500));
        const onFound = vi.fn();
        const origins = new SessionForkOrigins({onFound});
        const open = vi.spyOn(fsPromises, "open");

        origins.originOf(thread("fork", file));
        await settled(origins);
        origins.originOf(thread("fork", file));
        await settled(origins);
        expect(open).toHaveBeenCalledTimes(1);

        fs.writeFileSync(file, `${sessionMeta(PARENT)}\n`);
        origins.originOf(thread("fork", file, {updatedAt: 101}));
        await settled(origins);
        expect(open).toHaveBeenCalledTimes(2);
        expect(onFound).toHaveBeenCalledExactlyOnceWith(["fork"]);
        expect(origins.originOf(thread("fork", file, {updatedAt: 101}))).toBe(PARENT);
        origins.dispose();
    });
});
