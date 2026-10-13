import type * as acp from "@agentclientprotocol/sdk";
import type {UserInput} from "./app-server/v2";
import {attachmentFileUri, desktopAttachmentHistory} from "./DesktopAttachmentHistory";

export function userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
    switch (input.type) {
        case "text":
            return desktopAttachmentHistory(input.text)
                ?? (input.text.length > 0 ? [{ type: "text", text: input.text }] : []);
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
            return [{ type: "text", text: `skill:${input.name} (${input.path})` }];
        case "audio":
            return [{type: "text", text: formatUriAsLink("audio", input.url)}];
    }
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

export function userInputVisibleText(content: UserInput[]): string {
    return content.flatMap(userInputToContentBlocks)
        .filter((block): block is Extract<acp.ContentBlock, {type: "text"}> => block.type === "text")
        .map(block => block.text).join("");
}
