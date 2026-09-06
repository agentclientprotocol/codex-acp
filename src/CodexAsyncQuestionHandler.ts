import type {ClientCapabilities} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection} from "./ACPSessionConnection";
import type {ServerNotification} from "./app-server";
import type {SessionSteerRequest, SessionSteeringResponse} from "./AcpExtensions";
import {
    ASYNC_QUESTION_REQUEST_METHOD,
    type AsyncQuestionRequest,
    type AsyncQuestionResponse,
} from "./AsyncQuestionExtension";
import {AIR_ASYNC_QUESTIONS_KEY, clientSupportsAirCapability} from "./AirExtension";
import {logger} from "./Logger";

type QuestionSession = {
    seen: Set<string>;
    pending: Set<AbortController>;
};

/** Owns questions across prompt boundaries. Never await user interaction on the notification queue. */
export class CodexAsyncQuestionHandler {
    private readonly sessions = new Map<string, QuestionSession>();

    constructor(
        private readonly connection: AcpClientConnection,
        private readonly deliver: (request: SessionSteerRequest, signal: AbortSignal) => Promise<SessionSteeringResponse>,
    ) {}

    handleNotification(notification: ServerNotification, capabilities: ClientCapabilities | null): void {
        if (notification.method !== "item/completed" || !clientSupportsAirCapability(capabilities, AIR_ASYNC_QUESTIONS_KEY)) return;
        const {threadId, turnId, item} = notification.params;
        if (item.type !== "agentMessage" || item.delivery !== "async" || !item.questions?.length) return;

        let session = this.sessions.get(threadId);
        if (!session) {
            session = {seen: new Set(), pending: new Set()};
            this.sessions.set(threadId, session);
        }
        if (session.seen.has(item.id)) return;
        session.seen.add(item.id);
        const controller = new AbortController();
        session.pending.add(controller);
        const request: AsyncQuestionRequest = {
            sessionId: threadId,
            turnId,
            itemId: item.id,
            questions: item.questions.map((question, index) => ({
                id: JSON.stringify(["request_user_input_async", item.id, index]),
                title: question.title,
                ...(question.options ? {options: question.options} : {}),
            })),
        };
        void this.ask(request, controller.signal).catch(async error => {
            if (controller.signal.aborted) return;
            logger.error("Async question request or answer delivery failed", error);
            await new ACPSessionConnection(this.connection, threadId).update({
                sessionUpdate: "agent_message_chunk",
                content: {type: "text", text: "Could not complete the question interaction. Please send your answer in chat."},
            });
        }).catch(error => logger.error("Failed to report async question error", error))
            .finally(() => session.pending.delete(controller));
    }

    cancelSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        for (const controller of session.pending) controller.abort();
        session.pending.clear();
    }

    cancelAll(): void {
        for (const sessionId of this.sessions.keys()) this.cancelSession(sessionId);
    }

    closeSession(sessionId: string): void {
        this.cancelSession(sessionId);
        this.sessions.delete(sessionId);
    }

    private async ask(request: AsyncQuestionRequest, signal: AbortSignal): Promise<void> {
        const response = await this.connection.request<AsyncQuestionResponse, AsyncQuestionRequest>(
            ASYNC_QUESTION_REQUEST_METHOD, request, {cancellationSignal: signal},
        );
        if (signal.aborted) return;
        // Extension responses are untrusted wire data, even with a typed SDK call.
        if (response?.status === "dismissed") return;
        if (response?.status !== "answered" || !Array.isArray(response.answers)
            || response.answers.length !== request.questions.length) {
            throw new Error("Invalid async question response");
        }
        const answers = new Map<string, string>();
        for (const answer of response.answers) {
            if (!answer || typeof answer.id !== "string" || typeof answer.answer !== "string"
                || !answer.answer.trim() || answers.has(answer.id)
                || !request.questions.some(question => question.id === answer.id)) {
                throw new Error("Invalid async question answer");
            }
            answers.set(answer.id, answer.answer);
        }
        const replies = request.questions.map(question => ({
            questionItemId: question.id,
            question: question.title,
            answer: answers.get(question.id)!,
        }));
        const result = await this.deliver({
            sessionId: request.sessionId,
            prompt: [{type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`}],
        }, signal);
        if (!signal.aborted && result.outcome === "failed") throw new Error("Could not deliver async question answer");
    }
}
