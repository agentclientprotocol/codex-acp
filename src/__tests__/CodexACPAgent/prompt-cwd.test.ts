import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {connectSession, sessionId, turnStarted, turnCompleted, itemCompleted, userMessageItem, settle} from "./v2-prompt-harness";
import type {PromptSession} from "./v2-prompt-harness";

const prompt = (text = "Hello") => [{type: "text", text}];

describe.each([1, 2] as const)("ACP v%s prompt working directory", version => {
    let root: string;
    let directory: string;
    let closeClient: (() => void) | null = null;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-prompt-cwd-"));
        directory = fs.mkdtempSync(path.join(root, "project-"));
        fs.writeFileSync(path.join(root, "notes.txt"), "not a directory");
    });

    afterEach(() => {
        closeClient?.();
        closeClient = null;
        fs.rmSync(root, {recursive: true, force: true});
    });

    /** Drives the turn the harness just started to completion and answers the prompt. */
    async function completeTurn(client: PromptSession, index: number, id: string) {
        const clientUserMessageId = client.turnStartParams[index]!["clientUserMessageId"] as string;
        client.emit(turnStarted(id));
        client.emit(itemCompleted(userMessageItem(clientUserMessageId), id));
        client.emit(turnCompleted(id));
    }

    it("forwards _meta.cwd to turn/start and follows it on subsequent turns", async () => {
        const client = await connectSession(version);
        closeClient = () => client.connection.close();

        const first = client.request("session/prompt", {sessionId, prompt: prompt(), _meta: {cwd: directory}});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        expect(client.turnStartParams[0]!["cwd"]).toBe(directory);
        await completeTurn(client, 0, "turn-1");
        await expect(first).resolves.toBeDefined();
        await client.promptRunFinished();
        await settle();

        // The override applies to subsequent turns, so the next prompt without _meta stays there.
        const second = client.request("session/prompt", {sessionId, prompt: prompt("Again")});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(2));
        expect(client.turnStartParams[1]!["cwd"]).toBe(directory);
        await completeTurn(client, 1, "turn-2");
        await expect(second).resolves.toBeDefined();
        await client.promptRunFinished(1);
        await settle();
    });

    it("leaves the session directory alone when the prompt carries no _meta.cwd", async () => {
        const client = await connectSession(version);
        closeClient = () => client.connection.close();

        const response = client.request("session/prompt", {sessionId, prompt: prompt(), _meta: {unrelated: true}});
        await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
        expect(client.turnStartParams[0]!["cwd"]).toBe("/workspace");
        await completeTurn(client, 0, "turn-1");
        await expect(response).resolves.toBeDefined();
        await client.promptRunFinished();
        await settle();
    });

    it.each([
        ["a relative path", () => "relative"],
        ["a nonexistent directory", () => path.join(root, "missing")],
        ["a file", () => path.join(root, "notes.txt")],
        ["a non-string value", () => 42],
        ["an empty string", () => "   "],
    ])("rejects %s as _meta.cwd before dispatching the prompt", async (_label, value) => {
        const client = await connectSession(version);
        closeClient = () => client.connection.close();

        await expect(client.request("session/prompt", {sessionId, prompt: prompt(), _meta: {cwd: value()}}))
            .rejects.toMatchObject({code: -32602});
        await client.promptRunFinished();
        await settle();
        expect(client.turnStartParams).toHaveLength(0);
    });
});
