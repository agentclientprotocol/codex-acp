#!/usr/bin/env tsx
/**
 * Run real Codex with a prompt to test and verify code during development.
 *
 * Usage:
 *   npm run codex-test -- --prompt "Your prompt here"
 *   npm run codex-test -- -p "Hello" -c /path/to/project
 *   npm run codex-test -- -p "Hello" -o codex --json
 */

import path from "node:path";
import fs from "node:fs";
import {CodexAcpClient} from "../../../../src/CodexAcpClient";
import {type CodexConnectionEvent, CodexAppServerClient} from "../../../../src/CodexAppServerClient";
import {startCodexConnection} from "../../../../src/CodexJsonRpcConnection";
import {CodexAcpServer} from "../../../../src/CodexAcpServer";
import type {AgentSideConnection} from "@agentclientprotocol/sdk";

// Parse command line arguments
function parseArgs(): { prompt: string; cwd: string; output: string; json: boolean } {
    const args = process.argv.slice(2);
    let prompt = "";
    let cwd = process.cwd();
    let output = "all";
    let json = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--prompt" || arg === "-p") {
            prompt = args[++i] || "";
        } else if (arg === "--cwd" || arg === "-c") {
            cwd = args[++i] || process.cwd();
        } else if (arg === "--output" || arg === "-o") {
            output = args[++i] || "all";
        } else if (arg === "--json") {
            json = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log(`
Usage: npm run codex-test -- [options]

Options:
  -p, --prompt <text>   Prompt to send to Codex (required)
  -c, --cwd <path>      Working directory for the session (default: current dir)
  -o, --output <type>   Output type: all, codex, acp, summary (default: all)
  --json                Output events as JSON
  -h, --help            Show this help message

Examples:
  npm run codex-test -- -p "What files are here?"
  npm run codex-test -- -p "Read README" -c /path/to/project
  npm run codex-test -- -p "Hello" -o codex --json
`);
            process.exit(0);
        }
    }

    if (!prompt) {
        console.error("Error: --prompt is required");
        process.exit(1);
    }

    return { prompt, cwd, output, json };
}

type MethodCallEvent = { method: string; args: unknown[] };

function createMockAcpConnection(events: MethodCallEvent[]): AgentSideConnection {
    return new Proxy({} as AgentSideConnection, {
        get(_, prop) {
            return (...args: unknown[]) => {
                events.push({ method: String(prop), args });
                return Promise.resolve({ mock: "Mocked return" });
            };
        }
    });
}

async function main() {
    const { prompt, cwd, output, json } = parseArgs();

    // Find Codex binary
    const pathToCodex = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
    if (!fs.existsSync(pathToCodex)) {
        console.error(`Error: Codex binary not found at ${pathToCodex}. Did you run 'npm install'?`);
        process.exit(1);
    }

    console.log("=".repeat(60));
    console.log("Codex Test Runner");
    console.log("=".repeat(60));
    console.log(`Prompt: ${prompt}`);
    console.log(`CWD: ${cwd}`);
    console.log(`Output: ${output}`);
    console.log("=".repeat(60));
    console.log("");

    // Start Codex connection
    const codexConnection = startCodexConnection(pathToCodex);
    const codexAppServerClient = new CodexAppServerClient(codexConnection.connection);

    // Collect events
    const codexEvents: CodexConnectionEvent[] = [];
    const acpEvents: MethodCallEvent[] = [];

    codexAppServerClient.onClientTransportEvent((event) => {
        codexEvents.push(event);
        if (output === "all" || output === "codex") {
            if (json) {
                console.log(JSON.stringify(event));
            } else {
                console.log(`[CODEX] ${event.type}:`, JSON.stringify(event.data, null, 2));
            }
        }
    });

    const acpConnection = createMockAcpConnection(acpEvents);
    const codexAcpClient = new CodexAcpClient(codexAppServerClient);
    const codexAcpAgent = new CodexAcpServer(acpConnection, codexAcpClient, undefined, () => codexConnection.process.exitCode);

    // Track ACP events
    const originalSessionUpdate = acpConnection.sessionUpdate;
    (acpConnection as any).sessionUpdate = async (params: unknown) => {
        acpEvents.push({ method: "sessionUpdate", args: [params] });
        if (output === "all" || output === "acp") {
            if (json) {
                console.log(JSON.stringify({ method: "sessionUpdate", params }));
            } else {
                console.log(`[ACP] sessionUpdate:`, JSON.stringify(params, null, 2));
            }
        }
        return originalSessionUpdate?.call(acpConnection, params);
    };

    try {
        // Initialize
        console.log("\n--- Initializing ---\n");
        await codexAcpAgent.initialize({ protocolVersion: 1 });

        // Check auth
        const authRequired = await codexAcpClient.authRequired();
        if (authRequired) {
            console.error("Error: Authentication required. Please login to Codex first.");
            process.exit(1);
        }

        // Create session
        console.log("\n--- Creating Session ---\n");
        const sessionResponse = await codexAcpAgent.newSession({ cwd, mcpServers: [] });
        console.log(`Session ID: ${sessionResponse.sessionId}`);
        console.log(`Model: ${sessionResponse.models?.currentModelId}`);

        // Send prompt
        console.log("\n--- Sending Prompt ---\n");
        const startTime = Date.now();
        const promptResponse = await codexAcpAgent.prompt({
            sessionId: sessionResponse.sessionId,
            prompt: [{ type: "text", text: prompt }]
        });
        const duration = Date.now() - startTime;

        // Summary
        if (output === "all" || output === "summary") {
            console.log("\n" + "=".repeat(60));
            console.log("Summary");
            console.log("=".repeat(60));
            console.log(`Stop Reason: ${promptResponse.stopReason}`);
            console.log(`Duration: ${duration}ms`);
            console.log(`Codex Events: ${codexEvents.length}`);
            console.log(`ACP Events: ${acpEvents.length}`);

            if (promptResponse._meta?.quota?.token_count) {
                const tc = promptResponse._meta.quota.token_count as any;
                console.log(`\nToken Usage:`);
                console.log(`  Input Tokens: ${tc.inputTokens}`);
                console.log(`  Cached Input: ${tc.cachedInputTokens}`);
                console.log(`  Output Tokens: ${tc.outputTokens}`);
                console.log(`  Reasoning Tokens: ${tc.reasoningOutputTokens}`);
                console.log(`  Total Tokens: ${tc.totalTokens}`);
            }

            // Event type breakdown
            const eventTypes = new Map<string, number>();
            for (const event of codexEvents) {
                const key = `${event.type}:${(event.data as any)?.method || "unknown"}`;
                eventTypes.set(key, (eventTypes.get(key) || 0) + 1);
            }
            console.log(`\nEvent Types:`);
            for (const [type, count] of eventTypes) {
                console.log(`  ${type}: ${count}`);
            }
        }

        // Full response meta
        if (output === "all") {
            console.log("\n--- PromptResponse ---");
            console.log(JSON.stringify(promptResponse, null, 2));
        }

    } catch (err) {
        console.error("Error:", err);
        process.exit(1);
    } finally {
        codexConnection.connection.end();
        codexConnection.process.kill();
    }
}

main();
