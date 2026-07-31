import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UserInput} from "./app-server/v2";

export function userInputToContentBlocks(input: UserInput): ContentBlock[] {
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
    }
    return [];
}

function formatUriAsLink(name: string | null, uri: string): string {
    if (name) {
        return `[@${name}](${uri})`;
    }
    if (uri.startsWith("file://")) {
        const imagePath = uri.slice("file://".length);
        const fileName = imagePath.split("/").pop() ?? imagePath;
        return `[@${fileName}](${uri})`;
    }
    return uri;
}
