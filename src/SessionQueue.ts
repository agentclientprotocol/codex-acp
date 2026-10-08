import {RequestError} from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {Turn} from "./app-server/v2/Turn";

export const SESSION_QUEUE_METHOD = "_session/queue";
export const SESSION_QUEUE_ACTIONS = ["list", "add", "update", "delete", "reorder", "start"] as const;
export type SessionQueueAction = typeof SESSION_QUEUE_ACTIONS[number];

// A conservative tested floor, NOT a claim about the first native release.
// Source: codex-rs/app-server-protocol/src/protocol/v2/thread.rs:926-1027;
// experimental registrations: protocol/common.rs:630-664. Not generated types.
export const SESSION_QUEUE_MIN_NATIVE_VERSION = "0.160.1";

const identifier = z.string().refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value));
const byteOffset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const textElement = z.strictObject({
    byteRange: z.strictObject({start: byteOffset, end: byteOffset}),
    placeholder: z.string().nullable().optional(),
});
const detail = z.enum(["auto", "low", "high", "original"]).nullable().optional();

// Preserve native UserInput, including snake_case text_elements and omitted
// serde-default fields. No ACP text/image conversion, defaults, or dropped keys.
// Source: protocol/v2/turn.rs:382-474. New variants require an explicit review.
const nativeInput = z.union([
    z.strictObject({type: z.literal("text"), text: z.string(), text_elements: z.array(textElement).optional()}),
    z.strictObject({type: z.literal("image"), url: z.string(), detail}),
    z.strictObject({type: z.literal("image"), fileId: z.string(), detail}),
    z.strictObject({type: z.literal("localImage"), path: z.string(), detail}),
    z.strictObject({type: z.literal("audio"), url: z.string()}),
    z.strictObject({type: z.literal("localAudio"), path: z.string()}),
    z.strictObject({type: z.literal("skill"), name: z.string(), path: z.string()}),
    z.strictObject({type: z.literal("mention"), name: z.string(), path: z.string()}),
]);
export type NativeQueueInput = z.infer<typeof nativeInput>;

const session = {sessionId: identifier};
const requestSchema = z.discriminatedUnion("action", [
    z.strictObject({
        ...session, action: z.literal("list"), cursor: z.string().nullable().optional(),
        limit: z.number().int().min(0).max(0xffff_ffff).nullable().optional(),
    }),
    z.strictObject({
        ...session, action: z.literal("add"), input: z.array(nativeInput), clientUserMessageId: identifier,
    }),
    z.strictObject({
        ...session, action: z.literal("update"), queuedSubmissionId: identifier, input: z.array(nativeInput),
    }),
    z.strictObject({...session, action: z.literal("delete"), queuedSubmissionId: identifier}),
    z.strictObject({...session, action: z.literal("reorder"), queuedSubmissionIds: z.array(identifier)}),
    z.strictObject({...session, action: z.literal("start"), queuedSubmissionId: identifier.nullable().optional()}),
]);
export type SessionQueueRequest = z.infer<typeof requestSchema>;

export function parseSessionQueueRequest(value: unknown): SessionQueueRequest {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) {
        // Do not echo prompt content, attachment URLs, or unknown injected fields.
        throw RequestError.invalidParams(undefined, "Invalid session queue request");
    }
    return parsed.data;
}

export type NativeQueuedSubmission = {
    id: string;
    input: NativeQueueInput[];
    clientUserMessageId: string;
    [key: string]: unknown;
};
export type NativeQueueListResponse = {data: NativeQueuedSubmission[]; nextCursor: string | null; [key: string]: unknown};
export type NativeQueueWriteResponse = {queuedSubmission: NativeQueuedSubmission; [key: string]: unknown};
export type NativeQueueDeleteResponse = {deleted: boolean; [key: string]: unknown};
export type NativeQueueReorderResponse = Record<string, unknown>;
export type NativeQueueStartResponse = {turn: Turn; [key: string]: unknown};

type NativeParams<A extends SessionQueueAction> =
    Omit<Extract<SessionQueueRequest, {action: A}>, "sessionId" | "action"> & {threadId: string};

/** No caller-selectable RPC method or free-form native params escape hatch. */
export interface SessionQueueNative {
    list(params: NativeParams<"list">): Promise<NativeQueueListResponse>;
    add(params: NativeParams<"add">): Promise<NativeQueueWriteResponse>;
    update(params: NativeParams<"update">): Promise<NativeQueueWriteResponse>;
    delete(params: NativeParams<"delete">): Promise<NativeQueueDeleteResponse>;
    reorder(params: NativeParams<"reorder">): Promise<NativeQueueReorderResponse>;
    /** This starts real generation. The owning server must attach turn handlers first. */
    start(params: NativeParams<"start">): Promise<NativeQueueStartResponse>;
}

export type SessionQueueSupport = {
    readonly nativeVersion: string | null;
    readonly actions: readonly SessionQueueAction[];
};

function eligibleNativeVersion(version: string | null | undefined): boolean {
    // Only an actual normalized stable native version. An npm package version,
    // missing version, or unverified prerelease is not support evidence.
    const match = version?.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (![major, minor, patch].every(value => Number.isSafeInteger(value))) return false;
    return major! > 0 || minor! > 160 || (minor === 160 && patch! >= 1);
}

/**
 * The integrator supplies per-action POSITIVE evidence from the running native
 * process (e.g. its actual experimental schema, or a side-effect-free parameter
 * validation probe). A list-only probe proves only list. Never call a valid
 * add/update/delete/reorder/start to probe, and never treat an arbitrary -32602,
 * auth/store/network error, or package version as proof of method support.
 * Cache only for that native process generation; re-probe on restart/override.
 */
export async function probeSessionQueueSupport(
    nativeVersion: string | null | undefined,
    probeAction: (action: SessionQueueAction) => Promise<boolean>,
): Promise<SessionQueueSupport> {
    const actions: SessionQueueAction[] = [];
    if (eligibleNativeVersion(nativeVersion)) {
        for (const action of SESSION_QUEUE_ACTIONS) {
            try {
                if (await probeAction(action) === true) actions.push(action);
            } catch {
                // Absence of affirmative evidence leaves this action unadvertised.
            }
        }
    }
    return Object.freeze({nativeVersion: nativeVersion ?? null, actions: Object.freeze(actions)});
}

export function sessionQueueCapability(support: SessionQueueSupport) {
    if (!eligibleNativeVersion(support.nativeVersion)) return undefined;
    const actions = SESSION_QUEUE_ACTIONS.filter(action => support.actions.includes(action));
    if (actions.length === 0) return undefined;
    return {version: 1 as const, method: SESSION_QUEUE_METHOD, actions};
}

export type SessionQueueResponse =
    | {status: "unsupported"}
    | {status: "ok"; result: NativeQueueListResponse | NativeQueueWriteResponse |
        NativeQueueDeleteResponse | NativeQueueReorderResponse | NativeQueueStartResponse};

/**
 * Must run INSIDE the server's lifecycle reservation for this exact session and
 * native process: serialize with prompt, rewind, close, delete, provider change,
 * and queue operations until the native promise settles. A timeout/transport
 * loss does not imply no mutation; the caller must reconcile, never auto-retry.
 * This module has no transport, process launching, locks, or event ownership.
 */
export async function runSessionQueue(
    value: unknown,
    dependencies: {sessionId: string; support: SessionQueueSupport; native: SessionQueueNative},
): Promise<SessionQueueResponse> {
    const request = parseSessionQueueRequest(value);
    if (request.sessionId !== dependencies.sessionId) {
        throw RequestError.invalidParams(undefined, "Queue request does not target the bound session");
    }
    const capability = sessionQueueCapability(dependencies.support);
    if (!capability?.actions.includes(request.action)) return {status: "unsupported"};
    const threadId = dependencies.sessionId;
    const native = dependencies.native;
    try {
        switch (request.action) {
            case "list":
                return {status: "ok", result: await native.list({
                    threadId,
                    ...("cursor" in request ? {cursor: request.cursor} : {}),
                    ...("limit" in request ? {limit: request.limit} : {}),
                })};
            case "add":
                return {status: "ok", result: await native.add({threadId, input: request.input, clientUserMessageId: request.clientUserMessageId})};
            case "update":
                return {status: "ok", result: await native.update({threadId, queuedSubmissionId: request.queuedSubmissionId, input: request.input})};
            case "delete":
                return {status: "ok", result: await native.delete({threadId, queuedSubmissionId: request.queuedSubmissionId})};
            case "reorder":
                return {status: "ok", result: await native.reorder({threadId, queuedSubmissionIds: request.queuedSubmissionIds})};
            case "start":
                return {status: "ok", result: await native.start({
                    threadId,
                    ...("queuedSubmissionId" in request ? {queuedSubmissionId: request.queuedSubmissionId} : {}),
                })};
        }
    } catch (error) {
        // A definitive JSON-RPC method-not-found is safe to report as unsupported.
        // No other error is converted to success/unsupported and nothing retries.
        if (typeof error === "object" && error !== null && "code" in error && error.code === -32601) {
            return {status: "unsupported"};
        }
        throw error;
    }
}
