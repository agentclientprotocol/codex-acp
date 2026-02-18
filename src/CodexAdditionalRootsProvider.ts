import type {CodexAppServerClient} from "./CodexAppServerClient";

export class CodexAdditionalRootsProvider {
    constructor(private readonly codexClient: CodexAppServerClient) {}

    async refreshSkills(request: { _meta?: Record<string, unknown> | null, cwd?: string }): Promise<void> {
        const additionalRoots = this.readAdditionalRoots(request._meta);
        const cwd = this.nonEmpty(request.cwd) ?? this.nonEmpty(request._meta?.["cwd"]);
        if (!cwd) {
            return;
        }

        await this.codexClient.listSkills({
            cwds: [cwd],
            forceReload: true,
            perCwdExtraUserRoots: [{
                cwd: cwd,
                extraUserRoots: additionalRoots
            }]
        });
    }

    private readAdditionalRoots(meta: Record<string, unknown> | null | undefined): string[] {
        const rawRoots = meta?.["additionalRoots"];
        if (!Array.isArray(rawRoots)) {
            return [];
        }

        return Array.from(new Set(rawRoots
            .filter((value): value is string => typeof value === "string")
            .map(value => value.trim())
            .filter(value => value.length > 0)));
    }

    private nonEmpty(value: unknown): string | null {
        if (typeof value !== "string") {
            return null;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
}
