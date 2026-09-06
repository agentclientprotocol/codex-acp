import type {ClientCapabilities} from "@agentclientprotocol/sdk";

/** Experimental, versioned provider extension; not a standard ACP method. */
export const ASYNC_QUESTIONS_CAPABILITY = "codex.asyncQuestions";
export const ASYNC_QUESTIONS_VERSION = 1;
export const ASYNC_QUESTION_REQUEST_METHOD = "_codex/requestUserInput";

export type AsyncQuestionRequest = {
    sessionId: string;
    turnId: string;
    itemId: string;
    questions: Array<{id: string; title: string; options?: string[]}>;
};

export type AsyncQuestionResponse =
    | {status: "answered"; answers: Array<{id: string; answer: string}>}
    | {status: "dismissed"};

export function asyncQuestionsCapability() {
    return {version: ASYNC_QUESTIONS_VERSION, requestMethod: ASYNC_QUESTION_REQUEST_METHOD};
}

export function clientSupportsAsyncQuestions(capabilities: ClientCapabilities | null): boolean {
    const value = capabilities?._meta?.[ASYNC_QUESTIONS_CAPABILITY];
    return typeof value === "object" && value !== null
        && "version" in value && value.version === ASYNC_QUESTIONS_VERSION;
}
