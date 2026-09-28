#!/usr/bin/env node

import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAcpServer, type CodexProcessState} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";
import {logger} from "./Logger";
import {runLoginCommand} from "./login";
import {runCodexCli} from "./CodexCli";
import {createAcpAgentRouter} from "./AcpAgentRouter";
import type {AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

if (process.argv[2] === "login") {
    const args = process.argv.slice(3);
    runLoginCommand(args)
        .then((success) => process.exit(success ? 0 : 1))
        .catch((error) => {
            console.error("Login error:", error.message);
            process.exit(1);
        });
} else if (process.argv[2] === "cli") {
    const args = process.argv.slice(3);
    runCodexCli(process.env["CODEX_PATH"], args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpServer();
}

function startAcpServer() {
    const codexPath = process.env["CODEX_PATH"];
    const configString = process.env["CODEX_CONFIG"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const modelProvider = process.env["MODEL_PROVIDER"];
    const config = configString ? JSON.parse(configString) : undefined;
    const parsedAuthRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedAuthRequest && isCodexAuthRequest(parsedAuthRequest) ? parsedAuthRequest : undefined;

    logger.log("Startup", {
        name: packageJson.name,
        version: packageJson.version,
        codexPath: codexPath,
        modelProvider: modelProvider ?? null,
        codexConfig: config ?? null,
        authRequest: authRequestString ?? null,
        defaultAuthRequest: defaultAuthRequest ?? null,
    });

    const codexProcessState: CodexProcessState = {
        connection: startCodexConnection(codexPath),
        codexPath,
        config,
        modelProvider,
        stderr: "",
    };

    process.stdin.on("close", () => {
        codexProcessState.connection.process.stdin.end();
        // Kill the codex process if it doesn't exit naturally
        setTimeout(() => {
            if (!codexProcessState.connection.process.killed) {
                logger.log("Codex still running 2s after stdin closed; terminating process");
                codexProcessState.connection.process.kill();
            }
        }, 2000);
    });

    const acpJsonStream = createJsonStream(process.stdin, process.stdout);

    function createAgent(connection: AcpClientConnection | AcpV2Connection): CodexAcpServer {
        const appServerClient = new CodexAppServerClient(codexProcessState.connection.connection);
        const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
        return new CodexAcpServer(
            connection,
            codexClient,
            defaultAuthRequest,
            undefined,
            undefined,
            codexProcessState,
        );
    }

    createAcpAgentRouter(createAgent).connect(acpJsonStream);
}
