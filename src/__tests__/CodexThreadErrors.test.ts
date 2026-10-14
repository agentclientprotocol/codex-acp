import {describe, expect, it} from "vitest";
import {ResponseError} from "vscode-jsonrpc/node";
import {
    isAccountReadAccountChangedError,
    isAccountReadAuthFailureError,
    isAccountReadUnavailableError,
    isInvalidThreadIdError,
    isMissingArchivedRolloutError,
    isMissingRolloutError,
    isThreadActiveWriterError,
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
// Codex 0.158, `thread/resume` while another app-server holds the thread's writer lock.
const activeWriter = new Error("thread 01a0637c-5b99-7242-9064-04545d605fdb already has an active writer");

describe("CodexThreadErrors", () => {
    it("recognises a thread whose rollout was never materialized", () => {
        expect(isMissingRolloutError(missingRollout)).toBe(true);
        expect(isMissingRolloutError(notLoaded)).toBe(false);
        expect(isMissingRolloutError(unrelated)).toBe(false);
    });

    it("recognises a thread that has no archived rollout", () => {
        const missingArchivedRollout = new Error("no archived rollout found for thread id 01a0c48a-fc81-7b33-8d61-f4e2fd7c9b99");
        expect(isMissingArchivedRolloutError(missingArchivedRollout)).toBe(true);
        expect(isMissingRolloutError(missingArchivedRollout)).toBe(false);
        expect(isMissingArchivedRolloutError(missingRollout)).toBe(false);
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

    it("recognises a thread that another Codex app-server has loaded", () => {
        expect(isThreadActiveWriterError(activeWriter)).toBe(true);
        expect(isThreadActiveWriterError({code: -32600, message: activeWriter.message})).toBe(true);
        expect(isThreadActiveWriterError(
            new Error("thread/resume failed: thread abc already has an active writer (pid 1)"),
        )).toBe(true);
        expect(isThreadActiveWriterError("session already has an active writer")).toBe(false);
        expect(isThreadActiveWriterError(missingRollout)).toBe(false);
        expect(isThreadActiveWriterError(unrelated)).toBe(false);
        expect(isUnknownThreadError(activeWriter)).toBe(false);
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

describe("account read classifiers", () => {
    // The texts of `WorkspaceRoutingError` in codex-rs/app-server account_processor/workspace_routing.rs (rust-v0.159.1).
    it.each([
        "workspace routing discovery failed",
        "workspace routing discovery timed out",
    ])("treats the internal error %s as unavailable", message => {
        const error = new ResponseError(-32603, message);
        expect(isAccountReadUnavailableError(error)).toBe(true);
        expect(isAccountReadAuthFailureError(error)).toBe(false);
        expect(isAccountReadAccountChangedError(error)).toBe(false);
    });

    it.each([
        "workspace routing discovery unauthorized (401)",
        "selected workspace missing from routing discovery",
        "workspace routing requires a ChatGPT account id",
    ])("treats the internal error %s as an auth failure", message => {
        const error = new ResponseError(-32603, message);
        expect(isAccountReadAuthFailureError(error)).toBe(true);
        expect(isAccountReadUnavailableError(error)).toBe(false);
    });

    it("treats the account change as its own case", () => {
        const error = new ResponseError(-32603, "account changed during workspace routing discovery");
        expect(isAccountReadAccountChangedError(error)).toBe(true);
        expect(isAccountReadUnavailableError(error)).toBe(false);
        expect(isAccountReadAuthFailureError(error)).toBe(false);
    });

    it.each([
        // The app-server never closes the semaphore of this error, and a shutdown is not a network failure.
        new ResponseError(-32603, "workspace routing discovery cancelled"),
        new ResponseError(-32603, "workspace routing discovery cancelled during shutdown"),
        new ResponseError(-32603, "duplicate workspace in routing discovery"),
        new ResponseError(-32600, "workspace routing discovery failed"),
        new ResponseError(-32600, "workspace routing discovery unauthorized (401)"),
        new ResponseError(-32603, "account/read: workspace routing discovery failed"),
        new Error("workspace routing discovery failed"),
        "workspace routing discovery unauthorized (401)",
        null,
        undefined,
    ])("does not classify %s", error => {
        expect(isAccountReadUnavailableError(error)).toBe(false);
        expect(isAccountReadAuthFailureError(error)).toBe(false);
        expect(isAccountReadAccountChangedError(error)).toBe(false);
    });
});
