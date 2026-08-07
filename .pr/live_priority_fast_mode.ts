import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

const sourceRoot = process.env.SOURCE_ROOT;
if (!sourceRoot) {
    throw new Error("SOURCE_ROOT must point to the codex-acp checkout under test");
}

const importSource = async (relativePath: string) => {
    return import(pathToFileURL(path.join(sourceRoot, relativePath)).href);
};

const {CodexAcpClient} = await importSource("src/CodexAcpClient.ts");
const {CodexAppServerClient} = await importSource("src/CodexAppServerClient.ts");
const {startCodexConnection} = await importSource("src/CodexJsonRpcConnection.ts");
const {CodexAcpServer} = await importSource("src/CodexAcpServer.ts");

const codexPath = path.join(
    sourceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
);
if (!fs.existsSync(codexPath)) {
    throw new Error(`Codex binary not found at ${codexPath}`);
}

const transportEvents: any[] = [];
const acpEvents: Array<{method: string; args: unknown[]}> = [];
const acpConnection = new Proxy({} as any, {
    get(_, property) {
        return (...args: unknown[]) => {
            acpEvents.push({method: String(property), args});
            return Promise.resolve({});
        };
    },
});

const codexConnection = startCodexConnection(codexPath);
const appServer = new CodexAppServerClient(codexConnection.connection);
appServer.onClientTransportEvent((event: any) => transportEvents.push(event));

// Exercise the same production configuration path as CODEX_CONFIG.
const client = new CodexAcpClient(appServer, {service_tier: "priority"});
const agent = new CodexAcpServer(
    acpConnection,
    client,
    undefined,
    () => codexConnection.process.exitCode,
);

try {
    await agent.initialize({protocolVersion: 1});
    if (await client.authRequired()) {
        throw new Error("Codex authentication is required");
    }

    const session = await agent.newSession({cwd: sourceRoot, mcpServers: []});
    const fastOption = session.configOptions?.find((option: any) => option.id === "fast-mode");
    const stateAfterStart = agent.getSessionState(session.sessionId);
    const promptResponse = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{type: "text", text: "Reply with exactly: priority-fast-live-ok"}],
    });

    const threadStartRequest = transportEvents.find(
        (event) => event.eventType === "request" && event.method === "thread/start",
    );
    const threadStartIndex = transportEvents.indexOf(threadStartRequest);
    const threadStartResponse = transportEvents
        .slice(threadStartIndex + 1)
        .find((event) => event.eventType === "response" && event.thread?.id === session.sessionId);
    const turnStartRequest = transportEvents.find(
        (event) => event.eventType === "request" && event.method === "turn/start",
    );
    const finalMessage = transportEvents
        .filter(
            (event) =>
                event.eventType === "notification" &&
                event.method === "item/completed" &&
                event.params?.item?.type === "agentMessage",
        )
        .at(-1)?.params?.item?.text;

    console.log(JSON.stringify({
        testedCommit: process.env.TESTED_COMMIT ?? null,
        codexVersion: threadStartResponse?.thread?.cliVersion ?? null,
        configuredServiceTier: threadStartRequest?.params?.config?.service_tier ?? null,
        appServerServiceTier: threadStartResponse?.serviceTier ?? null,
        fastConfigOption: fastOption
            ? {type: fastOption.type, currentValue: fastOption.currentValue}
            : null,
        fastModeEnabledAfterStart: stateAfterStart.fastModeEnabled,
        firstPromptServiceTier: turnStartRequest?.params?.serviceTier ?? null,
        promptStopReason: promptResponse.stopReason,
        finalMessage,
        requestSequence: transportEvents
            .filter((event) => event.eventType === "request")
            .map((event) => event.method),
        acpEventCount: acpEvents.length,
    }, null, 2));
} finally {
    codexConnection.connection.end();
    codexConnection.process.kill();
}
