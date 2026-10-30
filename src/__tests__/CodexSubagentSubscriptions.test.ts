import {describe, expect, it, vi} from "vitest";
import type {CodexAppServerClient} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {CodexSubagentSubscriptions} from "../subagents/CodexSubagentSubscriptions";
import {createThread, itemStarted} from "./CodexACPAgent/v2-prompt-harness";

describe("Subagent cleanup ownership", () => {
    it("returns only loaded descendants with a verified chain to the root", async () => {
        const handlers = new Map<string, (event: ServerNotification) => void>();
        const metadata: Record<string, {parent: string; loaded?: boolean; id?: string}> = {
            child: {parent: "root"},
            nested: {parent: "child"},
            foreign: {parent: "another-root"},
            orphan: {parent: "foreign"},
            unloaded: {parent: "root", loaded: false},
            mismatch: {parent: "root", id: "wrong"},
        };
        const client = {
            onServerNotification: (id: string, handler: (event: ServerNotification) => void) => { handlers.set(id, handler); },
            onApprovalRequest: vi.fn(),
            onElicitationRequest: vi.fn(),
            threadRead: vi.fn(async ({threadId}: {threadId: string}) => {
                const entry = metadata[threadId]!;
                return {thread: {...createThread(), id: entry.id ?? threadId, parentThreadId: entry.parent,
                    status: {type: entry.loaded === false ? "notLoaded" : "idle"}}};
            }),
        } as unknown as CodexAppServerClient;
        const subscriptions = new CodexSubagentSubscriptions(client);
        subscriptions.subscribe({
            rootSessionId: "root", supportsSubagents: false, dispatch: vi.fn(), enqueueInteraction: vi.fn(),
            approvalHandler: {} as never, elicitationHandler: {} as never,
            waitForRootNotifications: async () => {}, waitForChildSession: async () => null,
        });
        for (const id of Object.keys(metadata)) {
            const event = itemStarted({type: "subAgentActivity", id: `activity-${id}`, model: null, reasoningEffort: null,
                agentThreadId: id, agentPath: `/root/${id}`, kind: "started"});
            handlers.get("root")!({...event, params: {...event.params, threadId: "root"}} as ServerNotification);
        }
        for (const id of Object.keys(metadata)) await subscriptions.readChildThread(id);
        vi.mocked(client.threadRead).mockClear();
        expect(subscriptions.verifiedChildThreadIds("root")).toEqual(["child", "nested"]);
        expect(subscriptions.verifiedChildThreadIds("unknown")).toEqual([]);
        expect(client.threadRead).not.toHaveBeenCalled();
    });
});
