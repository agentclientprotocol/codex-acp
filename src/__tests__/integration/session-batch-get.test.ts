import {once} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {expect, it} from "vitest";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {createBaseTestFixture, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration} from "./integration-fixture";

/** Real app-server metadata reads only; no model requests or session turns. */
describeIntegration("integration: session batch metadata", () => {
    it("returns older sessions and the selected stored copies using the same rows as the unscoped list", async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-batch-metadata-"));
        writeCodexHomeConfig(home);
        const old = "00000000-0000-4000-8000-000000000001";
        const archived = "00000000-0000-4000-8000-000000000002";
        const corrupt = "00000000-0000-4000-8000-000000000003";
        const absent = "00000000-0000-4000-8000-000000000004";
        function rollout(id: string, title: string, date: string, isArchived = false): string {
            const dir = isArchived ? path.join(home, "archived_sessions") : path.join(home, "sessions", "2026", "01", "01");
            fs.mkdirSync(dir, {recursive: true});
            const file = path.join(dir, `rollout-${date.replace(/:/g, "-")}-${id}.jsonl`);
            const timestamp = `${date}Z`;
            fs.writeFileSync(file, [
                {timestamp, type: "session_meta", payload: {
                    id, timestamp, cwd: home, originator: "codex_cli_rs", cli_version: "0.164.0", source: "cli", model_provider: "openai",
                }},
                {timestamp, type: "event_msg", payload: {type: "user_message", message: title, images: [], local_images: [], text_elements: []}},
            ].map(line => JSON.stringify(line)).join("\n") + "\n");
            fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
            return file;
        }
        rollout(old, "Older stored copy", "2026-01-01T00:00:00");
        const selected = rollout(old, "Selected current copy", "2026-01-01T01:00:00");
        // A mature legacy rollout's mtime differs from its creation/session_meta timestamp.
        fs.utimesSync(selected, new Date("2026-01-15T00:00:00Z"), new Date("2026-01-15T00:00:00Z"));
        rollout(archived, "Archived session", "2026-01-01T02:00:00", true);
        fs.writeFileSync(rollout(corrupt, "Unreadable", "2026-01-01T03:00:00"), "invalid json\n");
        for (let index = 0; index < 60; index++) {
            rollout(`00000000-0000-4000-8000-${(100 + index).toString(16).padStart(12, "0")}`, `Recent ${index}`, "2026-02-01T00:00:00");
        }
        const codex = startCodexConnection(path.resolve("node_modules/.bin/codex"), {...process.env, CODEX_HOME: home});
        const fixture = createBaseTestFixture({connection: codex.connection, getExitCode: () => codex.process.exitCode});
        const index = fixture.getCodexAcpAgent().sessionIndex;
        try {
            await fixture.getCodexAcpClient().initialize({});
            index.configure({_meta: {jetbrains: {air: {version: 1, capabilities: ["sessionIndex"]}}}});
            // Populate the backend index as its normal discovery does; batchGet itself never lists.
            await fixture.getCodexAppServerClient().threadList({limit: 100, sourceKinds: [], modelProviders: []});
            await fixture.getCodexAppServerClient().threadList({limit: 100, archived: true, sourceKinds: [], modelProviders: []});
            const recent = await index.list({});
            expect(recent.sessions).toHaveLength(50);
            expect(recent.sessions.map(row => row.sessionId)).not.toContain(old);
            fixture.clearCodexConnectionDump();
            const result = await index.batchGet({sessionIds: [archived, corrupt, old, absent, "not-a-uuid"]});
            expect(result.sessions.map(row => row.sessionId)).toEqual([archived, old]);
            expect(result.sessions[1]!.title).toBe("Selected current copy");
            const requests = fixture.getCodexConnectionEvents([]).filter(event => event.eventType === "request");
            expect(requests).toEqual([archived, corrupt, old, absent, "not-a-uuid"].map(threadId => ({
                eventType: "request", method: "thread/read", params: {threadId, includeTurns: false},
            })));
            const all = await index.list({_meta: {jetbrains: {air: {list: {limit: 100, archived: "all"}}}}});
            const withoutUpdatedAt = ({updatedAt: _updatedAt, ...row}: (typeof result.sessions)[number]) => row;
            expect(result.sessions.map(withoutUpdatedAt)).toEqual([archived, old].map(id => withoutUpdatedAt(all.sessions.find(row => row.sessionId === id)!)));
            // The supported native read has creation-based updatedAt for legacy rollouts; list uses its stored update.
            expect(result.sessions[1]!.updatedAt).toBe("2026-01-01T01:00:00.000Z");
            expect(all.sessions.find(row => row.sessionId === old)!.updatedAt).toBe("2026-01-15T00:00:00.000Z");
        } finally {
            index.dispose();
            codex.process.kill();
            await once(codex.process, "exit");
            fs.rmSync(home, {recursive: true, force: true});
        }
    });
});
