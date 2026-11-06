import * as acp from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
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
import {type AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";
import {toV2CreateElicitationResponse} from "./AcpV2Elicitation";
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
import {AcpToolCallRenderer} from "./tool-calls/AcpToolCallRenderer";
import {subagentInteractionSignal, subagentToolCallId, withSubagentUserAction} from "./subagents/SubagentInteraction";
import {ElicitationReporter} from "./tool-calls/reporters/ElicitationReporter";
import {isRecord, normalizeJsonObject, normalizeJsonValue, recordOrNull} from "./permissions/json";
import {AIR_CUSTOM_ANSWER_KEY, LEGACY_AIR_CUSTOM_ANSWER_KEY, isAirClient, withAirMeta} from "./AirExtension";
type AcpBackedMcpElicitationParams = Extract<
    McpServerElicitationRequestParams,
    { mode: "form" } | { mode: "url" }
>;

const USER_INPUT_NOTE_FIELD_SUFFIX = "_note";
const USER_INPUT_OTHER_OPTION = "None of the above";
const USER_INPUT_NOTE_PREFIX = "user_note: ";

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

function contentRecord(content: unknown): Record<string, unknown> {
    return isRecord(content) ? content : {};
}

function jsonObjectOrNull(
    content: Record<string, unknown>
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

function userInputNoteFieldId(questionId: string, questionIds: ReadonlySet<string>): string {
    const base = `${questionId}${USER_INPUT_NOTE_FIELD_SUFFIX}`;
    let fieldId = base;
    let index = 1;
    while (questionIds.has(fieldId)) {
        fieldId = `${base}${index++}`;
    }
    return fieldId;
}

/** The text that AIR sends in a choice field when the user types an own answer instead of choosing an option. */
function typedChoiceAnswer(
    value: unknown,
    question: UserInputQuestion,
): string | undefined {
    if (typeof value !== "string" || value === USER_INPUT_OTHER_OPTION) {
        return undefined;
    }
    return question.options?.some(option => option.label === value) ? undefined : value;
}

function userInputResponseValue(
    content: Record<string, unknown>,
    fieldId: string
): string | string[] | undefined {
    const value = content[fieldId];
    if (typeof value === "string") {
        return value.trim() === "" ? undefined : value;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string")) {
        return value;
    }
    return undefined;
}

type UserInputQuestion = ToolRequestUserInputParams["questions"][number];

/**
 * The form for Codex user input questions: one field per question, and a note field for a question that
 * accepts an own answer.
 */
export function buildUserInputSchema(
    questions: readonly UserInputQuestion[],
    clientCapabilities: acp.ClientCapabilities | null,
    answersRequired: boolean,
): acp.ElicitationSchema {
    const properties: Record<string, acp.ElicitationPropertySchema> = {};
    const required: string[] = [];
    const questionIds = new Set(questions.map(question => question.id));
    const airClient = isAirClient(clientCapabilities);

    for (const question of questions) {
        const options = question.options ?? [];
        const hasOptions = options.length > 0;
        const hasOtherAnswer = question.isOther && hasOptions;
        const base = {
            title: question.question || question.header || question.id,
            ...(question.header ? { description: question.header } : {}),
            _meta: {
                codex: {
                    isOther: question.isOther,
                    isSecret: question.isSecret,
                },
            },
        };
        if (answersRequired) {
            required.push(question.id);
        }
        properties[question.id] = hasOptions
            ? {
                ...base,
                type: "string",
                oneOf: [
                    ...options.map(option => ({
                        const: option.label,
                        title: option.label,
                        ...(option.description ? { description: option.description } : {}),
                    })),
                    ...(hasOtherAnswer && !airClient && !options.some(option => option.label === USER_INPUT_OTHER_OPTION) ? [{
                        const: USER_INPUT_OTHER_OPTION,
                        title: USER_INPUT_OTHER_OPTION,
                        description: "Provide a different answer in the note field.",
                    }] : []),
                ],
            }
            : {
                ...base,
                type: "string",
            };
        if (hasOtherAnswer) {
            const noteMeta = {
                codex: {
                    questionId: question.id,
                    role: "user_note",
                    isSecret: question.isSecret,
                },
            };
            properties[userInputNoteFieldId(question.id, questionIds)] = {
                type: "string",
                title: "Additional answer or note",
                _meta: airClient
                    ? withAirMeta({...noteMeta, [LEGACY_AIR_CUSTOM_ANSWER_KEY]: true}, AIR_CUSTOM_ANSWER_KEY, true)
                    : noteMeta,
            };
        }
    }

    return {
        type: "object",
        properties,
        ...(answersRequired ? {required} : {}),
    };
}

function buildUserInputRequest(
    params: ToolRequestUserInputParams,
    clientCapabilities: acp.ClientCapabilities | null,
): acp.CreateElicitationRequest {
    return {
        sessionId: params.threadId,
        toolCallId: params.itemId,
        mode: "form",
        message: "Codex needs your input to continue.",
        requestedSchema: buildUserInputSchema(params.questions, clientCapabilities, true),
        _meta: {
            codex: {
                autoResolutionMs: params.autoResolutionMs,
            },
        },
    };
}

/**
 * The answers in a response to the form of {@link buildUserInputSchema}, in Codex's `request_user_input` shape:
 * a chosen option, "None of the above" for an own answer, and notes prefixed with `user_note: `.
 */
export function userInputAnswers(
    rawResponse: acp.CreateElicitationResponse,
    questions: readonly UserInputQuestion[],
    clientCapabilities: acp.ClientCapabilities | null,
): ToolRequestUserInputResponse["answers"] {
    const response = toV2CreateElicitationResponse(rawResponse);
    // v2 allows arbitrary JSON values. Validate answers per property, not with the narrower v1 union.
    if (!acpV2.CreateElicitationResponse.isAccept(response)) {
        return {};
    }

    const answers: ToolRequestUserInputResponse["answers"] = {};
    const content = contentRecord(response.content);
    const questionIds = new Set(questions.map(question => question.id));
    const airClient = isAirClient(clientCapabilities);
    for (const question of questions) {
        const answerValues: string[] = [];
        const hasOtherAnswer = question.isOther && question.options != null && question.options.length > 0;
        const value = userInputResponseValue(content, question.id);
        const typedAnswer = airClient && hasOtherAnswer ? typedChoiceAnswer(value, question) : undefined;
        if (typedAnswer !== undefined) {
            answerValues.push(USER_INPUT_OTHER_OPTION, `${USER_INPUT_NOTE_PREFIX}${typedAnswer.trim()}`);
        } else if (value !== undefined) {
            answerValues.push(...(Array.isArray(value) ? value.map(String) : [String(value)]));
        }
        if (hasOtherAnswer) {
            const note = userInputResponseValue(content, userInputNoteFieldId(question.id, questionIds));
            if (note !== undefined) {
                const notes = Array.isArray(note) ? note : [note];
                answerValues.push(...notes.map(item => `${USER_INPUT_NOTE_PREFIX}${String(item).trim()}`));
            }
        }
        if (answerValues.length === 0) {
            continue;
        }
        answers[question.id] = {
            answers: answerValues,
        };
    }
    return answers;
}

/** One question's {@link userInputAnswers} as plain text: the chosen option and notes, without the markers. */
export function userInputAnswerText(answers: readonly string[]): string {
    return answers
        .filter(answer => answer !== USER_INPUT_OTHER_OPTION)
        .map(answer => answer.startsWith(USER_INPUT_NOTE_PREFIX) ? answer.slice(USER_INPUT_NOTE_PREFIX.length) : answer)
        .filter(answer => answer.trim().length > 0)
        .join("\n\n");
}

export class CodexElicitationHandler implements ElicitationHandler {
    private readonly connection: AcpClientConnection;
    private readonly renderer: AcpToolCallRenderer;
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
        clientCapabilities: acp.ClientCapabilities | null,
        cancellationSignal: AbortSignal | undefined,
        renderer: AcpToolCallRenderer,
    ) {
        this.renderer = renderer;
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
        const signal = subagentInteractionSignal(params.threadId, this.cancellationSignal);
        try {
            const context = this.createMcpElicitationContext(params);
            if (this.shouldUseAcpElicitation(params)) {
                const response = await withSubagentUserAction(params.threadId, () => this.connection.request(
                    acp.methods.client.elicitation.create,
                    this.buildElicitationRequest(params, context),
                    this.requestOptions(signal),
                ));
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
                () => subagentToolCallId(params.threadId, params.serverName)
                    ?? this.permissionContext.nextStandaloneMcpToolCallId(params.serverName),
                this.renderer,
            );
            const response = await withSubagentUserAction(params.threadId, () => this.connection.request(
                acp.methods.client.session.requestPermission,
                request,
                this.requestOptions(signal),
            ), request.toolCall.toolCallId);
            const result = convertMcpPermissionResponse(
                response,
                context.isToolApproval,
                context.persistOptions,
            );
            if (correlatedCallId !== undefined) {
                if (result.action === "accept") {
                    await this.connection.notify(acp.methods.client.session.update, {
                        sessionId: params.threadId,
                        update: this.renderer.render(ElicitationReporter.accepted(correlatedCallId)),
                    });
                }
            } else {
                try {
                    await this.connection.notify(acp.methods.client.session.update, {
                        sessionId: params.threadId,
                        update: this.renderer.render(
                            ElicitationReporter.answered(request.toolCall.toolCallId, result.action),
                        ),
                    });
                } catch (error) {
                    logger.error("Failed to finalize standalone MCP elicitation tool call", error);
                }
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
            return {answers: userInputAnswers(response, params.questions, this.clientCapabilities)};
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
        const request = buildUserInputRequest(params, this.clientCapabilities);
        const signal = subagentInteractionSignal(params.threadId, this.cancellationSignal);
        if (params.autoResolutionMs === null) {
            return await withSubagentUserAction(params.threadId, () => this.connection.request(
                acp.methods.client.elicitation.create,
                request,
                this.requestOptions(signal),
            ), params.itemId);
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
            if (signal?.aborted) {
                resolveWithoutInput();
                return;
            }
            if (signal) {
                signal.addEventListener("abort", resolveWithoutInput, { once: true });
                removeAbortListener = () => {
                    signal.removeEventListener("abort", resolveWithoutInput);
                };
            }
        });
        const requestPromise = withSubagentUserAction(params.threadId, () => this.connection.request(
            acp.methods.client.elicitation.create,
            request,
            this.requestOptions(abortController.signal),
        ), params.itemId, abortController.signal);
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

    private convertElicitationResponse(
        rawResponse: acp.CreateElicitationResponse,
        context: McpElicitationContext
    ): McpServerElicitationRequestResponse {
        // v1 still rejects content outside its narrower wire union.
        if (AcpV2Connection.of(this.connection) === null && rawResponse.action === "accept"
            && !acp.CreateElicitationResponse.isAccept(rawResponse)) {
            return {action: "cancel", content: null, _meta: null};
        }
        const response = toV2CreateElicitationResponse(rawResponse);
        if (acpV2.CreateElicitationResponse.isAccept(response)) {
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

        if (acpV2.CreateElicitationResponse.isDecline(response)) {
            return context.isToolApproval
                ? {action: "cancel", content: null, _meta: elicitationResponseMeta(response, context)}
                : {action: "decline", content: null, _meta: elicitationResponseMeta(response, context)};
        }

        if (acpV2.CreateElicitationResponse.isCancel(response)) {
            return { action: "cancel", content: null, _meta: elicitationResponseMeta(response, context) };
        }

        if (acpV2.CreateElicitationResponse.isCustom(response)) {
            return { action: "cancel", content: null, _meta: null };
        }

        // Malformed known variants match none of the SDK guards.
        return { action: "cancel", content: null, _meta: null };
    }

    private isAllowedToolApprovalPersist(
        persist: unknown,
        persistOptions: ReadonlySet<PersistValue>,
    ): boolean {
        return persist === undefined
            || persist === "once"
            || (persist === "session" && persistOptions.has("session"))
            || (persist === "always" && persistOptions.has("always"));
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
            update: this.renderer.render(ElicitationReporter.accepted(context.correlatedCallId)),
        });
    }

    /**
     * Completes every accepted URL elicitation: the app-server died and will never resolve them, so the client must
     * not keep their flow open.
     */
    async completeAllUrlElicitations(): Promise<void> {
        for (const threadId of [...this.pendingUrlElicitations.keys()]) {
            await this.completeUrlElicitations(threadId);
        }
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
