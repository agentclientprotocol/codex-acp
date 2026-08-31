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
    if (!name) return fallback;
    const words = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback;
}
