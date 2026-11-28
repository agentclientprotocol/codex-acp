import {RequestError, type SessionId} from "@agentclientprotocol/sdk/unstable";
import {z} from "zod";
import {isAbsoluteProtocolPath} from "./PathUtils";

export const SESSION_READ_METHOD = "_session/read";
export const SESSION_READ_META_KEY = "sessionRead";
export const SESSION_ALREADY_OPEN_REASON = "session_already_open";

export type SessionReadCapability = {
    supported: true;
};

export function sessionReadCapability(): SessionReadCapability {
    return {supported: true};
}

export type SessionReadRequest = {
    sessionId: SessionId;
    cwd?: string | null | undefined;
    _meta?: Record<string, unknown> | null | undefined;
};

export type SessionReadResponse = {};

export const sessionReadParamsParser = z.object({
    sessionId: z.string().trim().min(1),
    cwd: z.string().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

export function parseSessionReadParams(params: Record<string, unknown>): SessionReadRequest {
    const parsed = sessionReadParamsParser.safeParse(params);
    if (!parsed.success) {
        throw RequestError.invalidParams(undefined, parsed.error.issues[0]?.message ?? "Invalid session read parameters");
    }
    const {sessionId, cwd, _meta} = parsed.data;
    if (cwd != null && !isAbsoluteProtocolPath(cwd)) {
        throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    }
    return {
        sessionId,
        ...(cwd != null ? {cwd} : {}),
        ...(_meta != null ? {_meta} : {}),
    };
}

export function sessionAlreadyOpenRequestError(sessionId: string): RequestError {
    return RequestError.invalidRequest(
        {reason: SESSION_ALREADY_OPEN_REASON, sessionId},
        `Session ${sessionId} is already open or being read on this connection.`,
    );
}
