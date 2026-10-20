import * as acp from "@agentclientprotocol/sdk/unstable";
import {ResponseError} from "vscode-jsonrpc";
import {expect, it} from "vitest";
import {toV2Failure, toV2IdleState} from "../AcpV2Prompt";
import {CODEX_PROCESS_EXITED_ERROR_CODE} from "../app-server-recovery/AppServerExit";

it("builds standard failures without exposing opaque diagnostics, and lets cancellation win", async () => {
    const failures = [
        acp.RequestError.authRequired(),
        new ResponseError(-32603, "The command could not be completed", {private: "secret diagnostics"}),
        new acp.RequestError(CODEX_PROCESS_EXITED_ERROR_CODE, "Process stderr: secret diagnostics"),
        new Error("Internal stack detail: secret diagnostics"),
    ].map(toV2Failure);
    expect(JSON.stringify(failures)).not.toContain("secret diagnostics");
    const response: acp.PromptResponse = {
        stopReason: "end_turn",
        usage: {inputTokens: 1, outputTokens: 2, totalTokens: 3},
        _meta: {quota: {total: 3}},
    };
    await expect(JSON.stringify({
        failures,
        failed: toV2IdleState(response, failures[0]),
        cancelled: toV2IdleState({...response, stopReason: "cancelled"}, failures[0]),
        successful: toV2IdleState(response),
    }, null, 2)).toMatchFileSnapshot("data/structured-failure-v2-conversion.json");
});
