import {describe, expect, it, vi} from "vitest";
import {PROTOCOL_VERSION} from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from "../acp-test-utils";
import {
    RATE_LIMITS_META_KEY,
    RATE_LIMITS_UPDATE_METHOD,
    type RateLimits,
} from "../../RateLimitsMeta";
import {CodexEventHandler} from "../../CodexEventHandler";
import type {AcpClientConnection} from "../../ACPSessionConnection";
import type {AccountRateLimitsUpdatedNotification, RateLimitSnapshot} from "../../app-server/v2";

const FIVE_HOURS_RESET = 1789511479;
const WEEK_RESET = 1789841013;

/** A complete app-server snapshot with headroom in both windows. */
function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
    return {
        limitId: "codex",
        limitName: "Codex",
        normalModelSlug: null,
        primary: {usedPercent: 41, windowDurationMins: 300, resetsAt: FIVE_HOURS_RESET},
        secondary: {usedPercent: 12, windowDurationMins: 10080, resetsAt: WEEK_RESET},
        credits: {hasCredits: true, unlimited: false, balance: "12.50"},
        individualLimit: {limit: "25000", used: "8000", remainingPercent: 72, resetsAt: WEEK_RESET},
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null,
        ...overrides,
    };
}

/** The rolling update that spends the 5-hour window: windows present, every
 *  piece of account metadata absent — the shape the sparse contract allows. */
const SPENT_SPARSE: Partial<RateLimitSnapshot> = {
    limitName: null,
    primary: {usedPercent: 100, windowDurationMins: 300, resetsAt: FIVE_HOURS_RESET},
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: "rate_limit_reached",
};

function notification(s: RateLimitSnapshot): AccountRateLimitsUpdatedNotification {
    return {rateLimits: s};
}

/** What the connection was told, in order. */
function pushes(fixture: CodexMockTestFixture): RateLimits[] {
    return fixture.getAcpConnectionEvents([])
        .filter((event: MethodCallEvent) => event.method === "notify" && event.args[0] === RATE_LIMITS_UPDATE_METHOD)
        .map((event: MethodCallEvent) => (event.args[1] as {rateLimits: RateLimits}).rateLimits);
}

async function awaitPushes(fixture: CodexMockTestFixture, count: number): Promise<RateLimits[]> {
    await vi.waitFor(() => expect(pushes(fixture)).toHaveLength(count));
    return pushes(fixture);
}

/** Lets every already-scheduled callback run, so "nothing more was pushed" is a
 *  verdict and not a race. */
async function drainScheduledWork(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

const HEADROOM: RateLimits = {
    limitId: "codex",
    limitName: "Codex",
    normalModelSlug: null,
    primary: {usedPercent: 41, windowDurationMins: 300, resetsAt: FIVE_HOURS_RESET},
    secondary: {usedPercent: 12, windowDurationMins: 10080, resetsAt: WEEK_RESET},
    rateLimitReachedType: null,
    planType: "plus",
};

const SPENT: RateLimits = {
    ...HEADROOM,
    primary: {usedPercent: 100, windowDurationMins: 300, resetsAt: FIVE_HOURS_RESET},
    rateLimitReachedType: "rate_limit_reached",
};

describe("rateLimits extension", () => {
    describe("capability marker", () => {
        it("is advertised in the initialize response, without a payload", async () => {
            const fixture = createCodexMockTestFixture();

            const response = await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});

            expect(response.agentCapabilities?._meta?.[RATE_LIMITS_META_KEY]).toEqual({});
            expect(response._meta?.[RATE_LIMITS_META_KEY]).toBeUndefined();
        });
    });

    describe("_account/rate_limits_update notification", () => {
        it("pushes the usage windows and leaves the billing fields behind", async () => {
            const fixture = createCodexMockTestFixture();

            fixture.getCodexAcpAgent().handleRateLimitsUpdated(notification(snapshot()));

            // Credits, the individual spend limit and spend control are not usage
            // windows; the wire payload is exactly the documented subset.
            expect(await awaitPushes(fixture, 1)).toEqual([HEADROOM]);
        });

        it("is not sent again while the windows are unchanged", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();

            agent.handleRateLimitsUpdated(notification(snapshot()));
            await awaitPushes(fixture, 1);
            agent.handleRateLimitsUpdated(notification(snapshot()));
            // A billing-only change is not a usage-window change.
            agent.handleRateLimitsUpdated(notification(snapshot({credits: {hasCredits: false, unlimited: false, balance: "0"}})));
            await drainScheduledWork();

            expect(pushes(fixture)).toHaveLength(1);
        });

        it("merges a sparse update against the connection's baseline, keeping the name and plan", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();

            agent.handleRateLimitsUpdated(notification(snapshot()));
            await awaitPushes(fixture, 1);
            agent.handleRateLimitsUpdated(notification(snapshot(SPENT_SPARSE)));

            // `limitName` and `planType` were absent from the update and must not
            // drop to null on the wire; the windows are the update's.
            const [, spent] = await awaitPushes(fixture, 2);
            expect(spent).toEqual(SPENT);
        });

        it("does not push a sparse update that adds nothing", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();

            agent.handleRateLimitsUpdated(notification(snapshot()));
            await awaitPushes(fixture, 1);
            // Same windows, every metadata field absent: after the merge this is
            // the previous payload again.
            agent.handleRateLimitsUpdated(notification(snapshot({
                limitName: null,
                credits: null,
                individualLimit: null,
                spendControlReached: null,
                planType: null,
            })));
            await drainScheduledWork();

            expect(pushes(fixture)).toEqual([HEADROOM]);
        });

        it("reports a window the backend left unspecified as null, not as a guess", async () => {
            const fixture = createCodexMockTestFixture();

            fixture.getCodexAcpAgent().handleRateLimitsUpdated(notification(snapshot({
                limitName: null,
                primary: {usedPercent: 3, windowDurationMins: null, resetsAt: null},
                secondary: null,
                planType: null,
            })));

            expect(await awaitPushes(fixture, 1)).toEqual([{
                limitId: "codex",
                limitName: null,
                normalModelSlug: null,
                primary: {usedPercent: 3, windowDurationMins: null, resetsAt: null},
                secondary: null,
                rateLimitReachedType: null,
                planType: null,
            }]);
        });

        it("tracks each limitId on its own", async () => {
            const fixture = createCodexMockTestFixture();
            const agent = fixture.getCodexAcpAgent();

            agent.handleRateLimitsUpdated(notification(snapshot()));
            agent.handleRateLimitsUpdated(notification(snapshot({
                limitId: "fast",
                limitName: "Fast",
                primary: {usedPercent: 80, windowDurationMins: 1440, resetsAt: FIVE_HOURS_RESET},
                secondary: null,
            })));
            await awaitPushes(fixture, 2);
            // A repeat of either limit is a duplicate of THAT limit, not a change
            // relative to the other one.
            agent.handleRateLimitsUpdated(notification(snapshot()));
            await drainScheduledWork();

            const all = pushes(fixture);
            expect(all).toHaveLength(2);
            expect(all.map((limit) => limit.limitId)).toEqual(["codex", "fast"]);
        });
    });

    describe("account/rateLimits/updated through the app-server connection", () => {
        const method = "account/rateLimits/updated" as const;

        it("carries the complete picture through a sparse update", async () => {
            const fixture = createCodexMockTestFixture();

            fixture.sendServerNotification({method, params: notification(snapshot())});
            await awaitPushes(fixture, 1);
            fixture.sendServerNotification({method, params: notification(snapshot(SPENT_SPARSE))});

            expect(await awaitPushes(fixture, 2)).toEqual([HEADROOM, SPENT]);
        });

        it("pushes once however many sessions the notification fans out to", async () => {
            const fixture = createCodexMockTestFixture();
            const appServer = fixture.getCodexAppServerClient();
            // Two open sessions: codex delivers a thread-less notification to
            // each of their handlers, but the push is fed at the connection.
            appServer.onServerNotification("session-a", () => {});
            appServer.onServerNotification("session-b", () => {});

            fixture.sendServerNotification({method, params: notification(snapshot())});
            fixture.sendServerNotification({method, params: notification(snapshot())});
            await drainScheduledWork();

            expect(pushes(fixture)).toEqual([HEADROOM]);
        });

        it("names the model a model-specific limit belongs to", async () => {
            const fixture = createCodexMockTestFixture();

            fixture.sendServerNotification({method, params: notification(snapshot({
                limitId: "fast",
                limitName: "Fast",
                normalModelSlug: "gpt-5.6-sol",
                secondary: null,
            }))});

            const [fast] = await awaitPushes(fixture, 1);
            expect(fast!.limitId).toBe("fast");
            expect(fast!.normalModelSlug).toBe("gpt-5.6-sol");
        });

        it("forgets the windows on logout so the next account's first update is pushed", async () => {
            const fixture = createCodexMockTestFixture();
            const client = fixture.getCodexAcpClient();
            vi.spyOn(client, "logout").mockResolvedValue(undefined);
            vi.spyOn(client, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: true});

            fixture.sendServerNotification({method, params: notification(snapshot())});
            await awaitPushes(fixture, 1);
            await fixture.getCodexAcpAgent().logout({});
            // The new account happens to report the same values: still news.
            fixture.sendServerNotification({method, params: notification(snapshot())});

            expect(await awaitPushes(fixture, 2)).toEqual([HEADROOM, HEADROOM]);
        });

        it("still merges per session for /status", async () => {
            const fixture = createCodexMockTestFixture();
            const sessionState = createTestSessionState();
            const handler = new CodexEventHandler(
                {notify: vi.fn(async () => {}), request: vi.fn()} as unknown as AcpClientConnection,
                sessionState,
                false,
                false,
                "epoch",
            );

            await handler.handleNotification({method, params: notification(snapshot())});
            await handler.handleNotification({method, params: notification(snapshot(SPENT_SPARSE))});

            const entry = sessionState.rateLimits?.get("codex");
            expect(entry?.limitName).toBe("Codex");
            expect(entry?.snapshot.planType).toBe("plus");
            expect(entry?.snapshot.primary?.usedPercent).toBe(100);
            // And nothing was pushed: the per-session merge is not the feed.
            expect(pushes(fixture)).toEqual([]);
        });
    });
});
