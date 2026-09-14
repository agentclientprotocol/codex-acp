import type * as acp from "@agentclientprotocol/sdk";

export const CODEX_COMMAND_PERMISSION_TITLE = "Run command?";
export const CODEX_NETWORK_PERMISSION_TITLE = "Allow network access?";
export const CODEX_FILE_CHANGE_PERMISSION_TITLE = "Make edits?";
export const CODEX_ADDITIONAL_PERMISSIONS_TITLE = "Grant permissions?";

type RequestPermissionMetadata = {
    version: 1;
    title: string;
    description?: string;
};

type OptionPermissionMetadata = {
    version: 1;
    description: string;
};

export function requestPermissionMeta(
    title: string,
    reason?: string | null,
): NonNullable<acp.RequestPermissionRequest["_meta"]> {
    const description = nonBlank(reason);
    const permission: RequestPermissionMetadata = {
        version: 1,
        title,
        ...(description ? {description} : {}),
    };
    return {permission};
}

export function optionPermissionMeta(
    description?: string | null,
): acp.PermissionOption["_meta"] | undefined {
    const normalized = nonBlank(description);
    if (!normalized) return undefined;
    const permission: OptionPermissionMetadata = {version: 1, description: normalized};
    return {permission};
}

function nonBlank(value?: string | null): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}
