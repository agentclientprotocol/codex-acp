import {afterEach, describe, expect, it} from 'vitest';
import {connectSession, settle, type PromptSession, type TranscriptEntry} from './v2-prompt-harness';
import type * as acpV2 from '@agentclientprotocol/sdk/experimental/v2/unstable';
import type {ServerNotification} from '../../app-server';

/**
 * Codex reports every change under a skill root as `skills/changed`, naming nothing that changed. The adapter
 * lists the skills again and publishes the slash commands, so a skill that appears while a session is open - a
 * new file, a new symlink, a changed link target - becomes a command right away instead of only after the next
 * completed turn.
 */
describe('skills/changed republishes the available commands', () => {
    let closeClient: (() => void) | null = null;

    afterEach(() => {
        closeClient?.();
        closeClient = null;
    });

    const skillsChanged = (): ServerNotification =>
        ({method: "skills/changed", params: {}} as unknown as ServerNotification);

    const skills = (...names: string[]) => ({
        data: [{
            cwd: "/workspace",
            errors: [],
            skills: names.map(name => ({
                name,
                description: name,
                shortDescription: name,
                path: `/workspace/.agents/skills/${name}`,
                scope: "project" as const,
                enabled: true,
                pluginId: null,
            })),
        }],
    });

    const commandNames = (transcript: TranscriptEntry[]): string[][] =>
        transcript.flatMap(entry =>
            "sessionUpdate" in entry && entry.sessionUpdate.sessionUpdate === "available_commands_update"
                ? [(entry.sessionUpdate.availableCommands as acpV2.AvailableCommand[]).map(command => command.name)]
                : []);

    /** Waits out the publish the notification debounces, plus the wire round-trip behind it. */
    const settleSkillsPublish = async (client: PromptSession) => {
        await new Promise(resolve => setTimeout(resolve, 400));
        await settle();
    };

    it('publishes a skill that appeared before any turn has run', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        client.setCodexResponse("skills/list", async () => skills("deploy"));
        const start = client.transcript.length;

        client.emit(skillsChanged());
        await settleSkillsPublish(client);

        expect(commandNames(client.transcript.slice(start)).at(-1)).toContain("$deploy");
    });

    it('publishes once for a burst of changes, and nothing when the skills are the same', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        let listed = 0;
        client.setCodexResponse("skills/list", async () => {
            listed += 1;
            return skills("deploy");
        });

        client.emit(skillsChanged());
        client.emit(skillsChanged());
        client.emit(skillsChanged());
        await settleSkillsPublish(client);

        expect(listed).toBe(1);
        const start = client.transcript.length;

        // The same skills: the list is read again, but the client already has those commands.
        client.emit(skillsChanged());
        await settleSkillsPublish(client);

        expect(listed).toBe(2);
        expect(commandNames(client.transcript.slice(start))).toEqual([]);
    });

    it('keeps the newer list when a slower earlier publish answers last', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        let listed = 0;
        client.setCodexResponse("skills/list", async () => {
            listed += 1;
            if (listed === 1) {
                // The first list is answered long after the second one, and it carries the older skills.
                await new Promise(resolve => setTimeout(resolve, 1_000));
                return skills("build");
            }
            return skills("build", "deploy");
        });
        const start = client.transcript.length;

        client.emit(skillsChanged());
        await new Promise(resolve => setTimeout(resolve, 400));
        client.emit(skillsChanged());
        await new Promise(resolve => setTimeout(resolve, 1_500));
        await settle();

        expect(listed).toBe(2);
        expect(commandNames(client.transcript.slice(start)).at(-1)).toContain("$deploy");
    });

    it('publishes nothing for a session that closed before its change settled', async () => {
        const client = await connectSession();
        closeClient = () => client.connection.close();
        let listed = 0;
        client.setCodexResponse("skills/list", async () => {
            listed += 1;
            return skills("deploy");
        });
        const listedAtClose = () => listed;

        client.emit(skillsChanged());
        await client.request("session/close", {sessionId: "thread-1"});
        const before = listedAtClose();
        await settleSkillsPublish(client);

        expect(listed).toBe(before);
    });
});
