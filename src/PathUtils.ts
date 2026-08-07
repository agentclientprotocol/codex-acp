import path from "node:path";

export function isAbsolutePathLike(value: string): boolean {
    const trimmed = value.trim();
    return path.isAbsolute(trimmed) || isWindowsAbsolutePath(trimmed);
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
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return "";
    }

    if (isWindowsAbsolutePath(trimmed)) {
        const normalized = path.win32.normalize(trimmed).replace(/\\/g, "/");
        return trimTrailingPathSeparators(normalized).toLowerCase();
    }

    const pathForComparison = path.isAbsolute(trimmed)
        ? trimmed
        : trimmed.replace(/\\/g, "/");
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
