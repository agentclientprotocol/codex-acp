import {describe, expect, it, vi} from "vitest";
import type {CreateElicitationResponse} from "@agentclientprotocol/sdk/unstable";
import {
    AsyncQuestionClient,
    AsyncQuestionElicitations,
    asyncQuestionItemId,
    formatAsyncQuestionReply,
    parseAsyncQuestionReply,
    renderAsyncQuestionReply,
} from "../CodexAsyncQuestions";

const reply = {questionItemId: asyncQuestionItemId("item", 0), question: "Which environment?", answer: "Staging"};

describe("async question replies", () => {
    it("formats answers in Codex's reply envelope", () => {
        expect(formatAsyncQuestionReply([reply])).toBe(
            "<send_user_message_question_reply>\n"
            + '[{"answer":"Staging","question":"Which environment?","questionItemId":"[\\"request_user_input_async\\",\\"item\\",0]"}]\n'
            + "</send_user_message_question_reply>",
        );
    });

    it("keeps a question on one line and bounds its length", () => {
        const [parsed] = parseAsyncQuestionReply(formatAsyncQuestionReply([
            {...reply, question: `First line\nsecond line ${"é".repeat(600)}`},
        ]))!;
        expect(parsed!.question.startsWith("First line second line é")).toBe(true);
        expect([...parsed!.question]).toHaveLength(512);
    });

    it("falls back to plain text for an overlong question id", () => {
        expect(formatAsyncQuestionReply([{...reply, questionItemId: "x".repeat(513)}]))
            .toBe("> Which environment?\n\nStaging");
    });

    it("renders single and batched envelopes as questions and answers", () => {
        const one = JSON.stringify(reply);
        const two = JSON.stringify([reply, {...reply, question: "Second?", answer: "No"}]);
        expect(renderAsyncQuestionReply(` \n<send_user_message_question_reply>\n${one}\n</send_user_message_question_reply>\n `))
            .toBe("> Which environment?\n\nStaging");
        expect(renderAsyncQuestionReply(`<send_user_message_question_reply>${two}</send_user_message_question_reply>`))
            .toBe("> Which environment?\n\nStaging\n\n> Second?\n\nNo");
    });

    it("keeps malformed or embedded envelopes as ordinary text", () => {
        const one = JSON.stringify(reply);
        for (const text of [
            "> Which environment?\n\nStaging",
            "<send_user_message_question_reply>[]</send_user_message_question_reply>",
            `<send_user_message_question_reply>[${one},null]</send_user_message_question_reply>`,
            '<send_user_message_question_reply>{"question":"First?","answer":"Yes"}</send_user_message_question_reply>',
            `Quoted: <send_user_message_question_reply>${one}</send_user_message_question_reply>`,
            `<send_user_message_question_reply>${one}</send_user_message_question_reply> trailing text`,
        ]) {
            expect(renderAsyncQuestionReply(text), text).toBeNull();
        }
    });
});

describe("async question disposal", () => {
    it.each([
        {action: "accept", content: {question_0: "Staging"}},
        {action: "decline"},
        {action: "cancel"},
    ] satisfies CreateElicitationResponse[])("reports only a late accepted answer after disposal ($action)", async response => {
        let answer!: (response: CreateElicitationResponse) => void;
        const pending = new Promise<CreateElicitationResponse>(resolve => { answer = resolve; });
        const connection = {request: vi.fn(() => pending), notify: vi.fn().mockResolvedValue(undefined)};
        const steering = {executeOrQueueSteeringRequest: vi.fn().mockResolvedValue({outcome: "injected"})};
        const capabilities = {elicitation: {form: {}}, session: {notices: {}}};
        const client = new AsyncQuestionClient("thread-1", connection, capabilities, steering);
        const questions = new AsyncQuestionElicitations("thread-1", capabilities, client);
        questions.handleNotification({method: "item/completed", params: {
            threadId: "thread-1", turnId: "turn-1", completedAtMs: 0,
            item: {type: "agentMessage", id: "question", text: "Which environment?", phase: "final_answer",
                moderation: null, memoryCitation: null, delivery: "async",
                questions: [{title: "Which environment?", options: ["Staging", "Production"]}]},
        }});
        questions.dispose();
        answer(response);
        await pending;
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(steering.executeOrQueueSteeringRequest).not.toHaveBeenCalled();
        if (response.action === "accept") {
            expect(connection.notify).toHaveBeenCalledExactlyOnceWith("session/update", {
                sessionId: "thread-1",
                update: {sessionUpdate: "notice", severity: "warning", title: "Answer not sent",
                    description: "The answer could not be sent. Send it as a new message to continue."},
            });
        } else {
            expect(connection.notify).not.toHaveBeenCalled();
        }
    });
});
