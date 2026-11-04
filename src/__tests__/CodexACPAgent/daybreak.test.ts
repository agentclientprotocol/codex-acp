import {describe, expect, it, vi} from "vitest";
import {ModelId} from "../../ModelId";
import {daybreakAccessProgram} from "../../Daybreak";
import {createTestModel} from "../acp-test-utils";
import {connectSession, sessionId, turnStarted, turnCompleted, itemStarted, userMessageItem} from "./v2-prompt-harness";

const model = createTestModel({availableAccessPrograms: {cyber: ["standard", "daybreakBlue"]}});

describe("Daybreak access-program selection", () => {
    it.each([
        {enabled: undefined, programs: [], expected: undefined},
        {enabled: false, programs: [], expected: "standard"},
        {enabled: true, programs: ["daybreakBlue" as const], expected: "daybreakBlue"},
        {enabled: true, programs: ["daybreakBlue" as const, "daybreakRed" as const], expected: "daybreakRed"},
    ])("selects $expected with enabled=$enabled", ({enabled, programs, expected}) => {
        expect(daybreakAccessProgram(enabled, createTestModel({availableAccessPrograms: {cyber: programs}}))).toBe(expected);
    });

    it("rejects enabling Daybreak without advertised access", () => {
        expect(() => daybreakAccessProgram(true, createTestModel({availableAccessPrograms: null})))
            .toThrow("Daybreak is unavailable");
    });
});

describe.each([1, 2] as const)("ACP v%s Daybreak command", version => {
    it.each([true, false])("advertises Daybreak only when access is available (eligible: %s)", async eligible => {
        const h = await connectSession(version, {codexResponses: {
            "model/list": async () => ({data: [createTestModel({id: "gpt-5", availableAccessPrograms: eligible ? model.availableAccessPrograms : null})], nextCursor: null}),
        }});
        try {
            const commandNames = h.wireMessages.flatMap(frame => {
                if ("result" in frame) {
                    return ((frame.result as {availableCommands?: Array<{name: string}>})?.availableCommands ?? []).map(command => command.name);
                }
                if ("method" in frame && frame.method === "session/update") {
                    const update = (frame.params as {update: {availableCommands?: Array<{name: string}>}}).update;
                    return (update.availableCommands ?? []).map(command => command.name);
                }
                return [];
            });
            expect(commandNames.includes("daybreak")).toBe(eligible);
        } finally {
            h.connection.close();
        }
    });

    it("saves toggles without starting a model turn", async () => {
        const h = await connectSession(version);
        try {
            const state = h.agent.getSessionState(sessionId);
            state.availableModels = [createTestModel({...model, id: ModelId.fromString(state.currentModelId).model})];
            const writes: unknown[] = [];
            h.setCodexResponse("thread/metadata/update", async params => {writes.push(params); return {};});
            for (const [index, enabled] of [true, false].entries()) {
                await h.sendPrompt([{type: "text", text: "/daybreak"}]);
                await h.promptRunFinished(index);
                expect(state.daybreakEnabled).toBe(enabled);
            }
            expect(writes).toEqual([
                {threadId: sessionId, daybreakEnabled: true},
                {threadId: sessionId, daybreakEnabled: false},
            ]);
            expect(h.turnStartParams).toEqual([]);
        } finally {
            h.connection.close();
        }
    });

    it.each([true, false])("sends the saved Daybreak choice to the next turn (enabled: %s)", async enabled => {
        const h = await connectSession(version);
        try {
            const state = h.agent.getSessionState(sessionId);
            state.daybreakEnabled = enabled;
            state.availableModels = [createTestModel({...model, id: ModelId.fromString(state.currentModelId).model})];
            const response = h.sendPrompt([{type: "text", text: "Hello"}]);
            await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
            const params = h.turnStartParams[0]!;
            expect(params["cyberAccessProgram"]).toBe(enabled ? "daybreakBlue" : "standard");
            h.emit(turnStarted());
            h.emit(itemStarted(userMessageItem(typeof params["clientUserMessageId"] === "string" ? params["clientUserMessageId"] : null)));
            h.emit(turnCompleted());
            await response;
            await h.promptRunFinished();
        } finally {
            h.connection.close();
        }
    });

    it("keeps the previous choice when saving fails", async () => {
        const h = await connectSession(version);
        try {
            const state = h.agent.getSessionState(sessionId);
            state.daybreakEnabled = true;
            h.setCodexResponse("thread/metadata/update", async () => {throw new Error("Cannot save Daybreak");});
            await expect(h.agent.prompt({sessionId, prompt: [{type: "text", text: "/daybreak"}]}))
                .rejects.toThrow("Cannot save Daybreak");
            expect(state.daybreakEnabled).toBe(true);
        } finally {
            h.connection.close();
        }
    });
});
