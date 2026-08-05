import {z} from "zod";

export const PERMISSION_PROFILE_CONFIG_ENV = "CODEX_ACP_PERMISSION_PROFILE_CONFIG";

const permissionProfileConfigSchema = z.object({
    configOverrides: z.array(z.string().min(1)).min(1),
    modeProfiles: z.object({
        "read-only": z.string().min(1),
        agent: z.string().min(1),
        "agent-full-access": z.string().min(1),
    }),
});

export type PermissionProfileConfig = z.infer<typeof permissionProfileConfigSchema>;

/**
 * Read an operator-owned, launch-wide permission profile mapping. The adapter
 * deliberately treats profile definitions as opaque Codex configuration: the
 * trusted launcher owns policy construction, while codex-acp only selects the
 * profile matching the active ACP mode.
 */
export function readPermissionProfileConfig(
    env: NodeJS.ProcessEnv = process.env,
): PermissionProfileConfig | undefined {
    const raw = env[PERMISSION_PROFILE_CONFIG_ENV];
    if (!raw) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${PERMISSION_PROFILE_CONFIG_ENV} must contain a JSON object`);
    }
    return permissionProfileConfigSchema.parse(parsed);
}

export function permissionProfileForMode(config: PermissionProfileConfig, modeId: string): string {
    const profile = config.modeProfiles[modeId as keyof PermissionProfileConfig["modeProfiles"]];
    if (!profile) throw new Error(`No permission profile configured for ACP mode ${modeId}`);
    return profile;
}
