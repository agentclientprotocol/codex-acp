import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";

type ImageViewItem = ThreadItem & {type: "imageView"};

/** Reports a Codex image view. The client shows the viewed image as a link. */
export class ImageViewReporter {
    static viewed(item: ImageViewItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            name: "view_image",
            kind: "read",
            title: `View Image ${item.path}`,
            status: "completed",
            result: [{type: "content", content: {type: "resource_link", name: item.path, uri: item.path}}],
            locations: [item.path],
            input: {path: item.path},
        };
    }
}
