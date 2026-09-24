import type {ClientCapabilities, Notice, NoticeSeverity} from "@agentclientprotocol/sdk";

export function clientSupportsNotices(capabilities?: ClientCapabilities | null): boolean {
    const notices = capabilities?.session?.notices;
    return typeof notices === "object" && notices !== null && !Array.isArray(notices);
}

/** Live advisory only: no identity, lifecycle, or replay. Callers must negotiate support. */
export function createSessionNotice(
    severity: NoticeSeverity,
    title: string,
    description?: string | null,
): Notice & {sessionUpdate: "notice"} {
    return {
        sessionUpdate: "notice",
        severity,
        title,
        ...(description == null ? {} : {description}),
    };
}
