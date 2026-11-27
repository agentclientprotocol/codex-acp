import {open, type FileHandle} from "node:fs/promises";
import {pipeline} from "node:stream/promises";
import * as zlib from "node:zlib";
import {parseCollaborationMode} from "./CollaborationModeConfig";
import type {ModeKind} from "./app-server/ModeKind";
import type {Thread} from "./app-server/v2";
import {recordOrNull} from "./permissions/json";
import {LineSplitter} from "./StdUtils";

type StoredSettings = {
    collaborationMode: ModeKind | null;
    /** Null means an owned, unnamed profile. Absent means use the workspace default. */
    permissionProfileId?: string | null;
    serviceTier?: string | null;
};

type Rollout = {file: FileHandle; compressed: boolean};
const MAX_CACHED_THREADS = 128;

async function openRollout(path: string): Promise<Rollout> {
    const plain = path.replace(/\.zst$/, "");
    try {
        return {file: await open(plain, "r"), compressed: false};
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return {file: await open(plain + ".zst", "r"), compressed: true};
    }
}

/** thread/read omits these settings. Read the checkpoints Codex uses on a cold resume. */
export class StoredSessionSettings {
    private readonly reads = new Map<string, {revision: string; settings: Promise<StoredSettings | null>}>();

    async read(thread: Pick<Thread, "id" | "path">): Promise<StoredSettings | null> {
        if (!thread.path || !/\.jsonl(?:\.zst)?$/.test(thread.path)) return null;
        let rollout: Rollout | undefined;
        let settings: Promise<StoredSettings | null> | undefined;
        try {
            rollout = await openRollout(thread.path);
            const stat = await rollout.file.stat({bigint: true});
            if (!stat.isFile()) return null;
            const revision = [thread.path, rollout.compressed, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("\0");
            const cached = this.reads.get(thread.id);
            if (cached?.revision === revision) return cached.settings.catch(() => null);

            settings = readCheckpoints(rollout, thread.id);
            this.reads.delete(thread.id);
            this.reads.set(thread.id, {revision, settings});
            if (this.reads.size > MAX_CACHED_THREADS) this.reads.delete(this.reads.keys().next().value!);
            return await settings;
        } catch {
            // Remote stores and older runtimes may not expose a readable local rollout. Retry read failures.
            if (settings && this.reads.get(thread.id)?.settings === settings) this.reads.delete(thread.id);
            return null;
        } finally {
            await rollout?.file.close().catch(() => {});
        }
    }
}

async function readCheckpoints({file, compressed}: Rollout, threadId: string): Promise<StoredSettings | null> {
    let ownedMode: ModeKind | null = null;
    let contextMode: ModeKind | null = null;
    let ownedTier: string | null | undefined;
    let tier: string | null | undefined;
    let ownedProfile: string | null | undefined;
    let lastProfile: string | null = null;
    let belongsToThread = false;
    const lines = new LineSplitter(line => {
        if (!line.includes('"thread_settings_applied"') && !line.includes('"turn_context"')) return;
        let record: Record<string, unknown> | null;
        try { record = recordOrNull(JSON.parse(line)); }
        catch { return; } // A writer can still be appending the final line.
        const payload = recordOrNull(record?.["payload"]);
        if (!payload) return;
        if (record?.["type"] === "turn_context") {
            contextMode = parseCollaborationMode(recordOrNull(payload["collaboration_mode"])?.["mode"]);
            lastProfile = profileId(payload);
        } else if (record?.["type"] === "event_msg" && payload["type"] === "thread_settings_applied") {
            const settings = recordOrNull(payload["thread_settings"]);
            if (!settings) return;
            const mode = parseCollaborationMode(recordOrNull(settings["collaboration_mode"])?.["mode"]);
            const savedTier = settings["service_tier"];
            // Only a recognized snapshot can use an omitted tier or profile to clear a setting.
            if (mode === null || !recordOrNull(settings["permission_profile"])
                || (savedTier != null && typeof savedTier !== "string")) return;
            lastProfile = profileId(settings);
            const owner = payload["thread_id"];
            if (owner != null) belongsToThread = owner === threadId;
            // Fork history may contain a different thread's settings. Older checkpoints omit the owner.
            const serviceTier = savedTier ?? null;
            if (owner === threadId) {
                ownedMode = mode;
                ownedTier = serviceTier;
            }
            tier = owner == null ? serviceTier : ownedTier;
            if (belongsToThread) ownedProfile = lastProfile;
        }
    });
    const input = file.createReadStream();
    const consume = async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) lines.push(chunk);
    };
    if (compressed) await pipeline(input, zlib.createZstdDecompress(), consume);
    else await consume(input);
    lines.end();
    const profile = ownedProfile === undefined ? lastProfile ?? undefined : ownedProfile;
    const collaborationMode = ownedMode ?? contextMode;
    if (collaborationMode === null && profile === undefined && tier === undefined) return null;
    return {
        collaborationMode,
        ...(profile !== undefined && {permissionProfileId: profile}),
        ...(tier !== undefined && {serviceTier: tier}),
    };
}

function profileId(settings: Record<string, unknown>): string | null {
    const id = recordOrNull(settings["active_permission_profile"])?.["id"];
    return typeof id === "string" ? id : null;
}
