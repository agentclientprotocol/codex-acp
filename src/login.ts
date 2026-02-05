import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAppServerClient} from "./CodexAppServerClient";
import type {ClientInfo} from "./app-server";
import open from "open";
import packageJson from "../package.json";
import {logger} from "./Logger";

interface LoginOptions {
    clientName?: string;
    clientTitle?: string;
    clientVersion?: string;
}

function parseArgs(args: string[]): LoginOptions | null {
    const options: LoginOptions = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;

        if (arg === "--help" || arg === "-h") {
            printHelp();
            return null;
        }

        if (arg === "--client-name" && i + 1 < args.length) {
            options.clientName = args[++i]!;
        } else if (arg.startsWith("--client-name=")) {
            options.clientName = arg.slice("--client-name=".length);
        }

        if (arg === "--client-title" && i + 1 < args.length) {
            options.clientTitle = args[++i]!;
        } else if (arg.startsWith("--client-title=")) {
            options.clientTitle = arg.slice("--client-title=".length);
        }

        if (arg === "--client-version" && i + 1 < args.length) {
            options.clientVersion = args[++i]!;
        } else if (arg.startsWith("--client-version=")) {
            options.clientVersion = arg.slice("--client-version=".length);
        }
    }

    return options;
}

function printHelp() {
    console.log(`
codex-acp login - Initialize and login to Codex with client context

Usage:
  codex-acp login [options]

Options:
  --client-name <name>       Client application name (default: "codex-acp")
  --client-title <title>     Client application title (default: "Codex ACP")
  --client-version <version> Client application version (default: "${packageJson.version}")
  --help, -h                 Show this help message

Example:
  codex-acp login --client-name="AIA Plugin" --client-title="AI Assistant" --client-version="1.0.0"
`);
}

async function login(options: LoginOptions): Promise<boolean> {
    const codexPath = process.env["CODEX_PATH"] ?? "codex";

    logger.log("Starting Codex connection...");
    const codexConnection = startCodexConnection(codexPath);

    const appServerClient = new CodexAppServerClient(codexConnection.connection);

    try {
        const clientInfo: ClientInfo = {
            name: options.clientName ?? "codex-acp",
            title: options.clientTitle ?? "Codex ACP",
            version: options.clientVersion ?? packageJson.version,
        };

        logger.log("Initializing with client", {name: clientInfo.name, version: clientInfo.version});
        await appServerClient.initialize({clientInfo: clientInfo, capabilities: null});

        const accountStatus = await appServerClient.accountRead({refreshToken: false});
        if (accountStatus.account) {
            logger.log("Already logged in", {accountType: accountStatus.account.type});
            if (accountStatus.account.type === "chatgpt") {
                return true;
            }
        }

        logger.log("Starting ChatGPT login...");
        const loginResponse = await appServerClient.accountLogin({type: "chatgpt"});

        if (loginResponse.type === "chatgpt") {
            logger.log("Opening browser for authentication...", {authUrl: loginResponse.authUrl});
            await open(loginResponse.authUrl);
        } else {
            logger.error("Unexpected login response type", new Error(`Expected 'chatgpt', got '${loginResponse.type}'`));
            return false;
        }

        logger.log("Waiting for login completion...");
        const result = await appServerClient.awaitLoginCompleted();

        if (result.success) {
            logger.log("Login successful!");
            return true;
        } else {
            logger.error("Login failed", new Error("Login was not successful"));
            return false;
        }
    } finally {
        codexConnection.connection.dispose();
        codexConnection.process.kill();
    }
}

/**
 * Run the login command with the given CLI arguments.
 * @param args CLI arguments after "login" command (e.g., ["--client-name", "AIA"])
 * @returns true if login succeeded, false otherwise
 */
export async function runLoginCommand(args: string[]): Promise<boolean> {
    const options = parseArgs(args);

    // null means help or version was shown, exit successfully
    if (options === null) {
        return true;
    }

    return login(options);
}
