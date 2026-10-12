import type {UpdateSessionEvent} from "./ACPSessionConnection";
import type {ThreadItem} from "./app-server/v2";
import {createAgentTextMessageChunk} from "./ContentChunks";

export function createAsyncUserInputUpdate(item: Extract<ThreadItem, {type: "agentMessage"}>): UpdateSessionEvent | null {
    if (!item.questions?.length) return null;
    const questions = item.questions.map(question => ({
        title: question.title,
        options: question.options,
    }));
    const text = questions.map(question => {
        const options = (question.options ?? []).map(option => `- ${option}`).join("\n");
        return options ? `${question.title}\n${options}` : question.title;
    }).join("\n\n");
    return createAgentTextMessageChunk(text, item.id, {
        "codex/asyncUserInput": {id: item.id, questions},
    });
}
