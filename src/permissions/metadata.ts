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

/**
 * Reads the `title`/`description` `requestPermissionMeta` sets, if present. On ACP v2 these
 * become the request's top-level `title`/`description` fields (`AcpV2Permissions.ts`).
 */
export function readPermissionMeta(
    meta: acp.RequestPermissionRequest["_meta"],
): RequestPermissionMetadata | undefined {
    const permission = meta?.["permission"];
    if (typeof permission !== "object" || permission === null) return undefined;
    const {title, description} = permission as Partial<RequestPermissionMetadata>;
    if (typeof title !== "string") return undefined;
    return {version: 1, title, ...(typeof description === "string" ? {description} : {})};
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
