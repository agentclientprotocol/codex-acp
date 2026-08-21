export function normalizeAgentPath(path: string): string {
    const normalized = path.trim().replace(/\/+$/, "");
    return normalized || "/root";
}

export function isRootAgentPath(path: string): boolean {
    const normalized = normalizeAgentPath(path);
    return normalized === "/root" || normalized === "root";
}

export function nameFromAgentPath(path: string, fallback: string): string {
    const normalized = normalizeAgentPath(path);
    const name = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
    return name || fallback;
}
