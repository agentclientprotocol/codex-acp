import * as acp from "@agentclientprotocol/sdk";
import type {UserInput} from "./app-server/v2";

export function userInputToContentBlocks(input: UserInput): acp.ContentBlock[] {
    switch (input.type) {
        case "text":
            return input.text.length > 0 ? [{type: "text", text: input.text}] : [];
        case "image":
            return [{type: "text", text: formatUriAsLink("image", input.url)}];
        case "localImage": {
            const uri = input.path.startsWith("file://") ? input.path : `file://${input.path}`;
            return [{type: "text", text: formatUriAsLink(null, uri)}];
        }
        case "skill":
            return [{type: "text", text: `skill:${input.name} (${input.path})`}];
        case "audio":
        case "localAudio":
        case "mention":
            return [];
    }
}

export function userInputVisibleText(content: UserInput[]): string {
    return content.flatMap(userInputToContentBlocks)
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
