import {afterEach, expect, it} from "vitest";
import {
    createAuthenticatedFixture,
    describeE2E,
    type SpawnedAgentFixture,
} from "./acp-e2e-test-utils";

describeE2E("E2E session fork tests", () => {
    let fixture: SpawnedAgentFixture | null = null;

    afterEach(async () => {
        await fixture?.dispose();
        fixture = null;
    });

    it("forks persisted history and keeps source and fork independent", async () => {
        fixture = await createAuthenticatedFixture();
        const sourceSessionId = (await fixture.createSession()).sessionId;
        const rootToken = `ROOT_${crypto.randomUUID()}`;
        const forkLabel = `FORK_${crypto.randomUUID()}`;

        await fixture.expectPromptText(
            sourceSessionId,
            `Remember ROOT_TOKEN=${rootToken} and BRANCH_LABEL=BASE. Reply with exactly SEEDED.`,
            (text) => expect(text).toContain("SEEDED"),
        );

        fixture = await fixture.restart();
        const forkResponse = await fixture.connection.unstable_forkSession({
            sessionId: sourceSessionId,
            cwd: fixture.workspaceDir,
            mcpServers: [],
        });
        expect(forkResponse.sessionId).not.toBe(sourceSessionId);

        await fixture.expectPromptText(
            forkResponse.sessionId,
            `Change only BRANCH_LABEL to ${forkLabel}. Reply with exactly ROOT_TOKEN=${rootToken};BRANCH_LABEL=${forkLabel}.`,
            (text) => {
                expect(text).toContain(`ROOT_TOKEN=${rootToken}`);
                expect(text).toContain(`BRANCH_LABEL=${forkLabel}`);
            },
        );

        await fixture.connection.resumeSession({
            sessionId: sourceSessionId,
            cwd: fixture.workspaceDir,
            mcpServers: [],
        });
        await fixture.expectPromptText(
            sourceSessionId,
            `Reply with exactly ROOT_TOKEN=${rootToken};BRANCH_LABEL=BASE.`,
            (text) => {
                expect(text).toContain(`ROOT_TOKEN=${rootToken}`);
                expect(text).toContain("BRANCH_LABEL=BASE");
                expect(text).not.toContain(`BRANCH_LABEL=${forkLabel}`);
            },
        );
    });

    it("forks through a published message anchor and drops later turns", async () => {
        fixture = await createAuthenticatedFixture();
        const sourceSessionId = (await fixture.createSession()).sessionId;
        const rootToken = `ROOT_${crypto.randomUUID()}`;
        const laterToken = `LATER_${crypto.randomUUID()}`;

        await fixture.expectPromptText(
            sourceSessionId,
            `Remember ROOT_TOKEN=${rootToken}. Reply with exactly SEEDED.`,
            (text) => expect(text).toContain("SEEDED"),
        );
        const firstTurnMessageIds = fixture.readAgentMessageIds(sourceSessionId);
        expect(firstTurnMessageIds.length).toBeGreaterThan(0);
        const firstTurnMessageId = firstTurnMessageIds[firstTurnMessageIds.length - 1]!;

        await fixture.expectPromptText(
            sourceSessionId,
            `Remember LATER_TOKEN=${laterToken}. Reply with exactly EXTENDED.`,
            (text) => expect(text).toContain("EXTENDED"),
        );

        fixture = await fixture.restart();
        const forkResponse = await fixture.connection.unstable_forkSession({
            sessionId: sourceSessionId,
            cwd: fixture.workspaceDir,
            mcpServers: [],
            _meta: {
                sessionFork: {
                    messageId: firstTurnMessageId,
                },
            },
        });
        expect(forkResponse.sessionId).not.toBe(sourceSessionId);

        await fixture.expectPromptText(
            forkResponse.sessionId,
            "Reply with exactly ROOT_TOKEN=<value>;LATER_TOKEN=<value>, using UNKNOWN for any token that was never mentioned in this conversation.",
            (text) => {
                expect(text).toContain(`ROOT_TOKEN=${rootToken}`);
                expect(text).not.toContain(laterToken);
            },
        );
    });
});
