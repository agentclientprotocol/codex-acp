import {RequestError} from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {Thread, ThreadAttachmentAddParams, ThreadAttachmentAddResponse, ThreadAttachmentListParams, ThreadAttachmentListResponse, ThreadAttachmentRemoveParams, ThreadAttachmentRemoveResponse} from "./app-server/v2";

export const SESSION_SEARCH_METHOD = "_session/search";
export const SESSION_ATTACHMENTS_METHOD = "_session/attachments";
const identifier = z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !Array.from(value).some(char => char.charCodeAt(0) < 32));
const page = {cursor: identifier.nullable().optional(), limit: z.number().int().min(1).max(100).optional()};
export const sessionSearchParser = z.object({
    searchTerm: z.string().trim().min(1).max(4096),
    archived: z.boolean().optional(),
    ...page,
}).strict();
export type SessionSearchRequest = z.infer<typeof sessionSearchParser>;
// Typed experimental method omitted from the package's generated subset. Shape
// verified against native 0.160.1 and the public app-server protocol source.
export type NativeThreadSearchParams = SessionSearchRequest;
export type NativeThreadSearchResponse = {data: Array<{thread: Thread, snippet: string}>, nextCursor: string | null, backwardsCursor?: string | null};

const attachmentIdentity = {sessionId: identifier, attachmentType: identifier, identityKey: identifier};
const boundedJson = z.json().refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024, "Attachment payload exceeds 256 KiB");
export const sessionAttachmentsParser = z.discriminatedUnion("action", [
    z.object({sessionId: identifier, action: z.literal("list"), ...page}).strict(),
    z.object({...attachmentIdentity, action: z.literal("add"), payload: boundedJson}).strict(),
    z.object({...attachmentIdentity, action: z.literal("remove")}).strict(),
]);
export type SessionAttachmentsRequest = z.infer<typeof sessionAttachmentsParser>;
export type SessionDiscoveryClient = {
    threadSearch(params: NativeThreadSearchParams): Promise<NativeThreadSearchResponse>;
    threadAttachmentList(params: ThreadAttachmentListParams): Promise<ThreadAttachmentListResponse>;
    threadAttachmentAdd(params: ThreadAttachmentAddParams): Promise<ThreadAttachmentAddResponse>;
    threadAttachmentRemove(params: ThreadAttachmentRemoveParams): Promise<ThreadAttachmentRemoveResponse>;
};

export function sessionDiscoveryCapability() {
    return {
        version: 1,
        searchMethod: SESSION_SEARCH_METHOD,
        attachmentMethod: SESSION_ATTACHMENTS_METHOD,
        attachmentActions: ["list", "add", "remove"],
        attachmentsAreMetadata: true,
    };
}

/** Search is native text search, not a model prompt or a local scan of files. */
export async function searchSessions(client: Pick<SessionDiscoveryClient, "threadSearch">, params: SessionSearchRequest) {
    const response = await client.threadSearch(sessionSearchParser.parse(params));
    return {
        version: 1,
        sessions: response.data.map(({thread, snippet}) => ({
            sessionId: thread.id, cwd: thread.cwd, title: thread.name ?? thread.preview,
            updatedAt: thread.updatedAt, snippet,
        })),
        nextCursor: response.nextCursor,
    };
}

/** These are independently persisted native thread attachments (PR links,
 * worktree associations, etc.), not prompt images or disk operations. The host
 * remains responsible for actually creating/removing any associated resource. */
export async function sessionAttachments(
    client: Omit<SessionDiscoveryClient, "threadSearch">,
    sessionId: string,
    params: SessionAttachmentsRequest,
): Promise<{version: 1, data: unknown}> {
    params = sessionAttachmentsParser.parse(params);
    if (params.sessionId !== sessionId) throw RequestError.invalidParams(undefined, "Session mismatch");
    switch (params.action) {
        case "list": return {version: 1, data: await client.threadAttachmentList({threadId: sessionId, ...(params.cursor === undefined ? {} : {cursor: params.cursor}), ...(params.limit === undefined ? {} : {limit: params.limit})})};
        case "add": return {version: 1, data: await client.threadAttachmentAdd({threadId: sessionId, attachmentType: params.attachmentType, identityKey: params.identityKey, payload: params.payload})};
        case "remove": return {version: 1, data: await client.threadAttachmentRemove({threadId: sessionId, attachmentType: params.attachmentType, identityKey: params.identityKey})};
    }
}
