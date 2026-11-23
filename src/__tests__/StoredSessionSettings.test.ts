import {appendFile, mkdtemp, open, rename, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {zstdCompressSync} from "node:zlib";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {StoredSessionSettings} from "../StoredSessionSettings";

vi.mock("node:fs/promises", async importOriginal => {
    const fs = await importOriginal<typeof import("node:fs/promises")>();
    return {...fs, open: vi.fn(fs.open)};
});

const id = "test-thread";

function checkpoint(owner: string | null, mode: string, profile: string | null, tier: string | null) {
    return {
        type: "event_msg",
        payload: {
            type: "thread_settings_applied",
            ...(owner !== null && {thread_id: owner}),
            thread_settings: {
                collaboration_mode: {mode},
                permission_profile: {type: "disabled"},
                active_permission_profile: profile === null ? null : {id: profile},
                ...(tier !== null && {service_tier: tier}),
            },
        },
    };
}

function context(mode: string, profile: string | null) {
    return {type: "turn_context", payload: {
        collaboration_mode: {mode}, active_permission_profile: profile === null ? null : {id: profile},
    }};
}

describe("stored session options", () => {
    let directory: string;
    let settings: StoredSessionSettings;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "session-options-"));
        settings = new StoredSessionSettings();
    });
    afterEach(async () => { await rm(directory, {recursive: true, force: true}); });

    async function read(records: object[], compressed = false) {
        const path = join(directory, "rollout.jsonl");
        const lines = Buffer.from(records.map(record => JSON.stringify(record)).join("\n"));
        await writeFile(compressed ? path + ".zst" : path, compressed ? zstdCompressSync(lines) : lines);
        return settings.read({id, path});
    }

    it("falls back for a missing rollout and for an unrecognized settings format", async () => {
        expect(await settings.read({id, path: join(directory, "missing.jsonl")})).toBeNull();
        expect(await read([{type: "event_msg", payload: {
            type: "thread_settings_applied", thread_id: id, thread_settings: {format: "unknown"},
        }}])).toBeNull();
    });

    it("falls back when reading and closing the rollout both fail", async () => {
        const path = join(directory, "rollout.jsonl");
        const file = await open(path, "w");
        await file.close();
        vi.spyOn(file, "close").mockRejectedValueOnce(new Error("close failed"));
        vi.mocked(open).mockResolvedValueOnce(file);
        await expect(settings.read({id, path})).resolves.toBeNull();
    });

    it("shares concurrent and repeated reads, then refreshes after an append or file replacement", async () => {
        const path = join(directory, "rollout.jsonl");
        const thread = {id, path};
        const first = JSON.stringify(context("plan", "dev"));
        const last = JSON.stringify(context("plan", "ops"));
        await writeFile(path, first);
        const [left, right] = await Promise.all([settings.read(thread), settings.read(thread)]);
        expect(left?.permissionProfileId).toBe("dev");
        expect(right).toBe(left);
        expect(await settings.read(thread)).toBe(left);

        await appendFile(path, "\n" + last);
        await utimes(path, 100, 100);
        expect((await settings.read(thread))?.permissionProfileId).toBe("ops");
        await writeFile(path + ".tmp", last + "\n" + first);
        await utimes(path + ".tmp", 100, 100);
        await rename(path + ".tmp", path);
        expect((await settings.read(thread))?.permissionProfileId).toBe("dev");
    });

    it.each([false, true])("resolves owned and legacy settings with compression %s", async compressed => {
        expect(await read([
            checkpoint("parent", "default", "parent-profile", "parent-tier"),
            checkpoint(id, "plan", "first-profile", "priority"),
            checkpoint(null, "default", null, null),
            context("default", "stale-profile"),
        ], compressed)).toEqual({collaborationMode: "plan", permissionProfileId: null, serviceTier: null});
    });

    it("recovers after a truncated compressed rollout becomes readable", async () => {
        const path = join(directory, "rollout.jsonl.zst");
        const encoded = zstdCompressSync(Buffer.from(JSON.stringify(context("plan", "dev"))));
        await writeFile(path, encoded.subarray(0, -2));
        expect(await settings.read({id, path})).toBeNull();
        await writeFile(path, encoded);
        expect(await settings.read({id, path})).toEqual({collaborationMode: "plan", permissionProfileId: "dev"});
    });

    it("retains the owned checkpoint when a fork references another thread's settings", async () => {
        expect(await read([
            checkpoint(id, "plan", "own-profile", "priority"),
            checkpoint("other", "default", "other-profile", null),
            context("default", null),
        ])).toEqual({collaborationMode: "plan", permissionProfileId: "own-profile", serviceTier: "priority"});
    });

    it("uses the last legacy turn context in the absence of an owned checkpoint", async () => {
        expect(await read([
            checkpoint(null, "default", "some-profile", "priority"),
            checkpoint("other", "default", "other-profile", null),
            context("default", "old-profile"),
            context("plan", "legacy-profile"),
        ])).toEqual({collaborationMode: "plan", permissionProfileId: "legacy-profile"});
    });
});
