/**
 * Codex's `request_user_input_async` tool asks the user questions without waiting for them: it emits an
 * `agentMessage` item with `delivery: "async"` and `questions`, and the turn goes on. Codex clients answer with
 * an ordinary user message that wraps the answers in a reply envelope:
 *
 *     <send_user_message_question_reply>
 *     [{"answer":"Staging","question":"Which environment?","questionItemId":"[\"request_user_input_async\",\"call_1\",0]"}]
 *     </send_user_message_question_reply>
 *
 * The adapter shows the questions as a form elicitation while their turn runs and steers the answers into that
 * turn in the same envelope. An answer that arrives after the turn ended is dropped, as in the Codex TUI. On
 * replay, a user message that holds an envelope is shown as the questions and their answers.
 *
 * The envelope follows Codex's `codex-rs/context-fragments/src/answered_question.rs`, and its parsing follows
 * `codex-rs/tui/src/async_question_reply.rs`.
 */
import * as acp from "@agentclientprotocol/sdk/unstable";
import {randomUUID} from "node:crypto";
import {type AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";
import type {ServerNotification} from "./app-server";
import type {ThreadItem, ToolRequestUserInputQuestion} from "./app-server/v2";
import {buildUserInputSchema, userInputAnswers, userInputAnswerText} from "./CodexElicitationHandler";
import type {CodexAcpClient} from "./CodexAcpClient";
import {clientSupportsFormElicitation} from "./ElicitationCapabilities";
import {logger} from "./Logger";
import {clientSupportsNotices, createSessionNotice} from "./SessionNotice";

const TOOL_NAME = "request_user_input_async";
const REPLY_START = "<send_user_message_question_reply>";
const REPLY_END = "</send_user_message_question_reply>";
// Codex bounds the model-authored parts of a reply, and falls back to plain text for a longer question id.
const MAX_REPLY_FIELD_LENGTH = 512;

export type AsyncQuestionReply = {questionItemId: string, question: string, answer: string};

type AsyncQuestionMessage = ThreadItem & {type: "agentMessage"};

/** The id Codex clients give a question: the tool name, the id of the message that asked it, and its index. */
export function asyncQuestionItemId(messageId: string, index: number): string {
    return JSON.stringify([TOOL_NAME, messageId, index]);
}

/** The user message text that answers async questions. */
export function formatAsyncQuestionReply(replies: readonly AsyncQuestionReply[]): string {
    const bounded = replies.map(reply => ({
        ...reply,
        question: [...reply.question].slice(0, MAX_REPLY_FIELD_LENGTH).join("").replace(/[\r\n]/g, " "),
    }));
    if (bounded.some(reply => reply.questionItemId.length > MAX_REPLY_FIELD_LENGTH)) {
        return displayReplies(bounded);
    }
    // Codex writes the keys in this order.
    const body = bounded.map(({answer, question, questionItemId}) => ({answer, question, questionItemId}));
    return `${REPLY_START}\n${JSON.stringify(body)}\n${REPLY_END}`;
}

/**
 * The replies in a user message that is exactly one reply envelope with one reply or an array of them, or
 * `null`. Text around the envelope makes it an ordinary message.
 */
export function parseAsyncQuestionReply(text: string): AsyncQuestionReply[] | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith(REPLY_START) || !trimmed.endsWith(REPLY_END)) return null;
    let body: unknown;
    try {
        body = JSON.parse(trimmed.slice(REPLY_START.length, trimmed.length - REPLY_END.length));
    } catch {
        return null;
    }
    const replies = Array.isArray(body) ? body : [body];
    if (replies.length === 0 || !replies.every(isReply)) return null;
    return replies.map(({questionItemId, question, answer}) => ({questionItemId, question, answer}));
}

/** A user message that answers async questions, as each question in a quote followed by its answer. */
export function renderAsyncQuestionReply(text: string): string | null {
    const replies = parseAsyncQuestionReply(text);
    return replies === null ? null : displayReplies(replies);
}

function displayReplies(replies: readonly AsyncQuestionReply[]): string {
    return replies.map(reply => `> ${reply.question}\n\n${reply.answer}`).join("\n\n");
}

function isReply(value: unknown): value is AsyncQuestionReply {
    if (typeof value !== "object" || value === null) return false;
    const reply = value as Record<string, unknown>;
    return typeof reply["questionItemId"] === "string"
        && typeof reply["question"] === "string"
        && typeof reply["answer"] === "string";
}

/** Reaches the ACP client and Codex on behalf of the async questions of one session. */
export class AsyncQuestionClient {
    /**
     * @param sessionId The session that the questions belong to.
     * @param connection The connection to the ACP client.
     * @param clientCapabilities The capabilities that the ACP client declared.
     * @param codexAcpClient Returns the current Codex client, which changes when the app-server restarts.
     */
    constructor(
        private readonly sessionId: string,
        private readonly connection: AcpClientConnection,
        private readonly clientCapabilities: acp.ClientCapabilities | null,
        private readonly codexAcpClient: () => CodexAcpClient,
    ) {}

    /** Sends the elicitation without marking the session as waiting for the user. */
    createElicitation(request: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse> {
        const v2 = AcpV2Connection.of(this.connection);
        return v2 !== null
            ? v2.createElicitation(request, {cancellationSignal: signal}, {userAction: false})
            : this.connection.request(acp.methods.client.elicitation.create, request, {cancellationSignal: signal});
    }

    /** Steers the text into the turn; rejects if that turn is no longer running. */
    async steer(turnId: string, text: string): Promise<void> {
        await this.codexAcpClient().steerTurn({
            threadId: this.sessionId,
            turnId,
            prompt: [{type: "text", text}],
            clientUserMessageId: randomUUID(),
        });
    }

    /** Tells the user that an answer was not sent, if the client supports notices. */
    async reportDroppedAnswer(): Promise<void> {
        if (!clientSupportsNotices(this.clientCapabilities)) return;
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId: this.sessionId,
            update: createSessionNotice(
                "warning",
                "Answer not sent",
                "Codex finished before your answer arrived. Send it as a new message if it still matters.",
            ),
        });
    }
}

/** Shows the async questions of one session as elicitations, for as long as the turn that asked them runs. */
export class AsyncQuestionElicitations {
    // The running turns that asked a question, each with the signal that cancels its questions.
    private readonly turns = new Map<string, AbortController>();

    constructor(
        private readonly sessionId: string,
        private readonly clientCapabilities: acp.ClientCapabilities | null,
        private readonly client: AsyncQuestionClient,
    ) {}

    /** Asks the questions of a completed async message and cancels them when their turn ends; never waits. */
    handleNotification(notification: ServerNotification): void {
        switch (notification.method) {
            case "item/completed": {
                const {threadId, turnId, item} = notification.params;
                if (threadId === this.sessionId && item.type === "agentMessage" && item.delivery === "async"
                    && (item.questions?.length ?? 0) > 0) {
                    this.ask(turnId, item);
                }
                return;
            }
            case "turn/completed":
                if (notification.params.threadId === this.sessionId) {
                    this.endTurn(notification.params.turn.id);
                }
                return;
            default:
                return;
        }
    }

    /** Cancels every open question, when the session closes or its app-server is gone. */
    dispose(): void {
        for (const turnId of [...this.turns.keys()]) {
            this.endTurn(turnId);
        }
    }

    private endTurn(turnId: string): void {
        this.turns.get(turnId)?.abort();
        this.turns.delete(turnId);
    }

    private ask(turnId: string, message: AsyncQuestionMessage): void {
        if (!clientSupportsFormElicitation(this.clientCapabilities)) return;
        let turn = this.turns.get(turnId);
        if (turn === undefined) {
            turn = new AbortController();
            this.turns.set(turnId, turn);
        }
        const questions = formQuestions(message);
        const request: acp.CreateElicitationRequest = {
            sessionId: this.sessionId,
            mode: "form",
            message: "Codex keeps working while you answer. An answer sent after it finishes is not delivered.",
            // Questions are answered independently, as in Codex.
            requestedSchema: buildUserInputSchema(questions, this.clientCapabilities, false),
            _meta: {codex: {delivery: "async"}},
        };
        void this.client.createElicitation(request, turn.signal).then(
            response => this.answer(turnId, message, questions, response)
                .catch(error => logger.error("Failed to deliver an async question answer", error)),
            error => logger.log("Async question closed without an answer", {sessionId: this.sessionId, turnId, error}),
        );
    }

    private async answer(
        turnId: string,
        message: AsyncQuestionMessage,
        questions: readonly ToolRequestUserInputQuestion[],
        response: acp.CreateElicitationResponse,
    ): Promise<void> {
        const answers = userInputAnswers(response, questions, this.clientCapabilities);
        const replies = questions.flatMap((question, index): AsyncQuestionReply[] => {
            const answer = userInputAnswerText(answers[question.id]?.answers ?? []);
            return answer.length === 0 ? [] : [{
                questionItemId: asyncQuestionItemId(message.id, index),
                question: question.question,
                answer,
            }];
        });
        if (replies.length === 0) return;
        if (this.turns.has(turnId)) {
            try {
                await this.client.steer(turnId, formatAsyncQuestionReply(replies));
                return;
            } catch (error) {
                logger.log("Async question answer was not steered into its turn", {sessionId: this.sessionId, turnId, error});
            }
        }
        logger.log("Dropped an async question answer: its turn has ended", {sessionId: this.sessionId, turnId});
        await this.client.reportDroppedAnswer();
    }
}

function formQuestions(message: AsyncQuestionMessage): ToolRequestUserInputQuestion[] {
    return (message.questions ?? []).map((question, index) => {
        const options = question.options ?? [];
        return {
            id: `question_${index}`,
            header: "",
            question: question.title,
            // Codex always accepts an own answer.
            isOther: options.length > 0,
            isSecret: false,
            options: options.length > 0 ? options.map(label => ({label, description: ""})) : null,
        };
    });
}
