import {describe, expect, it} from "vitest";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import {toV2CreateElicitationRequest} from "../AcpV2Elicitation";

function form(meta: unknown): acp.CreateElicitationRequest {
    return {sessionId: "session", mode: "form", message: "Choose", _meta: {codex: {delivery: "async"}},
        requestedSchema: {type: "object", properties: {
            choice: {type: "string", enum: ["Tea", "Coffee"]},
            note: {type: "string", _meta: meta},
        }}} as acp.CreateElicitationRequest;
}

describe("v2 elicitation companions", () => {
    it.each([
        {jetbrains: {air: {customAnswer: true}}},
        {jetbrains: {air: {customAnswer: {label: "Note"}}}},
        {_askUserQuestionCustomAnswer: true},
    ])("moves companion IDs to request metadata and keeps other namespaces: %j", meta => {
        const request = form(meta);
        expect(toV2CreateElicitationRequest(request)._meta).toEqual({
            codex: {delivery: "async"}, jetbrains: {air: {version: 1, customAnswerFields: ["note"]}},
        });
        expect(request._meta).toEqual({codex: {delivery: "async"}});
    });

    it.each([null, {}, {customAnswer: true}, {_askUserQuestionCustomAnswer: false},
        {jetbrains: {air: {customAnswer: false}}, _askUserQuestionCustomAnswer: true},
    ])("keeps unmarked forms unchanged: %j", meta => {
        const request = form(meta);
        expect(toV2CreateElicitationRequest(request)).toBe(request);
    });

    it("keeps URL requests unchanged", () => {
        const request: acp.CreateElicitationRequest = {sessionId: "session", mode: "url", message: "Sign in",
            url: "https://example.com", elicitationId: "login"};
        expect(toV2CreateElicitationRequest(request)).toBe(request);
    });
});
