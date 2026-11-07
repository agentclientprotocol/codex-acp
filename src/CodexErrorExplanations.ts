/**
 * Adds the likely cause to app-server errors whose text is too generic to act on.
 *
 * Every app-server request error passes through {@link explainCodexError}. A rule only rewrites the message,
 * and the code and data stay. Other code matches the message text too (`CodexThreadErrors`), so a rule must not
 * match the errors that such code recognizes.
 */

import {statSync} from "node:fs";
import {ResponseError} from "vscode-jsonrpc/node";

export interface ExplanationContext {
    /** The `$CODEX_HOME` of the app-server, from its `initialize` answer. */
    readonly codexHome: string | null;
}

interface ErrorExplanation {
    /** Full diagnostic text retained in the structured ACP error detail. */
    readonly message: string;
    /** Fixed guidance that is safe to present as the primary ACP error message. */
    readonly safeMessage: string;
}

const safeMessages = new WeakMap<Error, string>();

/** Returns the error with the likely cause in its message, or the same error when no rule applies. */
export function explainCodexError(err: Error, context: ExplanationContext): Error {
    for (const rule of RULES) {
        const explanation = rule(err, context);
        if (explanation !== null) return withExplanation(err, explanation);
    }
    return err;
}

/** The reviewed user-facing guidance attached by {@link explainCodexError}, if any. */
export function safeCodexErrorMessage(err: unknown): string | null {
    return err instanceof Error ? safeMessages.get(err) ?? null : null;
}

/** True for an error that a new login fixes, so the agent logs out. */
export function requiresLogout(err: Error): boolean {
    return err.message.includes("log out") || err.message.includes("cloud requirements");
}

/** Returns the new message, or `null` when the rule does not apply. */
type ExplanationRule = (err: Error, context: ExplanationContext) => ErrorExplanation | null;

/**
 * `config/read` wraps every config load failure as "failed to resolve feature override precedence"
 * (codex-rs/app-server `config_processor.rs`), and `thread/start` wraps it as "failed to load configuration".
 */
const FEATURE_OVERRIDE_PRECEDENCE_PREFIX = "failed to resolve feature override precedence: ";
const CONFIG_LOAD_FAILURE_PREFIX = "failed to load configuration: ";

/**
 * Codex loads the project config from its process working directory, even when the request has a `cwd`. The
 * app-server inherits that directory from this process, so a deleted directory fails every config load with a bare
 * "No such file or directory". The config files are not the cause, so the message does not point to them.
 */
const deletedWorkingDirectory: ExplanationRule = ({message}) => {
    const configLoadFailure = message.startsWith(FEATURE_OVERRIDE_PRECEDENCE_PREFIX)
        || message.startsWith(CONFIG_LOAD_FAILURE_PREFIX);
    if (!configLoadFailure || !message.includes("No such file or directory") || !workingDirectoryDeleted()) {
        return null;
    }
    return {
        message: `Codex cannot read its configuration: its working directory ${workingDirectory} `
            + "was deleted or replaced after the agent started. Restart the agent.",
        safeMessage: "Codex cannot read its configuration because its working directory was deleted or replaced. "
            + "Restart the agent.",
    };
};

/** Points a config load failure to the config files. A failure that needs a new login is not about them. */
const configFiles: ExplanationRule = (err, {codexHome}) => {
    if (requiresLogout(err)) return null;
    const message = err.message.startsWith(FEATURE_OVERRIDE_PRECEDENCE_PREFIX)
        ? CONFIG_LOAD_FAILURE_PREFIX + err.message.slice(FEATURE_OVERRIDE_PRECEDENCE_PREFIX.length)
        : err.message;
    if (!message.includes("load config")) return null;
    return {
        message: `${message}\n\nCheck ${codexHome ?? "global"} and project .codex directories, `
            + "especially their config.toml files, or any CODEX_CONFIG override.",
        safeMessage: "Codex could not load its configuration. Check the global and project .codex directories, "
            + "especially config.toml files or any CODEX_CONFIG override.",
    };
};

const RULES: readonly ExplanationRule[] = [deletedWorkingDirectory, configFiles];

function withExplanation(err: Error, explanation: ErrorExplanation): Error {
    const explained = err instanceof ResponseError
        ? new ResponseError(err.code, explanation.message, err.data)
        : new Error(explanation.message, {cause: err});
    safeMessages.set(explained, explanation.safeMessage);
    return explained;
}

// Read at start: the agent never changes it, and `process.cwd()` can fail once the directory is deleted.
const workingDirectory = (() => {
    try {
        return process.cwd();
    } catch {
        return "";
    }
})();

/** A directory created again at the same path is a new one: the process still points to the deleted directory. */
function workingDirectoryDeleted(): boolean {
    try {
        const current = statSync(".");
        const atPath = statSync(workingDirectory);
        return current.ino !== atPath.ino || current.dev !== atPath.dev;
    } catch {
        return true;
    }
}
