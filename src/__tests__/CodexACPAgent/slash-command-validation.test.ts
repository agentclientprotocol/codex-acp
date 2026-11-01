import {describe, expect, it, vi} from "vitest";
import {connectSession, itemCompleted, turnCompleted, userMessageItem, type PromptSession} from "./v2-prompt-harness";
import {isRecord} from "../../permissions/json";

function commandLists(h: PromptSession): Array<Array<{name: string; description: string}>> {
    return h.wireMessages.flatMap(frame => {
        let commands: unknown;
        if ("result" in frame && isRecord(frame.result)) commands = frame.result["availableCommands"];
        if ("method" in frame && frame.method === "session/update" && isRecord(frame.params)
            && isRecord(frame.params["update"])) commands = frame.params["update"]["availableCommands"];
        return Array.isArray(commands) ? [commands] : [];
    });
}

describe.each([1, 2] as const)("ACP v%s slash command names", version => {
    it("filters whitespace names and keeps one skill per name across roots", async () => {
        const skills = (names: string[], description: string) => names.map(name => ({
            name, description, shortDescription: null, path: `/workspace/${name}/SKILL.md`,
            scope: "project", enabled: true, pluginId: null,
        }));
        const h = await connectSession(version, {
            codexResponses: {"skills/list": async () => ({data: [
                {cwd: "/workspace", errors: [], skills: skills(["plan", "deploy", "deploy", "", "bad name", "bad\tname", "bad\nname", "bad\u00a0name"], "first")},
                {cwd: "/other", errors: [], skills: skills(["deploy", "build"], "second")},
            ]})},
        });
        try {
            await vi.waitFor(() => expect(commandLists(h).length).toBeGreaterThan(0));
            const commands = commandLists(h).at(-1)!;
            const names = commands.map(command => command.name);
            expect(names.filter(name => name.startsWith("$"))).toEqual(["$plan", "$deploy", "$build"]);
            expect(names).toContain("plan");
            expect(new Set(names).size).toBe(names.length);
            expect(commands.find(command => command.name === "$deploy")?.description).toBe("first");
        } finally {
            h.connection.close();
        }
    });

    it("handles a command in the first text block after an image", async () => {
        const h = await connectSession(version);
        try {
            const result = await h.sendPrompt([
                {type: "image", mimeType: "image/png", data: "aGVsbG8="},
                {type: "text", text: "/status"},
            ]);
            expect(result).toBeDefined();
            expect(h.turnStartParams).toEqual([]);
        } finally {
            h.connection.close();
        }
    });

    it.each(["/status-extra", "/STATUS", "/ status", " /status", "hello /status"])("passes %j to Codex as an ordinary prompt", async text => {
        const h = await connectSession(version);
        try {
            const response = h.sendPrompt([{type: "text", text}]);
            await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
            expect(h.turnStartParams[0]!["input"]).toEqual(expect.arrayContaining([
                expect.objectContaining({type: "text", text}),
            ]));
            const id = h.turnStartParams[0]!["clientUserMessageId"];
            h.emit(itemCompleted(userMessageItem(typeof id === "string" ? id : null, text)));
            h.emit(turnCompleted());
            await response;
            await h.promptRunFinished();
        } finally {
            h.connection.close();
        }
    });

    it("does not skip an earlier text block to find a command", async () => {
        const h = await connectSession(version);
        try {
            const response = h.sendPrompt([{type: "text", text: "Question"}, {type: "text", text: "/status"}]);
            await vi.waitFor(() => expect(h.turnStartParams).toHaveLength(1));
            const id = h.turnStartParams[0]!["clientUserMessageId"];
            h.emit(itemCompleted(userMessageItem(typeof id === "string" ? id : null, "Question")));
            h.emit(turnCompleted());
            await response;
            await h.promptRunFinished();
        } finally {
            h.connection.close();
        }
    });
});
