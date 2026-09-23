import fs from "node:fs";
import {createRequire} from "node:module";
import {Ajv2020, type ValidateFunction} from "ajv/dist/2020.js";
import type {RecordedMessage} from "./scenario-harness";

/**
 * Validates the outbound messages of the adapter against the ACP JSON schema that `@agentclientprotocol/sdk` ships.
 * The SDK does not export its zod schemas, so Ajv reads the JSON schema file of the package.
 */

const SCHEMA_ID = "acp";
const ajv = new Ajv2020({strict: false, allErrors: true});
ajv.addSchema(JSON.parse(fs.readFileSync(
    createRequire(import.meta.url).resolve("@agentclientprotocol/sdk/schema/schema.json"),
    "utf8",
)), SCHEMA_ID);

/** The ACP type of each recorded message. */
const MESSAGE_TYPES: Record<string, string> = {
    "notify session/update": "SessionNotification",
    "request session/request_permission": "RequestPermissionRequest",
    "request elicitation/create": "CreateElicitationRequest",
    "notify elicitation/complete": "CompleteElicitationNotification",
    "response initialize": "InitializeResponse",
    "response session/new": "NewSessionResponse",
    "response session/load": "LoadSessionResponse",
    "response session/prompt": "PromptResponse",
};

/**
 * The schemas of the extension notifications of the adapter. ACP defines no schema for them.
 * ACP requires only that the method starts with `_`, see `ExtNotification`.
 * The schema of `_auth/status_update` follows `AuthStatusUpdateNotification` in `src/AuthStatusMeta.ts`.
 */
const EXTENSION_NOTIFICATION_SCHEMAS: Record<string, object> = {
    "_auth/status_update": {
        type: "object",
        required: ["authStatus"],
        additionalProperties: false,
        properties: {
            authStatus: {
                type: "object",
                required: ["kind", "label"],
                additionalProperties: false,
                properties: {
                    kind: {enum: ["account", "api_key", "gateway", "external", "none"]},
                    label: {type: "string"},
                    detail: {type: "string"},
                    account: {
                        type: "object",
                        additionalProperties: false,
                        properties: {email: {type: "string"}, organization: {type: "string"}, plan: {type: "string"}},
                    },
                    vendor: {type: "object"},
                },
            },
        },
    },
};

/**
 * Session updates of the AIR extension that the ACP schema does not define.
 * The adapter sends them only to a client that negotiated them, see `docs/air-extensions.md`.
 */
export const AIR_SESSION_UPDATES = new Set([
    "subagent_spawned",
    "subagent_state_update",
    "async_task_spawned",
    "async_task_state_update",
]);

function validator(type: string): ValidateFunction {
    const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${type}`);
    if (validate === undefined) throw new Error(`The ACP schema has no type ${type}`);
    return validate;
}

/** Returns the ACP type of a message, or `null` when the message is not an ACP message of the adapter. */
export function acpMessageType(message: RecordedMessage): string | null {
    if (message.direction === "codexResponse") return null;
    const update = (message.params as {update?: {sessionUpdate?: string}} | undefined)?.update;
    if (message.method === "session/update" && AIR_SESSION_UPDATES.has(update?.sessionUpdate ?? "")) return null;
    const type = MESSAGE_TYPES[`${message.direction} ${message.method}`];
    if (type === undefined) throw new Error(`No ACP type for ${message.direction} ${message.method}`);
    return type;
}

/** Returns the schema errors of an extension notification, or `null` when the message is not one. */
function extensionNotificationErrors(message: RecordedMessage): string[] | null {
    if (message.direction !== "notify" || !message.method.startsWith("_")) return null;
    const schema = EXTENSION_NOTIFICATION_SCHEMAS[message.method];
    if (schema === undefined) return [`No schema for the extension notification ${message.method}`];
    const validate = ajv.compile(schema);
    return validate(message.params) ? [] : [`${message.method}: ${ajv.errorsText(validate.errors)}`];
}

/** Returns the schema errors of one message, or an empty list. */
export function schemaErrors(message: RecordedMessage): string[] {
    const extensionErrors = extensionNotificationErrors(message);
    if (extensionErrors !== null) return extensionErrors;
    const type = acpMessageType(message);
    if (type === null) return [];
    const validate = validator(type);
    return validate(message.params) ? [] : [`${type}: ${ajv.errorsText(validate.errors)}`];
}
