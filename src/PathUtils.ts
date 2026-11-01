import path from "node:path";

/** ACP paths are native POSIX or fully qualified Windows paths, never file URIs. */
export function isAbsoluteProtocolPath(value: string): boolean {
    return !value.includes("\0") && (path.posix.isAbsolute(value) || isWindowsAbsolutePath(value));
}

export function isAbsolutePathLike(value: string): boolean {
    return isAbsoluteProtocolPath(value);
}

export function arePathsEqual(left: string, right: string): boolean {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function arePathBasenamesEqual(left: string, right: string): boolean {
    const leftBase = path.posix.basename(normalizePathForComparison(left));
    const rightBase = path.posix.basename(normalizePathForComparison(right));
    if (shouldComparePathCaseInsensitive(left) || shouldComparePathCaseInsensitive(right)) {
        return leftBase.toLowerCase() === rightBase.toLowerCase();
    }
    return leftBase === rightBase;
}

export function normalizePathForComparison(value: string): string {
    if (value.length === 0) {
        return "";
    }

    if (isWindowsAbsolutePath(value)) {
        const normalized = path.win32.normalize(value).replace(/\\/g, "/");
        return trimTrailingPathSeparators(normalized).toLowerCase();
    }

    const pathForComparison = path.isAbsolute(value)
        ? value
        : value.replace(/\\/g, "/");
    const normalized = path.posix.normalize(pathForComparison);
    return trimTrailingPathSeparators(normalized);
}

function isWindowsAbsolutePath(value: string): boolean {
    const portableValue = value.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(portableValue) || /^\/\/[^/]+\/[^/]+/.test(portableValue);
}

function shouldComparePathCaseInsensitive(value: string): boolean {
    return isWindowsAbsolutePath(value) || /^[A-Za-z]:/.test(value) || value.includes("\\");
}

function trimTrailingPathSeparators(value: string): string {
    let trimmed = value;
    while (trimmed.endsWith("/") && !isRootPath(trimmed)) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
}

function isRootPath(value: string): boolean {
    return value === "/"
        || /^[A-Za-z]:\/$/.test(value)
        || /^\/\/[^/]+\/[^/]+\/$/.test(value);
}
