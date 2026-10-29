import {describe, expect, it} from "vitest";
import {
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
