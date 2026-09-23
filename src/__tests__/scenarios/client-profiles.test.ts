import type * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {beforeAll, describe, expect, it} from "vitest";
import packageJson from "../../../package.json";
import {schemaErrors} from "./acp-schema";
import {airOnlyKeys, expectedFromBaseline, lines, mergedReports, metaObjects} from "./baseline";
import {
    AIR_CAPABILITY_NAMES,
    fromJsonLines,
    normalize,
    PROFILES,
    type ProfileName,
    type RecordedMessage,
    runScenario,
    toJsonLines,
} from "./scenario-harness";
import {SCENARIOS, type Scenario} from "./scenarios";

const PROFILE_NAMES: ProfileName[] = ["plain", "zed", "air"];

type Update = Record<string, any>;

/** The recorded messages of every scenario for every profile. The scenarios run once per file. */
const recordings = new Map<string, RecordedMessage[]>();

function scenario(name: string): Scenario {
    const found = SCENARIOS.find(candidate => candidate.name === name);
    if (found === undefined) throw new Error(`No scenario ${name}`);
    return found;
}

function recording(profile: ProfileName, name: string): RecordedMessage[] {
    const messages = recordings.get(`${profile}/${name}`);
    if (messages === undefined) throw new Error(`No recording ${profile}/${name}`);
    return messages;
}

function updates(profile: ProfileName, name: string, toolCallId?: string): Update[] {
    return recording(profile, name)
        .filter(message => message.method === "session/update")
        .map(message => (message.params as {update: Update}).update)
        .filter(update => toolCallId === undefined || update["toolCallId"] === toolCallId);
}

function permissionRequests(profile: ProfileName, name: string): Update[] {
    return recording(profile, name)
        .filter(message => message.method === "session/request_permission")
        .map(message => message.params as Update);
}

function response(profile: ProfileName, name: string, method: string): Update {
    const found = recording(profile, name).find(message => message.direction === "response" && message.method === method);
    if (found === undefined) throw new Error(`No ${method} response in ${profile}/${name}`);
    return found.params as Update;
}

beforeAll(async () => {
    for (const profile of PROFILE_NAMES) {
        for (const each of SCENARIOS) {
            recordings.set(`${profile}/${each.name}`, normalize(await runScenario(each, profile)));
        }
    }
}, 120_000);

describe("AIR golden snapshots", () => {
    for (const each of SCENARIOS) {
        it(each.name, async () => {
            await expect(toJsonLines(recording("air", each.name))).toMatchFileSnapshot(`data/air/${each.name}.jsonl`);
        });
    }
});

const RECORD_BASELINE = process.env["RECORD_SCENARIO_BASELINE"] === "1";

function baselineFile(profile: ProfileName, name: string): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "baseline", profile, `${name}.jsonl`);
}

describe("clients that are not AIR, compared with the baseline", () => {
    for (const profile of ["plain", "zed"] as const) {
        for (const each of SCENARIOS) {
            it.skipIf(RECORD_BASELINE)(`${profile}: ${each.name} gets the baseline messages with the allowed differences`, () => {
                const baseline = fromJsonLines(fs.readFileSync(baselineFile(profile, each.name), "utf8"));
                expect(lines(mergedReports(recording(profile, each.name))))
                    .toEqual(lines(mergedReports(expectedFromBaseline(each.name, baseline))));
            });
        }
    }

    it("catches a permission request that omits the kind of a reported tool call", () => {
        const started: RecordedMessage = {
            direction: "notify",
            method: "session/update",
            params: {sessionId: "s", update: {sessionUpdate: "tool_call", toolCallId: "t", kind: "execute", title: "t"}},
        };
        const request = (toolCall: Record<string, unknown>): RecordedMessage => ({
            direction: "request",
            method: "session/request_permission",
            params: {sessionId: "s", toolCall: {toolCallId: "t", status: "pending", ...toolCall}, options: []},
        });
        expect(lines(mergedReports([started, request({})])))
            .not.toEqual(lines(mergedReports([started, request({kind: "execute"})])));
    });

    it.runIf(RECORD_BASELINE)("records the baseline", () => {
        for (const profile of ["plain", "zed"] as const) {
            for (const each of SCENARIOS) {
                fs.mkdirSync(path.dirname(baselineFile(profile, each.name)), {recursive: true});
                fs.writeFileSync(baselineFile(profile, each.name), toJsonLines(recording(profile, each.name)));
            }
        }
    });
});

describe("session start messages", () => {
    for (const profile of PROFILE_NAMES) {
        it(`${profile}: records the auth status after initialize and the available commands of every scenario`, () => {
            for (const each of SCENARIOS) {
                const messages = recording(profile, each.name);
                expect(messages.slice(0, 2).map(message => `${message.direction} ${message.method}`), each.name)
                    .toEqual(["response initialize", "notify _auth/status_update"]);
                expect(messages[1]!.params, each.name).toEqual({authStatus: {kind: "none", label: "Not logged in"}});
                expect(updates(profile, each.name).filter(update => update["sessionUpdate"] === "available_commands_update"),
                    each.name).toHaveLength(1);
            }
        });
    }

    it("validates the auth status notification", () => {
        const auth = (params: unknown): RecordedMessage => ({direction: "notify", method: "_auth/status_update", params});
        expect(schemaErrors(auth({authStatus: {kind: "none", label: "Not logged in"}}))).toEqual([]);
        expect(schemaErrors(auth({authStatus: {kind: "unknown", label: "Not logged in"}}))).not.toEqual([]);
        expect(schemaErrors(auth({authStatus: {kind: "none"}}))).not.toEqual([]);
        expect(schemaErrors({direction: "notify", method: "_unknown/extension", params: {}})).not.toEqual([]);
    });
});

describe("normalization of the recorded messages", () => {
    const id = "0f8fe1f5-7c4a-4d3e-9d8a-1b2c3d4e5f60";
    const message = (method: string, params: unknown): RecordedMessage => ({direction: "notify", method, params});

    it("replaces only the random id of an MCP startup tool call and the package version", () => {
        const initialize = (version: string): RecordedMessage =>
            ({direction: "response", method: "initialize", params: {agentInfo: {version}}});
        expect(normalize([initialize(packageJson.version), initialize("0.0.1")]))
            .toEqual([initialize("<version>"), initialize("0.0.1")]);
        expect(normalize([
            message("session/update", {update: {toolCallId: `mcp_startup.db.${id}`}}),
            message("session/update", {update: {toolCallId: "t", content: `see mcp_startup.db.${id}`}}),
        ])).toEqual([
            message("session/update", {update: {toolCallId: "mcp_startup.db.<uuid>"}}),
            message("session/update", {update: {toolCallId: "t", content: "see mcp_startup.db.<uuid>"}}),
        ]);
    });

    it("keeps every other id, version, path, and time", () => {
        const kept = [
            message("session/update", {update: {toolCallId: id, locations: [{path: "/elsewhere/App.ts"}]}}),
            message("session/update", {update: {_meta: {goal: {createdAt: 1710000000, updatedAt: 1710000001}}}}),
            {direction: "response", method: "session/new", params: {_meta: {version: "9.9.9"}}},
        ];
        expect(normalize(kept)).toEqual(kept);
    });
});

describe("ACP schema", () => {
    for (const profile of PROFILE_NAMES) {
        it(`accepts every outbound message of the ${profile} profile`, () => {
            const errors = SCENARIOS.flatMap(each => recording(profile, each.name)
                .flatMap(message => schemaErrors(message).map(error => `${each.name} ${message.method}: ${error}`)));
            expect(errors).toEqual([]);
        });
    }

    it("checks the envelope of an AIR session update", () => {
        const update = (params: unknown): RecordedMessage => ({direction: "notify", method: "session/update", params});
        expect(schemaErrors(update({sessionId: "s", update: {sessionUpdate: "subagent_spawned", subagentSessionId: "c"}})))
            .toEqual([]);
        expect(schemaErrors(update({update: {sessionUpdate: "subagent_spawned"}}))).not.toEqual([]);
        expect(schemaErrors(update({sessionId: 1, update: {sessionUpdate: "async_task_spawned"}}))).not.toEqual([]);
        expect(schemaErrors(update({sessionId: "s", update: {sessionUpdate: "subagent_state_update", _meta: "x"}})))
            .not.toEqual([]);
    });

    it("rejects an invalid tool call", () => {
        expect(schemaErrors({
            direction: "notify",
            method: "session/update",
            params: {sessionId: "s", update: {sessionUpdate: "tool_call", toolCallId: "t", title: "t", status: "done"}},
        })).not.toEqual([]);
    });
});

describe("clients that are not AIR", () => {
    for (const profile of ["plain", "zed"] as const) {
        it(`${profile}: gets no AIR-only metadata key`, () => {
            const found = SCENARIOS.flatMap(each => metaObjects(recording(profile, each.name))
                .flatMap(meta => airOnlyKeys(meta).map(key => `${each.name}: ${key}`)));
            expect(found).toEqual([]);
        });

        it(`${profile}: gets no terminal_input, because the stdin comes as an output chunk`, () => {
            const found = SCENARIOS.flatMap(each => metaObjects(recording(profile, each.name))
                .filter(({meta}) => "terminal_input" in meta)
                .map(() => each.name));
            expect(found).toEqual([]);
        });

        it(`${profile}: gets no session_info_update for a goal`, () => {
            expect(updates(profile, "goal-update").filter(update => update["sessionUpdate"] === "session_info_update"))
                .toEqual([{sessionUpdate: "session_info_update", title: "Go"}]);
        });

        it(`${profile}: gets the output and the exit code of every command in rawOutput`, () => {
            const ends = [
                ...updates(profile, "command-output-stdin", "cmd-1"),
                ...updates(profile, "read-search-list"),
                ...updates(profile, "command-failed", "cmd-3"),
            ].filter(update => update["status"] === "completed" || update["status"] === "failed");
            expect(ends.map(update => update["rawOutput"])).toEqual([
                {formatted_output: "Running tests\n1 passed\n", exit_code: 0},
                {formatted_output: "export const a = 1;\n", exit_code: 0},
                {formatted_output: "src/app.ts:3: // TODO\n", exit_code: 0},
                {formatted_output: "app.ts\n", exit_code: 0},
                {formatted_output: "cat: missing.txt: No such file\n", exit_code: 1},
            ]);
            expect(ends.every(update => update["content"] === undefined)).toBe(true);
        });

        it(`${profile}: gets the full item fields of the tool kinds that AIR reports in another shape`, () => {
            expect(updates(profile, "mcp-tool", "mcp-1").at(-1)).toMatchObject({
                rawOutput: {result: {content: [{type: "text", text: "3 hits"}], structuredContent: {hits: 3}}, error: null},
            });
            expect(updates(profile, "mcp-tool", "mcp-1").at(-1)).not.toHaveProperty("content");
            expect(updates(profile, "web-search", "web-1")[0]!["rawInput"])
                .toEqual({type: "webSearch", id: "web-1", query: "", action: null});
            expect(updates(profile, "collab-agent", "collab-1")[0]!["rawInput"]).toMatchObject({
                prompt: "Find the weather in Paris.",
                agentsStates: {"child-thread": {status: "running", message: "Checking"}},
                status: "inProgress",
            });
            expect(updates(profile, "collab-agent", "collab-1")[0]).not.toHaveProperty("content");
            expect(updates(profile, "guardian-review").find(update => update["sessionUpdate"] === "tool_call")!["content"]).toEqual([{
                type: "content",
                content: {
                    type: "text",
                    text: "Status: In progress\nAction: shell rm -rf build\nRisk: medium\nAuthorization: unknown\nRationale: Checking.",
                },
            }]);
            expect(updates(profile, "image-generation", "gen-1")[0]!["rawInput"]).toEqual({id: "gen-1"});
            expect(permissionRequests(profile, "plan-review-permission")[0]!["toolCall"]["rawInput"])
                .toEqual({plan: "# Plan\n\n1. Make the change."});
        });

        it(`${profile}: gets the plan once when the plan completes`, () => {
            expect(updates(profile, "plan-stream").filter(update => update["sessionUpdate"] === "agent_message_chunk"))
                .toEqual([{
                    sessionUpdate: "agent_message_chunk",
                    messageId: "plan-3",
                    content: {type: "text", text: "# Plan\n\n1. Read.\n2. Write."},
                }]);
        });

        it(`${profile}: gets the pre-contract permission request of a started command`, () => {
            expect(permissionRequests(profile, "command-approval")[0]).toEqual(expect.objectContaining({
                toolCall: {
                    toolCallId: "cmd-a",
                    kind: "execute",
                    status: "pending",
                    title: "Run command",
                    rawInput: {command: "npm install", cwd: "/workspace"},
                },
            }));
            expect(permissionRequests(profile, "command-approval")[0]).not.toHaveProperty("_meta");
        });
    }
});

/**
 * The tool call fields that a report repeats with the same value, and the tool call updates without a field.
 * The client merges the tool call of a permission request like an update.
 * The request itself carries the title and the parameters on purpose, so only updates are checked.
 */
function repeatedFields(profile: ProfileName): string[] {
    const repeated: string[] = [];
    for (const each of SCENARIOS) {
        const reported = new Map<string, Map<string, string>>();
        const reports = recording(profile, each.name).flatMap((message): Update[] => {
            if (message.method === "session/update") return [(message.params as {update: Update}).update];
            if (message.method === "session/request_permission") {
                return [{sessionUpdate: "permission", ...(message.params as Update)["toolCall"]}];
            }
            return [];
        });
        for (const update of reports) {
            if (update["sessionUpdate"] === "permission") {
                const fields = reported.get(update["toolCallId"]) ?? new Map<string, string>();
                reported.set(update["toolCallId"], fields);
                for (const [name, value] of Object.entries(update)) fields.set(name, JSON.stringify(value));
                continue;
            }
            if (update["sessionUpdate"] !== "tool_call" && update["sessionUpdate"] !== "tool_call_update") continue;
            if (update["sessionUpdate"] === "tool_call_update" && Object.keys(update).length <= 2) {
                repeated.push(`${each.name} ${update["toolCallId"]} without a field`);
            }
            const fields = update["sessionUpdate"] === "tool_call"
                ? new Map<string, string>()
                : reported.get(update["toolCallId"]) ?? new Map<string, string>();
            reported.set(update["toolCallId"], fields);
            for (const name of ["title", "kind", "status", "content", "locations", "rawInput", "rawOutput"]) {
                if (update[name] === undefined) continue;
                const value = JSON.stringify(update[name]);
                if (fields.get(name) === value) repeated.push(`${each.name} ${update["toolCallId"]} ${name}`);
                fields.set(name, value);
            }
        }
    }
    return repeated;
}

describe("every client", () => {
    for (const profile of PROFILE_NAMES) {
        it(`${profile}: gets no tool call field twice with the same value, and no tool call update without a field`, () => {
            expect(repeatedFields(profile)).toEqual([]);
        });

        it(`${profile}: gets the model list in the session/new and session/load responses`, () => {
            const models = {
                currentModelId: "model-id[medium]",
                availableModels: [{modelId: "model-id[medium]", name: "model-id (medium)", description: "model-id model Balanced"}],
            };
            expect(response(profile, "plan-stream", "session/new")["models"]).toEqual(models);
            expect(response(profile, "history-replay", "session/load")["models"]).toEqual(models);
        });

        it(`${profile}: gets empty locations when a fuzzy search finds no file`, () => {
            const reported = updates(profile, "fuzzy-file-search", "fuzzyFileSearch.search-1");
            expect(reported.map(update => update["locations"])).toEqual([
                [{path: "/workspace/src/Handler.ts"}],
                [{path: "/workspace/src/OtherHandler.ts"}],
                [],
                undefined,
            ]);
        });
    }
});

/**
 * The session and the update kind of each session update, with the tool call id when there is one.
 * The session title and the available commands of the session start are left out.
 */
function timeline(profile: ProfileName, name: string): string[] {
    return recording(profile, name)
        .filter(message => message.method === "session/update")
        .map(message => message.params as {sessionId: string; update: Update})
        .filter(({update}) => update["sessionUpdate"] !== "session_info_update"
            && update["sessionUpdate"] !== "available_commands_update")
        .map(({sessionId, update}) => [sessionId, update["sessionUpdate"], update["toolCallId"] ?? update["subagentSessionId"]]
            .filter(part => part !== undefined).join(" "));
}

const SUBAGENT_SCENARIOS = ["native-subagent-session", "nested-subagent-session", "late-subagent-update", "collab-controls"];

describe("subagents", () => {
    for (const profile of ["plain", "zed"] as const) {
        it(`${profile}: gets the legacy tool calls on the root session and no child session`, () => {
            for (const name of SUBAGENT_SCENARIOS) {
                const sessions = new Set(recording(profile, name)
                    .filter(message => message.method === "session/update")
                    .map(message => (message.params as {sessionId: string}).sessionId));
                expect(sessions).toEqual(new Set(["session-1"]));
                expect(timeline(profile, name).some(entry => entry.includes("subagent_"))).toBe(false);
            }
            expect(timeline(profile, "collab-controls")).toEqual([
                "session-1 tool_call spawn-1",
                "session-1 tool_call act-1",
                "session-1 tool_call wait-1",
                "session-1 tool_call_update wait-1",
                "session-1 tool_call send-1",
                "session-1 tool_call_update send-1",
                "session-1 tool_call resume-1",
                "session-1 tool_call_update resume-1",
                "session-1 tool_call close-1",
                "session-1 tool_call_update close-1",
                "session-1 tool_call_update spawn-1",
            ]);
        });
    }

    it("air: gets the child session before the child output, and the child state on the parent", () => {
        expect(timeline("air", "native-subagent-session")).toEqual([
            "session-1 subagent_spawned child-thread",
            "child-thread tool_call child-cmd",
            "child-thread tool_call_update child-cmd",
            "child-thread tool_call_update child-cmd",
            "child-thread tool_call child-mcp",
            "child-thread tool_call_update child-mcp",
            "child-thread agent_message_chunk",
            "session-1 subagent_state_update child-thread",
        ]);
    });

    it("air: gets a nested child on its immediate parent", () => {
        expect(timeline("air", "nested-subagent-session")).toEqual([
            "session-1 subagent_spawned child-thread",
            "child-thread subagent_spawned grandchild-thread",
            "grandchild-thread tool_call grandchild-cmd",
            "grandchild-thread tool_call_update grandchild-cmd",
            "grandchild-thread agent_message_chunk",
            "child-thread subagent_state_update grandchild-thread",
            "session-1 subagent_state_update child-thread",
        ]);
    });

    it("air: gets no child update after the child ends", () => {
        expect(timeline("air", "late-subagent-update")).toEqual([
            "session-1 subagent_spawned child-thread",
            "child-thread tool_call child-cmd",
            "session-1 subagent_state_update child-thread",
        ]);
    });

    it("air: gets wait, sendInput, resumeAgent and closeAgent as tool calls without _meta.jetbrains.air.subagent", () => {
        const controls = updates("air", "collab-controls")
            .filter(update => ["wait-1", "send-1", "resume-1", "close-1"].includes(update["toolCallId"]));
        expect(controls.map(update => [update["sessionUpdate"], update["title"]])).toEqual([
            ["tool_call", "wait"],
            ["tool_call_update", undefined],
            ["tool_call", "sendInput"],
            ["tool_call_update", undefined],
            ["tool_call", "resumeAgent"],
            ["tool_call_update", undefined],
            ["tool_call", "closeAgent"],
            ["tool_call_update", undefined],
        ]);
        expect(controls.every(update => update["_meta"] === undefined)).toBe(true);
    });
});

describe("plain ACP client", () => {
    it("gets terminal_output_delta chunks, the stdin on its own line, and the output in rawOutput at the end", () => {
        expect(updates("plain", "command-output-stdin", "cmd-1")).toEqual([
            expect.objectContaining({sessionUpdate: "tool_call", content: [{type: "terminal", terminalId: "cmd-1"}]}),
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "Running tests\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "\ny\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "1 passed\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                status: "completed",
                rawOutput: {formatted_output: "Running tests\n1 passed\n", exit_code: 0},
                _meta: {terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"}},
            },
        ]);
    });

    it("gets the output of a command that did not stream in one terminal_output_delta chunk at the end", () => {
        expect(updates("plain", "command-without-streamed-output", "cmd-2").at(-1)!["_meta"]).toEqual({
            terminal_output_delta: {data: "a.txt\nb.txt\n", terminal_id: "cmd-2"},
            terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-2"},
        });
    });

    it("gets a replayed command with terminal_output_delta, terminal_exit and rawOutput", () => {
        expect(updates("plain", "history-replay", "h-cmd").at(-1)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "h-cmd",
            rawOutput: {formatted_output: "1 passed\n", exit_code: 0},
            _meta: {
                terminal_output_delta: {data: "1 passed\n", terminal_id: "h-cmd"},
                terminal_exit: {exit_code: 0, signal: null, terminal_id: "h-cmd"},
            },
        });
    });
});

describe("a client that declares terminal_output_delta and is not AIR", () => {
    const capabilities: acp.ClientCapabilities = {_meta: {terminal_output_delta: true}};

    async function commandUpdates(name: string, toolCallId: string): Promise<Update[]> {
        return normalize(await runScenario(scenario(name), capabilities))
            .filter(message => message.method === "session/update")
            .map(message => (message.params as {update: Update}).update)
            .filter(update => update["toolCallId"] === toolCallId);
    }

    it("gets terminal_output_delta chunks, the stdin on its own line, and no rawOutput at the end", async () => {
        expect((await commandUpdates("command-output-stdin", "cmd-1")).slice(1)).toEqual([
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "Running tests\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "\ny\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "1 passed\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                status: "completed",
                _meta: {terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"}},
            },
        ]);
    });

    it("gets the output of a command that did not stream in one terminal_output_delta chunk at the end", async () => {
        expect((await commandUpdates("command-without-streamed-output", "cmd-2")).at(-1)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-2",
            status: "completed",
            _meta: {
                terminal_output_delta: {data: "a.txt\nb.txt\n", terminal_id: "cmd-2"},
                terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-2"},
            },
        });
    });

    it("gets a replayed command with terminal_output_delta, terminal_exit and rawOutput", async () => {
        expect((await commandUpdates("history-replay", "h-cmd")).at(-1)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "h-cmd",
            rawOutput: {formatted_output: "1 passed\n", exit_code: 0},
            _meta: {
                terminal_output_delta: {data: "1 passed\n", terminal_id: "h-cmd"},
                terminal_exit: {exit_code: 0, signal: null, terminal_id: "h-cmd"},
            },
        });
    });
});

describe("Zed", () => {
    it("declares terminal_output", () => {
        expect(PROFILES.zed._meta).toMatchObject({terminal_output: true});
    });

    it("gets terminal_info and the terminal content block on the command tool call", () => {
        expect(updates("zed", "command-output-stdin", "cmd-1")[0]).toEqual({
            sessionUpdate: "tool_call",
            toolCallId: "cmd-1",
            kind: "execute",
            title: "npm test",
            status: "in_progress",
            content: [{type: "terminal", terminalId: "cmd-1"}],
            rawInput: {command: "npm test", cwd: "/workspace"},
            _meta: {terminal_info: {cwd: "/workspace", terminal_id: "cmd-1"}},
        });
    });

    it("gets terminal_output chunks, the stdin on its own line, and terminal_exit at the end", () => {
        expect(updates("zed", "command-output-stdin", "cmd-1").slice(1)).toEqual([
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output: {data: "Running tests\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output: {data: "\ny\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output: {data: "1 passed\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                status: "completed",
                rawOutput: {formatted_output: "Running tests\n1 passed\n", exit_code: 0},
                _meta: {terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"}},
            },
        ]);
    });

    it("gets the output of a command that did not stream in one terminal_output chunk at the end", () => {
        expect(updates("zed", "command-without-streamed-output", "cmd-2").at(-1)).toEqual({
            sessionUpdate: "tool_call_update",
            toolCallId: "cmd-2",
            status: "completed",
            rawOutput: {formatted_output: "a.txt\nb.txt\n", exit_code: 0},
            _meta: {
                terminal_output: {data: "a.txt\nb.txt\n", terminal_id: "cmd-2"},
                terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-2"},
            },
        });
    });

    it("gets a replayed command with terminal_output and terminal_exit", () => {
        const replayed = updates("zed", "history-replay", "h-cmd");
        expect(replayed[0]).toMatchObject({
            content: [{type: "terminal", terminalId: "h-cmd"}],
            _meta: {terminal_info: {cwd: "/workspace", terminal_id: "h-cmd"}},
        });
        expect(replayed.at(-1)!["_meta"]).toEqual({
            terminal_output: {data: "1 passed\n", terminal_id: "h-cmd"},
            terminal_exit: {exit_code: 0, signal: null, terminal_id: "h-cmd"},
        });
    });

    it("gets terminal_output_delta chunks for a read command, because it shows no terminal", () => {
        expect(updates("zed", "read-search-list", "read-1").map(update => update["_meta"])).toEqual([
            undefined,
            {terminal_output_delta: {data: "export const a = 1;\n", terminal_id: "read-1"}},
            undefined,
        ]);
    });

    it("keeps is_mcp_tool_call and the trimmed progress text in mcp_output_delta", () => {
        const mcp = updates("zed", "mcp-tool", "mcp-1");
        expect(mcp[0]!["_meta"]).toEqual({is_mcp_tool_call: true});
        expect(mcp[1]!["_meta"]).toEqual({mcp_output_delta: {data: "fetching page 1"}});
        expect(mcp[2]!["_meta"]).toEqual({mcp_output_delta: {data: "fetching page 2"}});
    });
});

describe("AIR", () => {
    it("declares the AIR extension with every capability that the adapter knows and terminal_output_delta", () => {
        expect(PROFILES.air._meta).toMatchObject({
            terminal_output_delta: true,
            jetbrains: {air: {version: 1, capabilities: AIR_CAPABILITY_NAMES}},
        });
        const air = response("air", "command-output-stdin", "initialize")["_meta"]["jetbrains"]["air"];
        expect(air).toEqual({
            version: 1,
            goal: {version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"]},
            capabilities: expect.any(Array),
        });
        expect([...air["capabilities"]].sort()).toEqual([...AIR_CAPABILITY_NAMES].sort());
    });

    it("gets terminal_output_delta chunks, the raw stdin in terminal_input, and terminal_exit without rawOutput", () => {
        expect(updates("air", "command-output-stdin", "cmd-1").slice(1)).toEqual([
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "Running tests\n", terminal_id: "cmd-1"}},
            },
            {sessionUpdate: "tool_call_update", toolCallId: "cmd-1", _meta: {terminal_input: {data: "y", terminal_id: "cmd-1"}}},
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                _meta: {terminal_output_delta: {data: "1 passed\n", terminal_id: "cmd-1"}},
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "cmd-1",
                status: "completed",
                _meta: {terminal_exit: {exit_code: 0, signal: null, terminal_id: "cmd-1"}},
            },
        ]);
    });

    it("gets no output of a file read, and the output of a search or a list once as a chunk", () => {
        const all = updates("air", "read-search-list");
        const chunks = all.flatMap(update => {
            const chunk = (update["_meta"] as {terminal_output_delta?: {data: string}} | undefined)?.terminal_output_delta;
            return chunk ? [[update["toolCallId"], chunk.data]] : [];
        });
        expect(chunks).toEqual([["search-1", "src/app.ts:3: // TODO\n"], ["list-1", "app.ts\n"]]);
        expect(all.some(update => update["content"] !== undefined && update["status"] === "completed")).toBe(false);
        expect(all.some(update => update["rawOutput"] !== undefined)).toBe(false);
    });

    it("gets the AIR keys in _meta.jetbrains.air", () => {
        const air = (meta: unknown) => (meta as {jetbrains: {air: Record<string, unknown>}}).jetbrains.air;
        const message = updates("air", "agent-message-and-reasoning")
            .find(update => update["sessionUpdate"] === "agent_message_chunk" && update["_meta"] !== undefined);
        expect(air(message!["_meta"])).toEqual({version: 1, phase: "final_answer"});
        expect(updates("air", "goal-update").filter(update => update["_meta"] !== undefined).map(update => air(update["_meta"])))
            .toEqual([
                {version: 1, goal: expect.objectContaining({objective: "Ship it", status: "active"})},
                {version: 1, goal: null},
            ]);
        const newSession = response("air", "command-output-stdin", "session/new");
        expect(air(newSession["modes"]["availableModes"][0]["_meta"])).toEqual({version: 1, kind: "standard"});
        expect(air(newSession["configOptions"][0]["options"][0]["_meta"])).toEqual({version: 1, kind: "standard"});
        const commands = updates("air", "history-replay")
            .find(update => update["sessionUpdate"] === "available_commands_update")!["availableCommands"];
        expect(air(commands[0]["_meta"])).toEqual({
            version: 1,
            commandAction: {
                kind: "setConfigOption",
                configId: "collaboration_mode",
                value: "plan",
                resetValue: "default",
                presentation: "state",
            },
        });
        const permission = permissionRequests("air", "command-approval")[0]!;
        expect(air(permission["_meta"])).toEqual({
            version: 1,
            permission: {version: 1, title: "Run command?", description: "Install the dependencies."},
        });
        expect(air(updates("air", "context-compaction", "compact-1")[0]!["_meta"]))
            .toEqual({version: 1, contextCompaction: {version: 1}});
    });

    it("gets no MCP progress", () => {
        const text = JSON.stringify(recording("air", "mcp-tool"));
        expect(text).not.toContain("mcp_output_delta");
        expect(text).not.toContain("fetching page");
    });

    it("gets the MCP result and error in rawOutput = {result, error}, and no copy in content", () => {
        const ends = ["mcp-1", "mcp-2"].map(id => updates("air", "mcp-tool", id).at(-1)!);
        expect(ends.map(update => update["rawOutput"])).toEqual([
            {result: {content: [{type: "text", text: "3 hits"}], structuredContent: {hits: 3}, _meta: null}, error: null},
            {result: null, error: {message: "server exploded"}},
        ]);
        expect(ends.map(update => update["content"])).toEqual([undefined, undefined]);
    });

    it("gets the plan text in rawInput.plan of the plan review, and no plan review metadata", () => {
        const review = permissionRequests("air", "plan-review-permission")[0]!;
        expect(review["toolCall"]["rawInput"]).toEqual({plan: "# Plan\n\n1. Make the change."});
        expect(review).not.toHaveProperty("_meta");
    });

    it("gets a streamed plan as plan_update snapshots and _meta.jetbrains.air.contentDelta appends", () => {
        expect(updates("air", "plan-stream").filter(update => update["sessionUpdate"] === "plan_update")).toEqual([
            {sessionUpdate: "plan_update", plan: {type: "markdown", planId: "plan-3", content: "# Plan\n\n"}},
            {
                sessionUpdate: "plan_update",
                plan: {type: "markdown", planId: "plan-3", content: ""},
                _meta: {jetbrains: {air: {version: 1, contentDelta: "1. Read."}}},
            },
            {
                sessionUpdate: "plan_update",
                plan: {type: "markdown", planId: "plan-3", content: ""},
                _meta: {jetbrains: {air: {version: 1, contentDelta: "\n2. Write."}}},
            },
        ]);
    });

    const airWithoutNativeSubagents = {
        ...PROFILES.air,
        _meta: {
            terminal_output_delta: true,
            jetbrains: {air: {version: 1, capabilities: AIR_CAPABILITY_NAMES.filter(name => name !== "nativeSubagentSessions")}},
        },
    };

    /** The `collab-agent` scenario with another Codex collaboration tool. */
    function collabScenario(tool: string): Scenario {
        const base = scenario("collab-agent");
        return {
            ...base,
            steps: base.steps!.map(step => {
                if (!("notify" in step)) return step;
                const params = step.notify["params"] as {item: Record<string, unknown>};
                return {notify: {...step.notify, params: {...params, item: {...params.item, tool}}}};
            }),
        };
    }

    async function collabUpdates(tool: string): Promise<Update[]> {
        const messages = normalize(await runScenario(collabScenario(tool), airWithoutNativeSubagents));
        return messages.map(message => (message.params as {update?: Update}).update)
            .filter((update): update is Update => update?.["toolCallId"] === "collab-1");
    }

    it("gets _meta.jetbrains.air.subagent and the collaboration keys in rawInput on a spawn without native subagent sessions", async () => {
        const reported = await collabUpdates("spawnAgent");
        expect(reported[0]).toEqual({
            sessionUpdate: "tool_call",
            toolCallId: "collab-1",
            kind: "other",
            title: "spawnAgent",
            status: "in_progress",
            rawInput: {
                prompt: "Find the weather in Paris.",
                senderThreadId: "session-1",
                receiverThreadIds: ["child-thread"],
                agentsStates: {"child-thread": {status: "running", message: "Checking"}},
                model: null,
                reasoningEffort: null,
            },
            _meta: {jetbrains: {air: {version: 1, subagent: true}}},
        });
        expect(reported[1]).toMatchObject({
            status: "completed",
            rawInput: expect.objectContaining({agentsStates: {"child-thread": {status: "completed", message: "Sunny"}}}),
        });
        expect(reported.every(update => update["rawOutput"] === undefined)).toBe(true);
    });

    for (const tool of ["wait", "sendInput", "resumeAgent", "closeAgent"]) {
        it(`gets no _meta.jetbrains.air.subagent on ${tool}, which controls an existing subagent`, async () => {
            const reported = await collabUpdates(tool);
            expect(reported[0]!["rawInput"]).toEqual(expect.objectContaining({
                senderThreadId: "session-1",
                receiverThreadIds: ["child-thread"],
                agentsStates: {"child-thread": {status: "running", message: "Checking"}},
            }));
            expect(reported.map(update => update["_meta"])).toEqual([undefined, undefined]);
        });
    }

    it("gets no key of the pre-contract shape", () => {
        const text = SCENARIOS.map(each => JSON.stringify(recording("air", each.name))).join("\n");
        expect(text).not.toContain("formatted_output");
        expect(text).not.toContain("\"codex\"");
        expect(text).not.toContain("diffStats");
        expect(text).not.toContain("\"terminal_output\"");
    });
});

describe("history replay", () => {
    for (const profile of PROFILE_NAMES) {
        it(`${profile}: ends a replayed image generation that Codex saved while it was generating`, async () => {
            const messages = await runScenario({
                name: "history-image-generating",
                history: [{
                    type: "imageGeneration", id: "h-gen", status: "generating", revisedPrompt: null, result: "",
                    failure: null,
                }],
            }, profile);
            const reported = messages
                .filter(message => message.method === "session/update")
                .map(message => (message.params as {update: Update}).update)
                .filter(update => update["toolCallId"] === "h-gen");
            expect(reported.map(update => update["status"])).toEqual(["completed"]);
        });
    }
});
