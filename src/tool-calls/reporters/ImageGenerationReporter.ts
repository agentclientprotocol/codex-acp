import type * as acp from "@agentclientprotocol/sdk";
import type {ThreadItem} from "../../app-server/v2";
import {textContent} from "../AcpToolCallRenderer";
import type {StandardToolCallFields, ToolFacts} from "../ToolFacts";

type ImageGenerationItem = ThreadItem & {type: "imageGeneration"};

const TITLE = "Image generation";

/**
 * Reports a Codex image generation.
 * The revised prompt and the image, with the saved path as its URI, are the result. Each goes once to `content`.
 */
export class ImageGenerationReporter {
    static started(item: ImageGenerationItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            kind: "other",
            title: TITLE,
            status: "in_progress",
            standard: {rawInput: {id: item.id}},
        };
    }

    static completed(item: ImageGenerationItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            status: terminalStatus(item.status),
            result: imageResult(item),
            standard: standardResult(item),
        };
    }

    /**
     * The only report of a finished generation whose start the adapter did not see, for example in the history.
     * The item is finished, so a provider status such as `generating` becomes `completed`.
     */
    static whole(item: ImageGenerationItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            kind: "other",
            title: TITLE,
            status: terminalStatus(item.status),
            result: imageResult(item),
            standard: standardResult(item),
        };
    }
}

/**
 * A client that is not AIR gets the image only when Codex sent its data, and the item fields in `rawOutput`.
 */
function standardResult(item: ImageGenerationItem): StandardToolCallFields {
    const rawOutput: Record<string, string | null> = {
        status: item.status,
        revisedPrompt: item.revisedPrompt,
        result: item.result,
    };
    if ("savedPath" in item) rawOutput["savedPath"] = item.savedPath ?? null;
    return {
        content: imageResult(item)
            .filter(content => content.type !== "content" || content.content.type !== "resource_link"),
        rawOutput,
    };
}

function imageResult(item: ImageGenerationItem): acp.ToolCallContent[] {
    const result: acp.ToolCallContent[] = [];
    if (item.revisedPrompt && item.revisedPrompt.trim() !== "") {
        result.push(textContent(`Revised prompt: ${item.revisedPrompt}`));
    }
    const savedPath = item.savedPath && item.savedPath.trim() !== "" ? item.savedPath : undefined;
    if (item.result.trim() !== "") {
        result.push({
            type: "content",
            content: {
                type: "image",
                data: item.result,
                mimeType: "image/png",
                ...(savedPath === undefined ? {} : {uri: savedPath}),
            },
        });
    } else if (savedPath !== undefined) {
        result.push({type: "content", content: {type: "resource_link", name: savedPath, uri: savedPath}});
    }
    return result;
}

function terminalStatus(status: string): acp.ToolCallStatus {
    return status === "failed" ? "failed" : "completed";
}
