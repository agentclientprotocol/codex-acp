import * as acp from "@agentclientprotocol/sdk/unstable";
import {AcpV2Connection, type AcpClientConnection} from "./ACPSessionConnection";
import type {ItemCompletedNotification, AsyncUserInputQuestion} from "./app-server/v2";
import type {ConnectionLoss} from "./app-server-recovery/ConnectionLoss";
import {clientSupportsFormElicitation} from "./ElicitationCapabilities";
import {isRecord} from "./permissions/json";
import {logger} from "./Logger";

type QuestionField = {name: string; question: AsyncUserInputQuestion; other: string};

/** Async questions outlive a prompt, but never the connection or an explicit cancellation. */
export class CodexAsyncQuestions {
    private readonly seen = new Map<string, Set<string>>();
    private readonly pending = new Map<string, Set<AbortController>>();

    constructor(
        private readonly connection: AcpClientConnection,
        private readonly capabilities: () => acp.ClientCapabilities | null,
        private readonly deliver: (sessionId: string, text: string, signal: AbortSignal) => Promise<void>,
    ) {}

    handle(event: ItemCompletedNotification, loss: ConnectionLoss, cancellation?: AbortSignal): void {
        const {item, threadId} = event;
        if (item.type !== "agentMessage" || item.delivery !== "async" || !item.questions?.length
            || !clientSupportsFormElicitation(this.capabilities()) || loss.lost || cancellation?.aborted) return;
        let seen = this.seen.get(threadId);
        if (!seen) this.seen.set(threadId, seen = new Set());
        if (seen.has(item.id)) return;
        seen.add(item.id);

        const controller = new AbortController();
        let pending = this.pending.get(threadId);
        if (!pending) this.pending.set(threadId, pending = new Set());
        pending.add(controller);
        const abort = () => controller.abort();
        const removeLossListener = loss.onLost(abort);
        cancellation?.addEventListener("abort", abort, {once: true});
        void this.ask(threadId, item.questions, controller.signal).catch(error => {
            if (!controller.signal.aborted) logger.error("Failed to answer Codex async questions", error);
        }).finally(() => {
            removeLossListener();
            cancellation?.removeEventListener("abort", abort);
            pending.delete(controller);
            if (pending.size === 0 && this.pending.get(threadId) === pending) this.pending.delete(threadId);
        });
    }

    cancel(sessionId: string): void {
        for (const controller of this.pending.get(sessionId) ?? []) controller.abort();
        this.pending.delete(sessionId);
    }

    forget(sessionId: string): void {
        this.cancel(sessionId);
        this.seen.delete(sessionId);
    }

    private async ask(sessionId: string, questions: AsyncUserInputQuestion[], signal: AbortSignal): Promise<void> {
        const fields: QuestionField[] = questions.map((question, i) => {
            let other = "Other (write below)";
            while (question.options?.includes(other)) other += " ";
            return {name: `question_${i + 1}`, question, other};
        });
        const properties: Record<string, acp.ElicitationPropertySchema> = {};
        for (const {name, question, other} of fields) {
            properties[name] = question.options?.length ? {
                type: "string", title: question.title,
                enum: [...new Set(question.options), other],
            } : {type: "string", title: question.title, minLength: 1};
            if (question.options?.length) {
                properties[`${name}_custom`] = {
                    type: "string", title: `Custom answer: ${question.title}`,
                    description: `Used when you select "${other}".`,
                };
            }
        }
        const request: acp.CreateElicitationRequest = {
            sessionId, mode: "form", message: "Codex has questions. It can continue working while you answer.",
            requestedSchema: {type: "object", properties, required: fields.map(field => field.name)},
        };
        const options = {cancellationSignal: signal};
        const v2 = AcpV2Connection.of(this.connection);
        // A pending async question is not evidence that foreground work is blocked.
        const responsePromise = v2
            ? v2.createElicitation(request, options, false)
            : this.connection.request(acp.methods.client.elicitation.create, request, options);
        let onAbort!: () => void;
        const cancelled = new Promise<null>(resolve => {
            onAbort = () => resolve(null);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, {once: true});
        });
        try {
            // The SDK sends cancellation but need not settle a request whose client never replies.
            const response = await Promise.race([responsePromise, cancelled]);
            if (signal.aborted || !response || !acp.CreateElicitationResponse.isAccept(response)) return;
            const content = isRecord(response.content) ? response.content : {};
            const answers = fields.map(({name, question, other}) => {
                const choice = content?.[name];
                const answer = choice === other && question.options?.length ? content?.[`${name}_custom`] : choice;
                if (typeof answer !== "string" || !answer.trim()
                    || (question.options?.length && choice !== other && !question.options.includes(choice as string))) {
                    throw new Error(`Missing or invalid answer for ${name}`);
                }
                return {question: question.title, answer};
            });
            if (!signal.aborted) await this.deliver(sessionId, `Answers to your questions:\n${JSON.stringify(answers, null, 2)}`, signal);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    }
}
