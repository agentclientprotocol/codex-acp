/** Request/response contract for the AIR asyncQuestions capability. */
export const ASYNC_QUESTION_REQUEST_METHOD = "_session/async_question/request";

export type AsyncQuestionRequest = {
    sessionId: string;
    turnId: string;
    itemId: string;
    questions: Array<{id: string; title: string; options?: string[]}>;
};

export type AsyncQuestionResponse =
    | {status: "answered"; answers: Array<{id: string; answer: string}>}
    | {status: "dismissed"};
