import {describe, expect, it} from "vitest";
import {readableServiceErrorMessage} from "../ServiceErrorMessage";

const message = "The model is not supported with this account.";
const envelope = {type: "error", status: 400, error: {type: "invalid_request_error", message}};

describe("service error messages", () => {
    it.each([
        "invalid_request_error", "server_error", "rate_limit_error", "insufficient_quota",
        "authentication_error", "permission_error", "not_found_error", "conflict_error", "overloaded_error",
    ])("reads the known %s envelope", type => {
        expect(readableServiceErrorMessage(JSON.stringify({...envelope, error: {type, message}}))).toBe(message);
    });

    it.each([{code: "unsupported_model", param: "model"}, {code: null, param: null}])(
        "reads optional standard fields: %j", fields => {
            expect(readableServiceErrorMessage(JSON.stringify({...envelope, error: {...envelope.error, ...fields}}))).toBe(message);
        },
    );

    it.each([
        "Plain error text", "", "{not json}", "null", "[]", '"json string"',
        JSON.stringify({error: {message}}),
        JSON.stringify({...envelope, custom: true}),
        JSON.stringify({...envelope, type: "custom"}),
        JSON.stringify({...envelope, status: "400"}),
        ...[200, 399, 600, 400.5].map(status => JSON.stringify({...envelope, status})),
        JSON.stringify({...envelope, error: {type: "custom_error", message}}),
        JSON.stringify({...envelope, error: {...envelope.error, custom: true}}),
        JSON.stringify({...envelope, error: {...envelope.error, code: 123}}),
        JSON.stringify({...envelope, error: {...envelope.error, param: {name: "model"}}}),
        JSON.stringify({...envelope, error: {type: 123, message}}),
        JSON.stringify({...envelope, error: {type: "invalid_request_error", message: ""}}),
        JSON.stringify({...envelope, error: {type: "invalid_request_error", message: "  "}}),
        JSON.stringify({...envelope, error: {type: "invalid_request_error", message: 123}}),
    ])("preserves other text verbatim: %s", text => {
        expect(readableServiceErrorMessage(text)).toBe(text);
    });
});
