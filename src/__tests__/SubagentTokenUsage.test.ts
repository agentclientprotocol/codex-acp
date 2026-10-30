import {describe, expect, it} from "vitest";
import type {ServerNotification} from "../app-server";
import type {Thread, TokenUsageBreakdown} from "../app-server/v2";
import {SubagentTokenUsage} from "../SubagentTokenUsage";
import {toTokenCount, type TokenCount} from "../TokenCount";

const ROOT = "root";

function breakdown(totalTokens: number, cachedInputTokens = 0, outputTokens = 0): TokenUsageBreakdown {
    return {
        totalTokens,
        inputTokens: totalTokens - outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningOutputTokens: 0,
    };
}

function count(totalTokens: number, cachedInputTokens = 0, outputTokens = 0): TokenCount {
    return toTokenCount(breakdown(totalTokens, cachedInputTokens, outputTokens));
}

function usage(threadId: string, total: TokenUsageBreakdown, last: TokenUsageBreakdown = total): ServerNotification {
    return {
        method: "thread/tokenUsage/updated",
        params: {threadId, turnId: "turn", tokenUsage: {total, last, modelContextWindow: 200000}},
    };
}

function output(threadId: string): ServerNotification {
    return {
        method: "item/started",
        params: {threadId, turnId: "turn", startedAtMs: 0, item: {type: "reasoning", id: `${threadId}-reasoning`, summary: [], content: []}},
    };
}

function threadStarted(id: string, parentThreadId: string | null, model: string | null, forkedFromId: string | null = null): ServerNotification {
    return {method: "thread/started", params: {thread: {id, parentThreadId, model, forkedFromId} as Thread}};
}

function activity(agentThreadId: string, model: string | null): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId: ROOT,
            turnId: "turn",
            startedAtMs: 0,
            item: {type: "subAgentActivity", model, reasoningEffort: null, id: `activity-${agentThreadId}`, kind: "started", agentThreadId, agentPath: "/root/worker"},
        },
    };
}

function settings(threadId: string, model: string): ServerNotification {
    return {method: "thread/settings/updated", params: {threadId, threadSettings: {model}}} as ServerNotification;
}

function prompt(tracker: SubagentTokenUsage, notifications: ServerNotification[], rootUsage: TokenCount | null = null) {
    tracker.beginPrompt();
    for (const notification of notifications) tracker.observe(notification);
    return tracker.reportModelUsage("gpt-5.6-sol", rootUsage);
}

describe("SubagentTokenUsage", () => {
    it("reports the root usage alone when no subagent ran", () => {
        expect(prompt(new SubagentTokenUsage(ROOT), [], count(1000))).toEqual([{model: "gpt-5.6-sol", token_count: count(1000)}]);
        expect(prompt(new SubagentTokenUsage(ROOT), [])).toEqual([]);
    });

    it("sums the requests of each child and does not count a repeated total again", () => {
        const rows = prompt(new SubagentTokenUsage(ROOT), [
            threadStarted("a", ROOT, "gpt-5.6-luna"),
            usage("a", breakdown(1000, 0, 100)),
            usage("a", breakdown(1000, 0, 100)),
            usage("a", breakdown(2500, 800, 300), breakdown(1500, 800, 200)),
            threadStarted("b", ROOT, "gpt-5.6-terra"),
            usage("b", breakdown(700, 0, 70)),
        ], count(400));

        expect(rows).toEqual([
            {model: "gpt-5.6-sol", token_count: count(400)},
            {model: "gpt-5.6-luna", token_count: count(2500, 800, 300)},
            {model: "gpt-5.6-terra", token_count: count(700, 0, 70)},
        ]);
    });

    it("counts a child that Codex announces only by its activity item, as Codex 0.165 does", () => {
        const rows = prompt(new SubagentTokenUsage(ROOT), [
            activity("a", "gpt-5.6-luna"),
            output("a"),
            usage("a", breakdown(16511, 0, 50)),
            usage("a", breakdown(33057, 16000, 120), breakdown(16546, 16000, 70)),
        ], count(50621));

        expect(rows).toEqual([
            {model: "gpt-5.6-sol", token_count: count(50621)},
            {model: "gpt-5.6-luna", token_count: count(33057, 16000, 120)},
        ]);
    });

    it("leaves out the history of a forked child or one whose start is unknown", () => {
        const rows = prompt(new SubagentTokenUsage(ROOT), [
            threadStarted("forked", ROOT, "gpt-5.6-luna", "source"),
            usage("forked", breakdown(90000, 80000, 2000), breakdown(3000, 2000, 200)),
            output("forked"),
            usage("forked", breakdown(94000, 83000, 2300), breakdown(4000, 3000, 300)),
            usage("unknown", breakdown(50000, 40000, 1000)),
            output("unknown"),
            usage("unknown", breakdown(51000, 40500, 1100), breakdown(1000, 500, 100)),
        ]);

        expect(rows).toEqual([
            {model: "gpt-5.6-luna", token_count: count(4000, 3000, 300)},
            {model: "gpt-5.6-sol", token_count: count(1000, 500, 100)},
        ]);
    });

    it("adds the usage of a child that worked on after a prompt to the next one", () => {
        const tracker = new SubagentTokenUsage(ROOT);
        expect(prompt(tracker, [threadStarted("a", ROOT, "gpt-5.6-luna"), usage("a", breakdown(1000))]))
            .toEqual([{model: "gpt-5.6-luna", token_count: count(1000)}]);

        tracker.observe(usage("a", breakdown(1600), breakdown(600)));

        expect(prompt(tracker, [usage("a", breakdown(2000), breakdown(400))]))
            .toEqual([{model: "gpt-5.6-luna", token_count: count(1000)}]);
        expect(prompt(tracker, [])).toEqual([]);
    });

    it("reports the same rows when a prompt builds its quota twice", () => {
        const tracker = new SubagentTokenUsage(ROOT);
        prompt(tracker, [threadStarted("a", ROOT, null), usage("a", breakdown(1000))]);
        tracker.beginPrompt();
        tracker.observe(usage("a", breakdown(1500), breakdown(500)));

        expect(tracker.reportModelUsage("gpt-5.6-sol", null)).toEqual([{model: "gpt-5.6-sol", token_count: count(500)}]);
        expect(tracker.reportModelUsage("gpt-5.6-sol", null)).toEqual([{model: "gpt-5.6-sol", token_count: count(500)}]);
    });

    it("counts the children of its children, and no thread of another session", () => {
        const rows = prompt(new SubagentTokenUsage(ROOT), [
            threadStarted("a", ROOT, "gpt-5.6-luna"),
            threadStarted("a1", "a", "gpt-5.6-terra"),
            threadStarted("other-root", null, "gpt-5.6-sol"),
            threadStarted("other-child", "other-root", "gpt-5.6-luna"),
            usage("a1", breakdown(300)),
            usage(ROOT, breakdown(9000)),
        ]);

        expect(rows).toEqual([{model: "gpt-5.6-terra", token_count: count(300)}]);
    });

    it("takes the model of a settings change over the model at creation", () => {
        const rows = prompt(new SubagentTokenUsage(ROOT), [
            threadStarted("a", ROOT, "gpt-5.6-sol"),
            activity("a", "gpt-5.6-luna"),
            usage("a", breakdown(1000)),
            settings("a", "gpt-5.6-terra"),
        ]);

        expect(rows).toEqual([{model: "gpt-5.6-terra", token_count: count(1000)}]);
    });
});
