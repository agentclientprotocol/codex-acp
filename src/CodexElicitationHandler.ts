import * as acp from "@agentclientprotocol/sdk";
import type { SessionState } from "./CodexAcpServer";
import type { ElicitationHandler } from "./CodexAppServerClient";
import type { ServerNotification } from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {
    ItemCompletedNotification,
    ItemStartedNotification,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
} from "./app-server/v2";
import { logger } from "./Logger";
import { McpApprovalOptionId } from "./McpApprovalOptionId";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {
    clientSupportsFormElicitation,
    clientSupportsUrlElicitation,
} from "./ElicitationCapabilities";

// Standard elicitation options (non-tool-call approval).
const ELICITATION_OPTIONS: acp.PermissionOption[] = [
    { optionId: "accept", name: "Accept", kind: "allow_once" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
];

type PersistValue = "session" | "always";
type ToolApprovalPersistValue = PersistValue | "once";

type McpElicitationContext = {
    isToolApproval: boolean;
    persistOptions: Set<PersistValue>;
    correlatedCallId: string | undefined;
};
type AcpBackedMcpElicitationParams = Extract<
    McpServerElicitationRequestParams,
    { mode: "form" } | { mode: "url" }
>;

const USER_INPUT_OTHER_FIELD_SUFFIX = "__other";

/**
 * Parses the `persist` field from the elicitation request `_meta`.
 * Codex advertises which persistence options the client should show.
 * Returns a set of supported persist values.
 */
function parsePersistOptions(meta: unknown): Set<PersistValue> {
    const result = new Set<PersistValue>();
    if (!meta || typeof meta !== "object") return result;
    const persist = (meta as Record<string, unknown>)["persist"];
    if (persist === "session") {
        result.add("session");
    } else if (persist === "always") {
        result.add("always");
    } else if (Array.isArray(persist)) {
        if (persist.includes("session")) result.add("session");
        if (persist.includes("always")) result.add("always");
    }
    return result;
}

function isMcpToolCallApproval(meta: unknown): boolean {
    return (
        meta !== null &&
        typeof meta === "object" &&
        (meta as Record<string, unknown>)["codex_approval_kind"] === "mcp_tool_call"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): JsonValue {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (Array.isArray(value)) {
        return value.map(normalizeJsonValue);
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, nested]) => nested !== undefined)
                .map(([key, nested]) => [key, normalizeJsonValue(nested)])
        );
    }
    return String(value);
}

function normalizeJsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .map(([key, nested]) => [key, normalizeJsonValue(nested)])
    );
}

function normalizeElicitationSchema(value: unknown): acp.ElicitationSchema {
    const normalized = normalizeElicitationSchemaValue(value);
    if (!isRecord(normalized)) {
        return { type: "object", properties: {} };
    }

    return {
        ...normalized,
        type: "object",
    } as acp.ElicitationSchema;
}

function normalizeElicitationSchemaValue(value: unknown): unknown {
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (Array.isArray(value)) {
        return value.map(normalizeElicitationSchemaValue);
    }
    if (!isRecord(value)) {
        return value;
    }

    const result: Record<string, unknown> = Object.fromEntries(
        Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .map(([key, nested]) => [key, normalizeElicitationSchemaValue(nested)])
    );

    if (
        result["type"] === "string" &&
        Array.isArray(result["enum"]) &&
        Array.isArray(result["enumNames"]) &&
        !Array.isArray(result["oneOf"])
    ) {
        const values = result["enum"];
        const names = result["enumNames"];
        result["oneOf"] = values.map((value, index) => ({
            const: String(value),
            title: String(names[index] ?? value),
        }));
        delete result["enum"];
        delete result["enumNames"];
    }

    return result;
}

function metaRecord(meta: unknown): Record<string, unknown> | null {
    return isRecord(meta) ? meta : null;
}

function persistChoiceOption(value: ToolApprovalPersistValue): acp.EnumOption {
    switch (value) {
        case "once":
            return { const: "once", title: "Allow once" };
        case "session":
            return { const: "session", title: "Allow for this session" };
        case "always":
            return { const: "always", title: "Allow and don't ask again" };
    }
}

function addPersistChoiceToSchema(
    schema: acp.ElicitationSchema,
    persistOptions: Set<PersistValue>
): acp.ElicitationSchema {
    if (persistOptions.size === 0) {
        return schema;
    }

    const choices: ToolApprovalPersistValue[] = ["once"];
    if (persistOptions.has("session")) choices.push("session");
    if (persistOptions.has("always")) choices.push("always");

    return {
        ...schema,
        properties: {
            ...schema.properties,
            persist: {
                type: "string",
                title: "Approval scope",
                oneOf: choices.map(persistChoiceOption),
                default: "once",
            },
        },
        required: Array.from(new Set([...(schema.required ?? []), "persist"])),
    };
}

function contentRecord(content: unknown): Record<string, acp.ElicitationContentValue> {
    return isRecord(content) ? content as Record<string, acp.ElicitationContentValue> : {};
}

function jsonObjectOrNull(
    content: Record<string, acp.ElicitationContentValue>
): JsonValue | null {
    const entries = Object.entries(content);
    if (entries.length === 0) {
        return null;
    }
    return Object.fromEntries(entries.map(([key, value]) => [key, normalizeJsonValue(value)]));
}

function elicitationResponseMeta(
    response: acp.CreateElicitationResponse,
    context: McpElicitationContext,
    persist: unknown = undefined
): JsonValue | null {
    const responseMeta = metaRecord(response._meta);
    const meta = responseMeta ? normalizeJsonObject(responseMeta) : {};
    if (context.isToolApproval) {
        delete meta["persist"];
    }
    if (persist === "session" || persist === "always") {
        meta["persist"] = persist;
    }
    return Object.keys(meta).length === 0 ? null : meta;
}

function userInputOtherFieldId(questionId: string, questionIds: Set<string>): string {
    const base = `${questionId}${USER_INPUT_OTHER_FIELD_SUFFIX}`;
    if (!questionIds.has(base)) {
        return base;
    }

    let index = 1;
    while (questionIds.has(`${base}${index}`)) {
        index += 1;
    }
    return `${base}${index}`;
}

function userInputResponseValue(
    content: Record<string, acp.ElicitationContentValue>,
    fieldId: string
): acp.ElicitationContentValue | undefined {
    const value = content[fieldId];
    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }
    if (Array.isArray(value) && value.length === 0) {
        return undefined;
    }
    return value;
}

/**
 * Builds the ACP permission options for an MCP tool call approval elicitation.
 * Always includes "Allow Once"; adds session/always persist options when advertised.
 */
function buildToolApprovalOptions(persistOptions: Set<PersistValue>): acp.PermissionOption[] {
    const options: acp.PermissionOption[] = [
        { optionId: McpApprovalOptionId.AllowOnce, name: "Allow", kind: "allow_once" },
    ];
    if (persistOptions.has("session")) {
        options.push({ optionId: McpApprovalOptionId.AllowSession, name: "Allow for This Session", kind: "allow_always" });
    }
    if (persistOptions.has("always")) {
        options.push({ optionId: McpApprovalOptionId.AllowAlways, name: "Allow and Don't Ask Again", kind: "allow_always" });
    }
    options.push({ optionId: McpApprovalOptionId.Decline, name: "Decline", kind: "reject_once" });
    return options;
}

export class CodexElicitationHandler implements ElicitationHandler {
    private readonly connection: AcpClientConnection;
    private readonly sessionState: SessionState;
    private readonly clientCapabilities: acp.ClientCapabilities | null;
    private readonly cancellationSignal: AbortSignal | undefined;
    // In Rust, the MCP elicitation handler receives ElicitationRequestEvent directly from the MCP
    // protocol layer, where id is set to "mcp_tool_call_approval_<call_id>" — the call ID is extracted
    // by stripping that prefix.
    //
    // In TypeScript, Codex speaks the app-server JSON-RPC protocol (v2), where
    // McpServerElicitationRequestParams omits elicitationId for form mode, so the MCP-level ID never
    // reaches the client.
    //
    // Workaround: before requesting approval, Codex emits an item/started notification with an
    // mcpToolCall item carrying the call id and server name. We store (threadId, serverName) → callId
    // here so the elicitation request can correlate back to the already-rendered tool call item.
    //
    // Multiple calls are safe because Codex requests approval synchronously — it blocks on one tool
    // call's elicitation before starting the next, so there is at most one pending approval per
    // (threadId, serverName).
    private readonly pendingMcpApprovals = new Map<string, string>();
    // The app-server handler exposes URL elicitationId, while serverRequest/resolved only exposes
    // threadId here, so accepted URL elicitations are completed at thread scope.
    private readonly pendingUrlElicitations = new Map<string, Set<string>>();

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        clientCapabilities: acp.ClientCapabilities | null = null,
        cancellationSignal?: AbortSignal
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.clientCapabilities = clientCapabilities;
        this.cancellationSignal = cancellationSignal;
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        switch (notification.method) {
            case "item/started":
                this.handleItemStarted(notification.params);
                return;
            case "item/completed":
                this.handleItemCompleted(notification.params);
                return;
            case "serverRequest/resolved":
                this.clearThread(notification.params.threadId);
                await this.completeUrlElicitations(notification.params.threadId);
                return;
            default:
                return;
        }
    }

    async handleElicitation(
        params: McpServerElicitationRequestParams
    ): Promise<McpServerElicitationRequestResponse> {
        try {
            const context = this.createMcpElicitationContext(params);
            if (this.shouldUseAcpElicitation(params)) {
                const response = await this.connection.request(
                    acp.methods.client.elicitation.create,
                    this.buildElicitationRequest(params, context),
                    this.requestOptions(),
                );
                const result = this.convertElicitationResponse(response, context);
                if (params.mode === "url" && result.action === "accept") {
                    this.trackUrlElicitation(params.threadId, params.elicitationId);
                }
                await this.publishAcceptedMcpToolApproval(context, result.action === "accept");
                return result;
            }

            const { request, correlatedCallId } = this.buildPermissionRequest(params, context);
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                request,
                this.requestOptions(),
            );
            if (correlatedCallId !== undefined && response.outcome.outcome !== "cancelled") {
                const optionId = response.outcome.optionId;
                if (optionId !== McpApprovalOptionId.Decline) {
                    await this.connection.notify(acp.methods.client.session.update, {
                        sessionId: this.sessionState.sessionId,
                        update: { sessionUpdate: "tool_call_update", toolCallId: correlatedCallId, status: "in_progress" },
                    });
                }
            }
            return this.convertPermissionResponse(response);
        } catch (error) {
            logger.error("Error handling MCP elicitation request", error);
            return { action: "cancel", content: null, _meta: null };
        }
    }

    async handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        if (!clientSupportsFormElicitation(this.clientCapabilities)) {
            return { answers: {} };
        }

        try {
            const response = await this.requestUserInputElicitation(params);
            if (response === null) {
                return { answers: {} };
            }
            return this.convertUserInputResponse(response, params);
        } catch (error) {
            logger.error("Error handling Codex user input request", error);
            return { answers: {} };
        }
    }

    private requestOptions(
        cancellationSignal: AbortSignal | undefined = this.cancellationSignal
    ): acp.SendRequestOptions | undefined {
        return cancellationSignal ? {cancellationSignal} : undefined;
    }

    private async requestUserInputElicitation(
        params: ToolRequestUserInputParams
    ): Promise<acp.CreateElicitationResponse | null> {
        const request = this.buildUserInputRequest(params);
        if (params.autoResolutionMs === null) {
            return await this.connection.request(
                acp.methods.client.elicitation.create,
                request,
                this.requestOptions(),
            );
        }

        const abortController = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let removeAbortListener: (() => void) | undefined;
        const timeoutPromise = new Promise<null>((resolve) => {
            const resolveWithoutInput = () => {
                abortController.abort();
                resolve(null);
            };
            timeout = setTimeout(resolveWithoutInput, Math.max(0, params.autoResolutionMs ?? 0));
            if (this.cancellationSignal?.aborted) {
                resolveWithoutInput();
                return;
            }
            if (this.cancellationSignal) {
                this.cancellationSignal.addEventListener("abort", resolveWithoutInput, { once: true });
                removeAbortListener = () => {
                    this.cancellationSignal?.removeEventListener("abort", resolveWithoutInput);
                };
            }
        });
        const requestPromise = Promise.resolve(this.connection.request(
            acp.methods.client.elicitation.create,
            request,
            this.requestOptions(abortController.signal),
        ));
        void requestPromise.catch(() => {});

        try {
            return await Promise.race([requestPromise, timeoutPromise]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            removeAbortListener?.();
        }
    }

    private createMcpElicitationContext(params: McpServerElicitationRequestParams): McpElicitationContext {
        const isToolApproval = isMcpToolCallApproval(params._meta);
        const persistOptions = parsePersistOptions(params._meta);
        const correlatedCallId = isToolApproval && (params.mode === "form" || params.mode === "openai/form")
            ? this.popPendingApproval(params.threadId, params.serverName)
            : undefined;
        return { isToolApproval, persistOptions, correlatedCallId };
    }

    private shouldUseAcpElicitation(
        params: McpServerElicitationRequestParams
    ): params is AcpBackedMcpElicitationParams {
        switch (params.mode) {
            case "form":
                return clientSupportsFormElicitation(this.clientCapabilities);
            case "url":
                return clientSupportsUrlElicitation(this.clientCapabilities);
            case "openai/form":
                return false;
        }
    }

    private buildElicitationRequest(
        params: AcpBackedMcpElicitationParams,
        context: McpElicitationContext
    ): acp.CreateElicitationRequest {
        const base = {
            sessionId: this.sessionState.sessionId,
            ...(context.correlatedCallId ? { toolCallId: context.correlatedCallId } : {}),
            message: params.message,
            _meta: metaRecord(params._meta),
        };

        switch (params.mode) {
            case "form": {
                const requestedSchema = context.isToolApproval
                    ? addPersistChoiceToSchema(
                        normalizeElicitationSchema(params.requestedSchema),
                        context.persistOptions,
                    )
                    : normalizeElicitationSchema(params.requestedSchema);
                return {
                    ...base,
                    mode: "form",
                    requestedSchema,
                };
            }
            case "url":
                return {
                    ...base,
                    mode: "url",
                    url: params.url,
                    elicitationId: params.elicitationId,
                };
        }
    }

    private buildUserInputRequest(params: ToolRequestUserInputParams): acp.CreateElicitationRequest {
        const properties: Record<string, acp.ElicitationPropertySchema> = {};
        const required: string[] = [];
        const questionIds = new Set(params.questions.map(question => question.id));

        for (const question of params.questions) {
            const options = question.options ?? [];
            const hasOptions = options.length > 0;
            const hasOtherAnswer = question.isOther && hasOptions;
            const base = {
                title: question.header || question.id,
                description: question.question,
                _meta: {
                    codex: {
                        isOther: question.isOther,
                        isSecret: question.isSecret,
                    },
                },
            };
            if (!hasOtherAnswer) {
                required.push(question.id);
            }
            properties[question.id] = hasOptions
                ? {
                    ...base,
                    type: "string",
                    oneOf: options.map(option => ({
                        const: option.label,
                        title: option.label,
                        description: option.description,
                    })),
                }
                : {
                    ...base,
                    type: "string",
                };
            if (hasOtherAnswer) {
                properties[userInputOtherFieldId(question.id, questionIds)] = {
                    type: "string",
                    title: "Other",
                    description: "Type your own answer instead of choosing an option above.",
                    _meta: {
                        codex: {
                            questionId: question.id,
                            isOtherAnswer: true,
                            isSecret: question.isSecret,
                        },
                    },
                };
            }
        }

        const firstQuestion = params.questions[0];
        return {
            sessionId: this.sessionState.sessionId,
            toolCallId: params.itemId,
            mode: "form",
            message: params.questions.length === 1 && firstQuestion
                ? firstQuestion.question
                : "Input requested",
            requestedSchema: {
                type: "object",
                properties,
                required,
            },
            _meta: {
                codex: {
                    autoResolutionMs: params.autoResolutionMs,
                },
            },
        };
    }

    private buildPermissionRequest(
        params: McpServerElicitationRequestParams,
        context: McpElicitationContext
    ): { request: acp.RequestPermissionRequest; correlatedCallId: string | undefined } {
        const sessionId = this.sessionState.sessionId;
        const messageContent: acp.ToolCallContent = {
            type: "content",
            content: { type: "text", text: params.message },
        };

        const options = context.isToolApproval
            ? buildToolApprovalOptions(context.persistOptions)
            : ELICITATION_OPTIONS;

        if (params.mode === "form" || params.mode === "openai/form") {
            if (context.correlatedCallId !== undefined) {
                // The tool call item is already visible in the IDE conversation history because
                // item/started was emitted before the elicitation request. Sending content or
                // rawInput here would duplicate that information in the approval widget.
                return {
                    request: {
                        sessionId,
                        toolCall: {
                            toolCallId: context.correlatedCallId,
                            kind: "execute",
                            status: "pending",
                            // content: [messageContent],   — omitted: already rendered via item/started
                            // rawInput: { ... }            — omitted: same reason
                        },
                        _meta: { is_mcp_tool_approval: true },
                        options,
                    },
                    correlatedCallId: context.correlatedCallId,
                };
            }
            return {
                request: {
                    sessionId,
                    toolCall: {
                        toolCallId: `elicitation-${params.serverName}`,
                        kind: context.isToolApproval ? "execute" : "other",
                        status: "pending",
                        content: [messageContent],
                        rawInput: { serverName: params.serverName, schema: params.requestedSchema },
                    },
                    ...(context.isToolApproval ? { _meta: { is_mcp_tool_approval: true } } : {}),
                    options,
                },
                correlatedCallId: undefined,
            };
        } else {
            return {
                request: {
                    sessionId,
                    toolCall: {
                        toolCallId: `elicitation-${params.elicitationId}`,
                        kind: "fetch",
                        status: "pending",
                        content: [messageContent],
                        rawInput: { serverName: params.serverName, url: params.url },
                    },
                    options,
                },
                correlatedCallId: undefined,
            };
        }
    }

    private convertPermissionResponse(
        response: acp.RequestPermissionResponse
    ): McpServerElicitationRequestResponse {
        if (response.outcome.outcome === "cancelled") {
            return { action: "cancel", content: null, _meta: null };
        }

        const optionId = response.outcome.optionId;
        if (optionId === McpApprovalOptionId.AllowSession) {
            return { action: "accept", content: null, _meta: { persist: "session" } };
        }
        if (optionId === McpApprovalOptionId.AllowAlways) {
            return { action: "accept", content: null, _meta: { persist: "always" } };
        }
        if (optionId === McpApprovalOptionId.AllowOnce || optionId === "accept") {
            return { action: "accept", content: null, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
    }

    private convertElicitationResponse(
        response: acp.CreateElicitationResponse,
        context: McpElicitationContext
    ): McpServerElicitationRequestResponse {
        if (acp.CreateElicitationResponse.isAccept(response)) {
            const content = contentRecord(response.content);
            const persist = context.isToolApproval ? content["persist"] : undefined;
            if (persist === "session" || persist === "always" || persist === "once") {
                delete content["persist"];
            }
            return {
                action: "accept",
                content: jsonObjectOrNull(content),
                _meta: elicitationResponseMeta(response, context, persist),
            };
        }

        if (acp.CreateElicitationResponse.isDecline(response)) {
            return { action: "decline", content: null, _meta: elicitationResponseMeta(response, context) };
        }

        if (acp.CreateElicitationResponse.isCancel(response)) {
            return { action: "cancel", content: null, _meta: elicitationResponseMeta(response, context) };
        }

        if (acp.CreateElicitationResponse.isCustom(response)) {
            return { action: "cancel", content: null, _meta: null };
        }

        // Malformed known variants match none of the SDK guards.
        return { action: "cancel", content: null, _meta: null };
    }

    private convertUserInputResponse(
        response: acp.CreateElicitationResponse,
        params: ToolRequestUserInputParams
    ): ToolRequestUserInputResponse {
        if (!acp.CreateElicitationResponse.isAccept(response)) {
            return { answers: {} };
        }

        const answers: ToolRequestUserInputResponse["answers"] = {};
        const content = contentRecord(response.content);
        const questionIds = new Set(params.questions.map(question => question.id));
        for (const question of params.questions) {
            const value = question.isOther && question.options != null && question.options.length > 0
                ? userInputResponseValue(content, userInputOtherFieldId(question.id, questionIds))
                    ?? userInputResponseValue(content, question.id)
                : userInputResponseValue(content, question.id);
            if (value === undefined) {
                continue;
            }
            answers[question.id] = {
                answers: Array.isArray(value)
                    ? value.map(String)
                    : [String(value)],
            };
        }
        return { answers };
    }

    private async publishAcceptedMcpToolApproval(
        context: McpElicitationContext,
        accepted: boolean
    ): Promise<void> {
        if (!accepted || context.correlatedCallId === undefined) {
            return;
        }
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId: this.sessionState.sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: context.correlatedCallId, status: "in_progress" },
        });
    }

    private trackUrlElicitation(threadId: string, elicitationId: string): void {
        const existing = this.pendingUrlElicitations.get(threadId);
        if (existing) {
            existing.add(elicitationId);
            return;
        }
        this.pendingUrlElicitations.set(threadId, new Set([elicitationId]));
    }

    private async completeUrlElicitations(threadId: string): Promise<void> {
        const elicitationIds = this.pendingUrlElicitations.get(threadId);
        if (!elicitationIds) {
            return;
        }
        this.pendingUrlElicitations.delete(threadId);
        for (const elicitationId of elicitationIds) {
            await this.connection.notify(acp.methods.client.elicitation.complete, {
                elicitationId,
            });
        }
    }

    private handleItemStarted(event: ItemStartedNotification): void {
        if (event.item.type !== "mcpToolCall") {
            return;
        }
        this.pendingMcpApprovals.set(this.key(event.threadId, event.item.server), event.item.id);
    }

    private handleItemCompleted(event: ItemCompletedNotification): void {
        if (event.item.type !== "mcpToolCall") {
            return;
        }
        // This may run after the elicitation path already consumed the same entry.
        // That double-pop is intentional: approvals pop on request correlation, while
        // auto-approved or interrupted calls need completion-side cleanup.
        this.popPendingApproval(event.threadId, event.item.server);
    }

    private popPendingApproval(threadId: string, serverName: string): string | undefined {
        const key = this.key(threadId, serverName);
        const callId = this.pendingMcpApprovals.get(key);
        this.pendingMcpApprovals.delete(key);
        return callId;
    }

    private clearThread(threadId: string): void {
        for (const key of this.pendingMcpApprovals.keys()) {
            if (this.belongsToThread(key, threadId)) {
                this.pendingMcpApprovals.delete(key);
            }
        }
    }

    private key(threadId: string, serverName: string): string {
        return `${threadId}:${serverName}`;
    }

    private belongsToThread(key: string, threadId: string): boolean {
        return key.startsWith(`${threadId}:`);
    }
}
