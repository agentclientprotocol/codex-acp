import {describe, expect, it} from "vitest";
import {
    isInvalidThreadIdError,
    isMissingRolloutError,
    isThreadNotLoadedError,
    isUnknownThreadError,
} from "../CodexThreadErrors";

// The literal wordings Codex 0.155 answers with, captured from a live
// app-server; the classifiers only promise to recognise these shapes.
const missingRollout = new Error("no rollout found for thread id 01a0c48a-fc81-7b33-8d61-f4e2fd7c9b99");
const notLoaded = new Error("thread not loaded: 01a0c000-0000-7000-8000-000000000001");
const invalidThreadId = new Error(
    "invalid thread id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `n` at 1"
);
const invalidSessionId = new Error(
    "invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `t` at 1"
);
const unrelated = new Error("stream disconnected before completion");

describe("CodexThreadErrors", () => {
    it("recognises a thread whose rollout was never materialized", () => {
        expect(isMissingRolloutError(missingRollout)).toBe(true);
        expect(isMissingRolloutError(notLoaded)).toBe(false);
        expect(isMissingRolloutError(unrelated)).toBe(false);
    });

    it("recognises a thread that is not loaded in the app-server", () => {
        expect(isThreadNotLoadedError(notLoaded)).toBe(true);
        expect(isThreadNotLoadedError(missingRollout)).toBe(false);
    });

    it("recognises an id Codex cannot parse as a thread id", () => {
        expect(isInvalidThreadIdError(invalidThreadId)).toBe(true);
        expect(isInvalidThreadIdError(invalidSessionId)).toBe(true);
        expect(isInvalidThreadIdError(missingRollout)).toBe(false);
    });

    it("treats every 'no persisted thread' shape as an unknown thread", () => {
        for (const err of [missingRollout, notLoaded, invalidThreadId, invalidSessionId]) {
            expect(isUnknownThreadError(err)).toBe(true);
        }
        expect(isUnknownThreadError(unrelated)).toBe(false);
    });

    it("reads the message off non-Error rejections too", () => {
        expect(isUnknownThreadError({code: -32600, message: notLoaded.message})).toBe(true);
        expect(isUnknownThreadError(missingRollout.message)).toBe(true);
        expect(isUnknownThreadError(undefined)).toBe(false);
        expect(isUnknownThreadError(null)).toBe(false);
    });
});
