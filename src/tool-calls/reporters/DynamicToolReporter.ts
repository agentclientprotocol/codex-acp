import type * as acp from "@agentclientprotocol/sdk";
import type {DynamicToolCallOutputContentItem, ThreadItem} from "../../app-server/v2";
import {functionToolName} from "../../ToolCallName";
import type {ToolFacts} from "../ToolFacts";
import {toToolStatus} from "./ToolStatus";

type DynamicToolCallItem = ThreadItem & {type: "dynamicToolCall"};

/** Reports a client-defined dynamic tool call. Its content items are the result. The success flag is the status. */
export class DynamicToolReporter {
    static started(item: DynamicToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            name: functionToolName(item.tool, item.namespace),
            kind: "execute",
            title: item.tool,
            status: toToolStatus(item.status),
            input: {arguments: item.arguments},
            ...resultFacts(item),
        };
    }

    static completed(item: DynamicToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            name: functionToolName(item.tool, item.namespace),
            status: item.status === "completed" ? "completed" : "failed",
            ...resultFacts(item),
        };
    }
}

function resultFacts(item: DynamicToolCallItem): Pick<ToolFacts, "result"> {
    if (item.contentItems === null) return {};
    return {result: item.contentItems.map(contentItem => ({type: "content", content: displayBlock(contentItem)}))};
}

function displayBlock(item: DynamicToolCallOutputContentItem): acp.ContentBlock {
    switch (item.type) {
        case "inputText":
            return {type: "text", text: item.text};
        case "inputImage":
            return {type: "resource_link", uri: item.imageUrl, name: "image"};
        case "inputAudio":
            return {type: "resource_link", uri: item.audioUrl, name: "audio"};
    }
}
