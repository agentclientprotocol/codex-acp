import * as acp from "@agentclientprotocol/sdk/unstable";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";

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

/** Convert the value shared by session setup and session/set_config_option. */
function toV1ConfigValue(option: acpV2.InitialSessionConfigOption): acp.InitialSessionConfigOption {
    const {configId, _meta, value} = option;
    const base = {configId, ...(_meta !== undefined && {_meta})};
    if (option.type === "id" && typeof value === "string") {
        return {...base, value};
    }
    if (option.type === "boolean" && typeof value === "boolean") {
        return {...base, type: "boolean", value};
    }
    throw acp.RequestError.invalidParams(undefined, "Unsupported config option value");
}

export function toV1InitialConfigOptions(options: acpV2.InitialSessionConfigOption[] | undefined): {
    configOptions?: acp.InitialSessionConfigOption[];
} {
    return options == null ? {} : {configOptions: options.map(toV1ConfigValue)};
}

export function toV1SetSessionConfigOptionRequest(
    params: acpV2.SetSessionConfigOptionRequest,
): acp.SetSessionConfigOptionRequest {
    return {sessionId: params.sessionId, ...toV1ConfigValue(params)};
}
