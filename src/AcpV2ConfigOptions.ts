import * as acp from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

/**
 * Renders a config option built by the shared (v1-typed) builders in the ACP v2 wire shape.
 *
 * v2 renames the option's `id` to `configId` and a select group's `group` to `groupId`; all
 * values are unchanged.
 */
export function toV2ConfigOption(option: acp.SessionConfigOption): acpV2.SessionConfigOption {
    switch (option.type) {
        case "boolean": {
            const {id, ...rest} = option;
            return {configId: id, ...rest};
        }
        case "select": {
            const {id, options, ...rest} = option;
            return {configId: id, ...rest, options: toV2SelectOptions(options)};
        }
    }
}

export function toV2ConfigOptions(options: Array<acp.SessionConfigOption>): Array<acpV2.SessionConfigOption> {
    return options.map(toV2ConfigOption);
}

function toV2SelectOptions(options: acp.SessionConfigSelectOptions): acpV2.SessionConfigSelectOptions {
    if (!isGrouped(options)) {
        return options;
    }
    return options.map(({group, ...rest}) => ({groupId: group, ...rest}));
}

function isGrouped(options: acp.SessionConfigSelectOptions): options is Array<acp.SessionConfigSelectGroup> {
    const first = options[0];
    return first !== undefined && "group" in first;
}

/**
 * Maps a v2 `session/set_config_option` request onto the v1 request shape the shared dispatcher
 * takes. v2 tags every value with `type`; only the `id` and `boolean` kinds exist for codex-acp's
 * options, so any other kind, or a value that doesn't match its kind, is invalid.
 */
export function toV1SetSessionConfigOptionRequest(
    params: acpV2.SetSessionConfigOptionRequest,
): acp.SetSessionConfigOptionRequest {
    const base = {
        sessionId: params.sessionId,
        configId: params.configId,
        ...(params._meta !== undefined ? {_meta: params._meta} : {}),
    };
    const value: unknown = params.value;
    if (params.type === "id" && typeof value === "string") {
        return {...base, value};
    }
    if (params.type === "boolean" && typeof value === "boolean") {
        return {...base, type: "boolean", value};
    }
    throw acp.RequestError.invalidParams();
}
