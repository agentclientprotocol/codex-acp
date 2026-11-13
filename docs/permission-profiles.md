# Permission profiles

Codex permission profiles appear alongside the adapter's existing modes. Session setup reads every page of `permissionProfile/list` for the session's `cwd`. Only allowed, user-defined profiles are offered; built-in IDs starting with `:` and disallowed profiles are omitted.

Each profile's mode ID is `permission-profile:<profile-id>`. Its name is the profile ID, and its description comes from Codex, falling back to `Use the <profile-id> Codex permission profile.` when absent.

## Selection over ACP

ACP v1 setup responses include profiles in `modes.availableModes` and the `mode` select config option. Clients can select a profile through `session/set_mode` with `modeId`, or `session/set_config_option` with `configId: "mode"` and `value: "permission-profile:<profile-id>"`.

ACP v2 exposes the same modes through the `mode` config option. Select a profile with `session/set_config_option`, using `configId: "mode"`, `type: "id"`, and `value: "permission-profile:<profile-id>"`. The response includes the updated config options. ACP v2 has no `session/set_mode` method.

When custom profiles exist, the config option groups entries under **Sandbox Modes** and **Permission Profiles**. Otherwise it keeps the existing flat list. Selecting an unavailable mode returns invalid params.

## Initial and restored modes

New, loaded, resumed, and forked sessions select the active custom profile reported by Codex when that profile is available. Built-in or unavailable active profiles keep the adapter's default `agent` mode (Auto review).

`INITIAL_AGENT_MODE` overrides the active profile. Set it to an available mode ID, including `permission-profile:<profile-id>`. An unavailable override falls back to the default mode.

## Applying permissions

Subsequent prompts send the selected profile ID as `turn/start.permissions`, without a legacy `sandboxPolicy`. `runtimeWorkspaceRoots` includes the session's `cwd` and additional workspace directories.

Custom modes take `approval_policy` and `approvals_reviewer` from the effective, cwd-aware `config/read` response. Absent or null values default to `on-request` and `user`. The previous turn's approval overrides do not change these defaults. The existing built-in ACP modes keep their own approval and sandbox settings.

The permission fields on thread responses and `turn/start` belong to Codex's experimental schema. The adapter declares these extensions separately because `npm run generate-types` generates the stable schema.
