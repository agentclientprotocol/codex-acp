import type {Model} from "./app-server/v2";
import {logger} from "./Logger";

const LIST_TIMEOUT_MS = 10_000;
const MAX_REPORTED_BODY_CHARS = 500;

/** The ids of the models a gateway lists, normalized by {@link normalizeModelId}. */
export type GatewayModelIds = ReadonlySet<string>;

/**
 * A gateway model listing that failed: a network error, a status other than 2xx or 4xx, a malformed body, or the timeout.
 * The message names the listing path and the reason, never a header value.
 */
export class GatewayListingError extends Error {
    override name = "GatewayListingError";
}

/**
 * Lists the models of an OpenAI-compatible gateway: `GET {baseUrl}/models` with the headers Codex sends to it.
 * Returns `null` when the gateway answers 4xx: it has no listing, and nothing is narrowed.
 * Throws a {@link GatewayListingError} when the listing fails.
 */
export async function listGatewayModels(
    baseUrl: string,
    headers: Record<string, string>,
): Promise<GatewayModelIds | null> {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const parsedUrl = URL.canParse(url) ? new URL(url) : null;
    const path = parsedUrl?.pathname ?? url;
    if (parsedUrl?.username || parsedUrl?.password) {
        // Node's fetch refuses such a URL, with a message that holds the credentials.
        logger.log("[WARN] The gateway model listing failed", {path, reason: "the base URL carries credentials"});
        throw new GatewayListingError(`Model listing GET ${path} failed: the base URL carries credentials`);
    }
    const failure = (reason: string, details: Record<string, unknown>): GatewayListingError => {
        logger.log("[WARN] The gateway model listing failed", {url, reason, ...details});
        return new GatewayListingError(`Model listing GET ${path} ${reason}`);
    };
    const requestHeaders = {...headers, "Accept": "application/json"};
    for (const [name, value] of Object.entries(requestHeaders)) {
        // Node's fetch names an invalid header by its value, so check each header first.
        try {
            new Headers([[name, value]]);
        } catch {
            throw failure(`failed: the header "${name}" is invalid`, {});
        }
    }
    let response: Response;
    let body: string;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: requestHeaders,
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        body = await response.text();
    } catch (error) {
        throw failure(`failed: ${error instanceof Error ? error.message : String(error)}`, {});
    }
    if (response.status >= 400 && response.status < 500) {
        logger.log("The gateway has no model listing; models are not narrowed", {path, status: response.status});
        return null;
    }
    if (!response.ok) {
        throw failure(`returned ${response.status}: ${body.slice(0, MAX_REPORTED_BODY_CHARS)}`, {status: response.status});
    }
    let ids: string[] | null;
    try {
        ids = readModelIds(JSON.parse(body));
    } catch {
        ids = null;
    }
    if (ids === null) {
        throw failure("returned a malformed body", {});
    }
    logger.log("The gateway listed its models", {url, models: ids});
    return new Set(ids.map(normalizeModelId));
}

function readModelIds(body: unknown): string[] | null {
    if (typeof body !== "object" || body === null) return null;
    const data = (body as {data?: unknown}).data;
    if (!Array.isArray(data)) return null;
    const ids = data
        .map(entry => typeof entry === "object" && entry !== null ? (entry as {id?: unknown}).id : undefined)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length === data.length ? ids : null;
}

/** Lower case, without a date suffix: `GPT-5-2025-08-07` and `gpt-5-20250807` are both `gpt-5`. */
function normalizeModelId(id: string): string {
    return id.toLowerCase().replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

/** Whether the gateway lists the Codex model, by its `model` or its `id`. */
export function isListedModel(model: Model, listed: GatewayModelIds): boolean {
    return isListedModelId(model.model, listed) || isListedModelId(model.id, listed);
}

/** Whether the gateway lists a model of this id. */
export function isListedModelId(modelId: string, listed: GatewayModelIds): boolean {
    return listed.has(normalizeModelId(modelId));
}

/**
 * Keeps the Codex models the gateway lists, in Codex order, with exactly one default.
 * A gateway that lists none of them leaves no model: the session then offers none.
 */
export function narrowToListedModels(models: Model[], listed: GatewayModelIds): Model[] {
    const narrowed = models.filter(model => isListedModel(model, listed));
    if (narrowed.length === 0) {
        logger.log("[WARN] The gateway lists none of the Codex models; no model is available", {
            codexModels: models.map(model => model.id),
        });
        return [];
    }
    const defaultIndex = Math.max(0, narrowed.findIndex(model => model.isDefault));
    return narrowed.map((model, index) => model.isDefault === (index === defaultIndex)
        ? model
        : {...model, isDefault: index === defaultIndex});
}
