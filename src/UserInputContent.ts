import * as acp from "@agentclientprotocol/sdk/unstable";
import type {UserInput} from "./app-server/v2";
import {attachmentFileUri, desktopAttachmentHistory} from "./DesktopAttachmentHistory";
import {renderAsyncQuestionReply} from "./CodexAsyncQuestions";

/**
 * The content blocks that history replay sends for one persisted user message.
 *
 * One conversion for both readers of a stored prompt: the history replay, which
 * sends these blocks to the client, and the rewind, which fingerprints the text
 * the client was sent. Two conversions would make a prompt the client shows one
 * way and the rewind hashes another, and the rewind would then miss it.
 */
export function userMessageContentBlocks(content: UserInput[]): acp.ContentBlock[] {
    const contentBlocks = content.map(userInputToContentBlocks);
    // A native attachment that the Desktop envelope of a text input already lists is sent once.
    const attachmentUris = new Set(contentBlocks.flatMap((blocks, index) =>
        content[index]?.type === "text"
            ? blocks.flatMap(block => block.type === "resource_link" ? [block.uri] : [])
            : []));
    return content.flatMap((input, index) => {
        const nativePath = input.type === "localImage" || input.type === "localAudio" || input.type === "mention"
            ? input.path
            : (input.type === "image" || input.type === "audio") && "url" in input ? input.url : null;
        return nativePath !== null && attachmentUris.has(attachmentFileUri(nativePath) ?? "") ? [] : contentBlocks[index]!;
    });
}

/** The content blocks of one persisted user input. */
function userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
    switch (input.type) {
        case "text": {
            const asyncQuestionReply = renderAsyncQuestionReply(input.text);
            if (asyncQuestionReply !== null) return [{type: "text", text: asyncQuestionReply}];
            return desktopAttachmentHistory(input.text)
                ?? (input.text.length > 0 ? [{type: "text", text: input.text}] : []);
        }
        case "image":
            return [{
                type: "text",
                text: "url" in input
                    ? formatUriAsLink("image", input.url)
                    : `image:${input.fileId}`,
            }];
        case "localImage":
        case "localAudio":
        case "mention": {
            const uri = attachmentFileUri(input.path);
            const fileName = input.path.split(/[\\/]/).pop() || input.type;
            const name = input.type === "mention" && input.name.trim().length > 0 ? input.name : fileName;
            return uri !== null
                ? [{type: "resource_link", name, uri}]
                : [{type: "text", text: formatUriAsLink(name, input.path)}];
        }
        case "skill":
            return [{type: "text", text: `skill:${input.name} (${input.path})`}];
        case "audio":
            return [{type: "text", text: formatUriAsLink("audio", input.url)}];
    }
}

/** The text of a stored prompt as the client was shown it, which is what the
 *  client fingerprints when it names the message a rewind drops. */
export function userInputVisibleText(content: UserInput[]): string {
    return userMessageContentBlocks(content)
        .filter((block): block is Extract<acp.ContentBlock, {type: "text"}> => block.type === "text")
        .map(block => block.text)
        .join("");
}

function formatUriAsLink(name: string | null, uri: string): string {
    if (name && name.length > 0) {
        return `[@${name}](${uri})`;
    }
    if (uri.startsWith("file://")) {
        const path = uri.replace("file://", "");
        const fileName = path.split("/").pop() ?? path;
        return `[@${fileName}](${uri})`;
    }
    return uri;
}
