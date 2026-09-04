import * as acp from "@agentclientprotocol/sdk";
import type { ElicitationHandler } from "./CodexAppServerClient";
import type { ServerNotification } from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
} from "./app-server/v2";
import { logger } from "./Logger";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {
    clientSupportsFormElicitation,
    clientSupportsUrlElicitation,
} from "./ElicitationCapabilities";
import {
    buildMcpPermissionRequest,
    convertMcpPermissionResponse,
    isMcpToolCallApproval,
    parsePersistOptions,
    type PersistValue,
    type McpElicitationContext,
} from "./permissions/mcp";
import type {PermissionPromptContext} from "./permissions/lifecycle";
import {isRecord, normalizeJsonObject, normalizeJsonValue, recordOrNull} from "./permissions/json";
type AcpBackedMcpElicitationParams = Extract<
    McpServerElicitationRequestParams,
    { mode: "form" } | { mode: "url" }
>;

const USER_INPUT_OTHER_FIELD_SUFFIX = "__other";

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
    const responseMeta = recordOrNull(response._meta);
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

export class CodexElicitationHandler implements ElicitationHandler {
    private readonly connection: AcpClientConnection;
    private readonly permissionContext: PermissionPromptContext;
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
    // mcpToolCall item carrying the call id and server name. The shared permission lifecycle stores
    // (threadId, serverName) → callId so this request can correlate to the rendered tool call item.
    //
    // The app-server handler exposes URL elicitationId, while serverRequest/resolved only exposes
    // threadId here, so accepted URL elicitations are completed at thread scope.
    private readonly pendingUrlElicitations = new Map<string, Set<string>>();

    constructor(
        connection: AcpClientConnection,
        permissionContext: PermissionPromptContext,
        clientCapabilities: acp.ClientCapabilities | null = null,
        cancellationSignal?: AbortSignal
    ) {
        this.connection = connection;
        this.permissionContext = permissionContext;
        this.clientCapabilities = clientCapabilities;
        this.cancellationSignal = cancellationSignal;
    }

    async handleNotification(notification: ServerNotification): Promise<void> {
        switch (notification.method) {
            case "serverRequest/resolved":
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
                await this.publishAcceptedMcpToolApproval(params.threadId, context, result.action === "accept");
                return result;
            }
            if (!this.canUsePermissionFallback(params)) {
                return {action: "cancel", content: null, _meta: null};
            }

            const {request, correlatedCallId} = buildMcpPermissionRequest(
                params.threadId,
                params,
                context,
                () => this.permissionContext.nextStandaloneMcpToolCallId(params.serverName),
            );
            const response = await this.connection.request(
                acp.methods.client.session.requestPermission,
                request,
                this.requestOptions(),
            );
            const result = convertMcpPermissionResponse(
                response,
                context.isToolApproval,
                context.persistOptions,
            );
            if (correlatedCallId !== undefined && result.action === "accept") {
                await this.connection.notify(acp.methods.client.session.update, {
                    sessionId: params.threadId,
                    update: { sessionUpdate: "tool_call_update", toolCallId: correlatedCallId, status: "in_progress" },
                });
            }
            return result;
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
        const isToolApproval = isMcpToolCallApproval(params._meta) && this.isMessageOnlyForm(params);
        const persistOptions = parsePersistOptions(params._meta);
        const correlatedCallId = isToolApproval
            ? this.permissionContext.popPendingMcpApproval(params.threadId, params.serverName)
            : undefined;
        return {
            isToolApproval,
            persistOptions,
            correlatedCallId,
        };
    }

    private shouldUseAcpElicitation(
        params: McpServerElicitationRequestParams
    ): params is AcpBackedMcpElicitationParams {
        if (this.isMessageOnlyForm(params)) return false;
        switch (params.mode) {
            case "form":
                return clientSupportsFormElicitation(this.clientCapabilities);
            case "url":
                return clientSupportsUrlElicitation(this.clientCapabilities);
            case "openai/form":
            case "openaiForm":
                return false;
        }
    }

    private canUsePermissionFallback(params: McpServerElicitationRequestParams): boolean {
        return params.mode === "url" || this.isMessageOnlyForm(params);
    }

    private isMessageOnlyForm(params: McpServerElicitationRequestParams): boolean {
        if (params.mode !== "form" && params.mode !== "openai/form" && params.mode !== "openaiForm") return false;
        if (params.requestedSchema === null) return true;
        if (!isRecord(params.requestedSchema)) return false;
        return params.requestedSchema["type"] === "object"
            && isRecord(params.requestedSchema["properties"])
            && Object.keys(params.requestedSchema["properties"]).length === 0;
    }

    private buildElicitationRequest(
        params: AcpBackedMcpElicitationParams,
        context: McpElicitationContext
    ): acp.CreateElicitationRequest {
        const base = {
            sessionId: params.threadId,
            ...(context.correlatedCallId ? { toolCallId: context.correlatedCallId } : {}),
            message: params.message,
            _meta: recordOrNull(params._meta),
        };

        switch (params.mode) {
            case "form": {
                return {
                    ...base,
                    mode: "form",
                    requestedSchema: normalizeElicitationSchema(params.requestedSchema),
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
            sessionId: params.threadId,
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

    private convertElicitationResponse(
        response: acp.CreateElicitationResponse,
        context: McpElicitationContext
    ): McpServerElicitationRequestResponse {
        if (acp.CreateElicitationResponse.isAccept(response)) {
            const content = contentRecord(response.content);
            const persist = context.isToolApproval ? content["persist"] : undefined;
            if (context.isToolApproval && !this.isAllowedToolApprovalPersist(persist, context.persistOptions)) {
                return { action: "cancel", content: null, _meta: null };
            }
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
            return context.isToolApproval
                ? {action: "cancel", content: null, _meta: elicitationResponseMeta(response, context)}
                : {action: "decline", content: null, _meta: elicitationResponseMeta(response, context)};
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

    private isAllowedToolApprovalPersist(
        persist: acp.ElicitationContentValue | undefined,
        persistOptions: ReadonlySet<PersistValue>,
    ): boolean {
        return persist === undefined
            || persist === "once"
            || (persist === "session" && persistOptions.has("session"))
            || (persist === "always" && persistOptions.has("always"));
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
        sessionId: string,
        context: McpElicitationContext,
        accepted: boolean
    ): Promise<void> {
        if (!accepted || context.correlatedCallId === undefined) {
            return;
        }
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId,
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

}
