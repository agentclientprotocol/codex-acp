import {describe, expect, it, vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ItemCompletedNotification} from "../app-server/v2";
import {CodexAsyncQuestions} from "../CodexAsyncQuestions";
import {ConnectionLoss} from "../app-server-recovery/ConnectionLoss";

function fixture() {
    let lose!: () => void;
    const loss = new ConnectionLoss({onClose: (fn: () => void) => { lose = fn; }} as unknown as MessageConnection);
    let reply!: (value: unknown) => void;
    let signal!: AbortSignal;
    const request = vi.fn((_method, _params, options) => {
        signal = options.cancellationSignal;
        return new Promise(resolve => { reply = resolve; });
    });
    const deliver = vi.fn(async () => {});
    const questions = new CodexAsyncQuestions({request} as unknown as AcpClientConnection,
        () => ({elicitation: {form: {}}}), deliver);
    const event: ItemCompletedNotification = {
        threadId: "session", turnId: "turn", completedAtMs: 0,
        item: {type: "agentMessage", id: "question", text: "Why?", delivery: "async",
            questions: [{title: "Why?", options: null}], phase: "final_answer", memoryCitation: null},
    };
    return {questions, event, loss, lose: () => lose(), reply: (value: unknown) => reply(value), signal: () => signal, request, deliver};
}

describe("async question lifetime", () => {
    it("cancels a form on app-server loss and never delivers its late answer", async () => {
        const f = fixture();
        f.questions.handle(f.event, f.loss);
        f.lose();
        expect(f.signal().aborted).toBe(true);
        f.reply({action: "accept", content: {question_1: "late"}});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(f.deliver).not.toHaveBeenCalled();
        f.questions.handle({...f.event, item: {...f.event.item, id: "new-question"}}, f.loss);
        expect(f.request).toHaveBeenCalledTimes(1);
    });

    it("cancels a form when its originating prompt is cancelled", async () => {
        const f = fixture();
        const cancelled = new AbortController();
        f.questions.handle(f.event, f.loss, cancelled.signal);
        cancelled.abort();
        expect(f.signal().aborted).toBe(true);
        f.reply({action: "accept", content: {question_1: "late"}});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(f.deliver).not.toHaveBeenCalled();
    });

    it("suppresses duplicate completion events even after an answer", async () => {
        const f = fixture();
        f.questions.handle(f.event, f.loss);
        f.reply({action: "accept", content: {question_1: "because"}});
        await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(1));
        f.questions.handle(f.event, f.loss);
        expect(f.request).toHaveBeenCalledTimes(1);
    });
});
