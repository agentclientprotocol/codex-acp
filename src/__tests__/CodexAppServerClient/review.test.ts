import { describe, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node";
import { CodexAppServerClient } from "../../CodexAppServerClient";
import type { ServerNotification } from "../../app-server";

describe("CodexAppServerClient review support", () => {
    function createClient(
        sendRequest: (request: unknown) => Promise<unknown>
    ): { client: CodexAppServerClient; sendNotification: (notification: ServerNotification) => void } {
        let unhandledNotificationHandler: ((notification: ServerNotification) => void) | null = null;
        const connection = {
            sendRequest: vi.fn(sendRequest),
            onUnhandledNotification: vi.fn((handler: (notification: ServerNotification) => void) => {
                unhandledNotificationHandler = handler;
            }),
            onRequest: vi.fn(),
        } as unknown as MessageConnection;

        return {
            client: new CodexAppServerClient(connection),
            sendNotification(notification: ServerNotification): void {
                if (!unhandledNotificationHandler) {
                    throw new Error("No notification handler registered");
                }
                unhandledNotificationHandler(notification);
            },
        };
    }

    it("sends review/start with typed params", async () => {
        const sendRequest = vi.fn().mockResolvedValue({
            turn: {
                id: "review-turn",
                items: [],
                itemsView: "full",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
            reviewThreadId: "session-id",
        });
        const { client } = createClient(sendRequest);

        await client.reviewStart({
            threadId: "session-id",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
        });

        expect(sendRequest).toHaveBeenCalledWith("review/start", {
            threadId: "session-id",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
        });
    });

    it("returns an early review completion observed before review/start resolves", async () => {
        let fixture!: ReturnType<typeof createClient>;
        const earlyCompletion: ServerNotification = {
            method: "turn/completed",
            params: {
                threadId: "session-id",
                turn: {
                    id: "review-turn",
                    items: [],
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            },
        };

        fixture = createClient(async () => {
            fixture.sendNotification(earlyCompletion);
            return {
                turn: {
                    id: "review-turn",
                    items: [],
                    itemsView: "full",
                    status: "inProgress",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
                reviewThreadId: "session-id",
            };
        });

        const completed = await fixture.client.runReview({
            threadId: "session-id",
            target: { type: "uncommittedChanges" },
            delivery: "inline",
        });

        expect(completed).toEqual(earlyCompletion.params);
    });

    it("rejects detached review delivery without starting review", async () => {
        const sendRequest = vi.fn();
        const { client } = createClient(sendRequest);

        await expect(client.runReview({
            threadId: "session-id",
            target: { type: "uncommittedChanges" },
            delivery: "detached",
        })).rejects.toThrow("runReview only supports inline review delivery");

        expect(sendRequest).not.toHaveBeenCalled();
    });
});
