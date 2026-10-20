import type * as acp from "@agentclientprotocol/sdk";
import type {AdditionalPermissionProfile, RequestPermissionProfile} from "../../app-server/v2";
import {textContent} from "../AcpToolCallRenderer";
import type {PermissionToolFacts} from "../ToolFacts";

/** Reports a Codex request for additional sandbox permissions. It is a new tool call. */
export class SandboxPermissionReporter {
    static permission(
        itemId: string,
        cwd: string,
        environmentId: string | null,
        permissions: RequestPermissionProfile,
    ): PermissionToolFacts {
        const content = permissionProfileContent(permissions);
        return {
            toolCallId: itemId,
            name: "request_permissions",
            kind: "other",
            status: "pending",
            title: "Additional sandbox permissions",
            input: {permissions, cwd, environmentId},
            locations: permissionProfilePaths(permissions),
            ...(content.length > 0 ? {result: content} : {}),
        };
    }
}

export function permissionProfilePaths(
    permissions?: RequestPermissionProfile | AdditionalPermissionProfile | null,
): string[] {
    const fileSystem = permissions?.fileSystem;
    return [...new Set([
        ...(fileSystem?.read ?? []),
        ...(fileSystem?.write ?? []),
        ...(fileSystem?.entries ?? []).flatMap(entry => entry.path.type === "path" ? [entry.path.path] : []),
    ])];
}

/** The requested permissions that have no path, as text. */
export function permissionProfileContent(
    permissions: RequestPermissionProfile | AdditionalPermissionProfile,
): acp.ToolCallContent[] {
    const lines: string[] = [];
    const networkEnabled = permissions.network?.enabled;
    if (networkEnabled !== null && networkEnabled !== undefined) {
        lines.push(networkEnabled ? "Enable network access" : "Disable network access");
    }
    for (const entry of permissions.fileSystem?.entries ?? []) {
        switch (entry.path.type) {
            case "glob_pattern":
                lines.push(`${entry.access} filesystem pattern ${entry.path.pattern}`);
                break;
            case "special":
                lines.push(`${entry.access} Codex filesystem scope ${JSON.stringify(entry.path.value)}`);
                break;
            case "path":
                break;
        }
    }
    return lines.length > 0 ? [textContent(lines.join("\n"))] : [];
}
