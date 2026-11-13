import {describe, expect, it} from "vitest";
import {developerText, findPromptRequest} from "./integration/model-request";

const message = (role: string, text: string) => ({
    type: "message", role, content: [{type: "input_text", text}],
});

describe("model request inspection", () => {
    it("reads developer messages without treating additional tools as message content", () => {
        const request = {input: [
            {type: "additional_tools", role: "developer", tools: []},
            message("developer", "Configured instructions"),
            message("developer", "Client instructions"),
            message("user", "A user prompt"),
        ]};
        expect(developerText(request)).toBe("Configured instructions\nClient instructions");
    });

    it("finds the prompt request when a title request arrives first", () => {
        const title = {input: [
            message("developer", "Title instructions"),
            message("user", "Generate a title for:\nCheck configured baseline"),
        ]};
        const prompt = {input: [
            message("developer", "Configured instructions"),
            message("user", "Check configured baseline"),
        ]};
        const found = findPromptRequest([title, prompt], "Check configured baseline");
        expect(found).toBe(prompt);
        expect(developerText(found)).toBe("Configured instructions");
    });

    it("does not mistake developer text or a title's quoted prompt for the user message", () => {
        expect(findPromptRequest([
            {input: [message("developer", "Check configured baseline")]},
            {input: [message("user", "Title for: Check configured baseline")]},
        ], "Check configured baseline")).toBeUndefined();
    });
});
