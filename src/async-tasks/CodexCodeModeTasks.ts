import type {ServerNotification} from "../app-server";
import type {ResponseItem} from "../app-server/ResponseItem";
import type {FunctionCallOutputBody} from "../app-server/FunctionCallOutputBody";
import type {ACPSessionConnection} from "../ACPSessionConnection";
import {AcpToolCallRenderer, textContent} from "../tool-calls/AcpToolCallRenderer";
import type {ClientCapabilities} from "../tool-calls/ClientCapabilities";
import {functionToolName} from "../ToolCallName";

type CodeCall = {
    threadId: string;
    sessionId: string;
    id: string;
    name: string;
    input: Record<string, unknown>;
    cellId: string | null;
    status: "in_progress" | "completed" | "failed";
    outputs: FunctionCallOutputBody[];
    seen: Set<string>;
};

/** Code-mode cells have no native item lifecycle. Raw results report their cell IDs and completion headers. */
export class CodexCodeModeTasks {
    private readonly calls = new Map<string, CodeCall>();
    private readonly renderer: AcpToolCallRenderer;

    constructor(
        private readonly session: ACPSessionConnection,
        capabilities: ClientCapabilities,
    ) {
        this.renderer = new AcpToolCallRenderer(capabilities);
    }

    async handleNotification(notification: ServerNotification, sessionId: string): Promise<void> {
        if (notification.method !== "rawResponseItem/completed") return;
        const {threadId, item} = notification.params;
        switch (item.type) {
            case "custom_tool_call":
                if (item.name === "exec" && (!item.namespace || item.namespace === "functions")) {
                    await this.start(threadId, sessionId, item.call_id, item.name, {code: item.input}, item.namespace);
                }
                return;
            case "function_call":
                if (item.name === "wait" && (!item.namespace || item.namespace === "functions")) {
                    await this.start(threadId, sessionId, item.call_id, item.name, waitInput(item.arguments), item.namespace);
                }
                return;
            case "custom_tool_call_output":
            case "function_call_output":
                await this.output(threadId, item);
                return;
            case "additional_tools":
            case "message":
            case "agent_message":
            case "reasoning":
            case "local_shell_call":
            case "tool_search_call":
            case "tool_search_output":
            case "web_search_call":
            case "image_generation_call":
            case "compaction":
            case "configuration_update":
            case "compaction_trigger":
            case "context_compaction":
            case "other":
                return;
        }
    }

    private async start(
        threadId: string, sessionId: string, id: string, name: string,
        input: Record<string, unknown>, namespace?: string,
    ): Promise<void> {
        const key = this.key(threadId, id);
        if (this.calls.has(key)) return;
        const call: CodeCall = {
            threadId, sessionId, id, name, input, cellId: null,
            status: "in_progress", outputs: [], seen: new Set(),
        };
        this.calls.set(key, call);
        await this.session.update(this.renderer.render({
            toolCallId: id, report: "start", name: functionToolName(name, namespace),
            kind: name === "exec" ? "execute" : "other",
            title: name === "exec" ? "Run code" : "Wait for code", status: "in_progress", input,
        }), sessionId);
    }

    private async output(
        threadId: string, item: Extract<ResponseItem, {type: "custom_tool_call_output" | "function_call_output"}>,
    ): Promise<void> {
        if (!item.call_id) return;
        const call = this.calls.get(this.key(threadId, item.call_id));
        if (!call || item.id && call.seen.has(item.id)) return;
        if (item.id) call.seen.add(item.id);
        const text = outputText(item.output);
        if (call.name === "exec") {
            const cell = /^Script running with cell ID (\S+)/.exec(text)?.[1];
            if (cell && call.status === "in_progress") call.cellId = cell;
            call.status = completion(text) ?? (call.cellId === null ? "completed" : call.status);
        } else {
            call.status = completion(text) === "failed" ? "failed" : "completed";
        }
        call.outputs.push(item.output);
        await this.publish(call);
        await this.completeCell(call, text, item.output);
    }

    private async completeCell(call: CodeCall, text: string, output: FunctionCallOutputBody): Promise<void> {
        if (call.name !== "wait" || typeof call.input["cell_id"] !== "string") return;
        const status = completion(text);
        if (!status) return;
        const target = [...this.calls.values()].find(candidate => candidate.threadId === call.threadId
            && candidate.name === "exec" && candidate.cellId === call.input["cell_id"] && candidate.status === "in_progress");
        if (!target) return;
        target.status = status;
        target.outputs.push(output);
        await this.publish(target);
    }

    async finishAll(state: "completed" | "failed" | "stopped"): Promise<void> {
        for (const call of this.calls.values()) {
            if (call.status !== "in_progress") continue;
            call.status = state === "completed" ? "completed" : "failed";
            await this.publish(call);
        }
    }

    clear(): void { this.calls.clear(); }

    private async publish(call: CodeCall): Promise<void> {
        await this.session.update(this.renderer.render({
            toolCallId: call.id, report: "update", status: call.status,
            result: call.outputs.map(output => textContent(outputText(output))),
            opaqueResult: {outputs: call.outputs},
        }), call.sessionId);
        if (this.session.protocolVersion === 2) {
            await this.session.forSession(call.sessionId).setBackgroundItem({type: "tool_call", toolCallId: call.id},
                call.name === "exec" && call.cellId !== null && call.status === "in_progress");
        }
    }

    private key(threadId: string, callId: string): string { return JSON.stringify([threadId, callId]); }
}

function outputText(output: FunctionCallOutputBody): string {
    return typeof output === "string" ? output
        : output.filter(item => item.type === "input_text").map(item => item.text).join("\n");
}

function completion(text: string): "completed" | "failed" | undefined {
    if (/^Script completed\b/.test(text)) return "completed";
    if (/^Script (failed|terminated)\b/.test(text)) return "failed";
    return undefined;
}

function waitInput(argumentsText: string): Record<string, unknown> {
    try {
        const input: unknown = JSON.parse(argumentsText);
        if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
    } catch {
        // A malformed model call still has a visible input and result.
    }
    return {arguments: argumentsText};
}
