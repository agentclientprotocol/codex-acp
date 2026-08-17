import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";

type FileChangeItem = ThreadItem & {type: "fileChange"};

/** Prompt-lifetime presentation data that app-server approval params do not repeat. */
export class CodexApprovalPresentationStore {
    private readonly fileChanges = new Map<string, FileChangeItem>();

    handleNotification(notification: ServerNotification): void {
        switch (notification.method) {
            case "item/started":
                if (notification.params.item.type === "fileChange") {
                    this.fileChanges.set(notification.params.item.id, notification.params.item);
                }
                return;
            case "item/completed":
                if (notification.params.item.type === "fileChange") {
                    this.fileChanges.delete(notification.params.item.id);
                }
                return;
            case "turn/completed":
                this.fileChanges.clear();
                return;
            default:
                return;
        }
    }

    fileChange(itemId: string): FileChangeItem | undefined {
        return this.fileChanges.get(itemId);
    }
}
