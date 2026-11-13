/**
 * The checkouts of a repository that a session list covers: the current one,
 * the primary one and every linked worktree.
 *
 * This is a port of `codex_git_utils::linked_worktree_cwds` (codex-rs
 * `git-utils/src/worktree.rs`), which the Codex TUI resume picker sends as the
 * `cwd` array of `thread/list`. It reads the Git administrative files and
 * never runs Git. A worktree whose directory is gone is dropped, and so is an
 * administrative link that does not point back to its checkout.
 */

import fs from "node:fs";
import path from "node:path";

interface RepositoryIdentity {
    /** The canonical shared Git directory of the repository and its worktrees. */
    commonDir: string;
    /** The cwd relative to the root of its checkout, kept across worktrees. */
    relativeCwd: string;
    /**
     * The canonical root of the primary checkout, or `null` when the repository has none:
     * a bare repository, or a common dir that is not the `.git` directory of a checkout.
     */
    primaryRoot: string | null;
}

/**
 * The cwds whose sessions belong to the list of `cwd`: `cwd` itself, its
 * canonical form, and the same relative directory in the primary checkout and
 * in each linked worktree that still exists. Returns only `cwd` when it is not
 * in a Git checkout or the metadata does not validate.
 */
export function linkedWorktreeCwds(cwd: string): string[] {
    try {
        return linkedWorktreeCwdsOrNull(cwd) ?? [cwd];
    } catch {
        return [cwd];
    }
}

/** `cwd` itself and, when it differs, its canonical form: the cwds of a list without worktrees. */
export function canonicalCwds(cwd: string): string[] {
    const canonical = canonicalize(cwd);
    return canonical === null || canonical === cwd ? [cwd] : [cwd, canonical];
}

function linkedWorktreeCwdsOrNull(cwd: string): string[] | null {
    const identity = repositoryIdentity(cwd);
    if (identity === null) return null;
    const currentCwd = canonicalize(cwd);
    if (currentCwd === null) return null;

    const result = [cwd];
    const seen = new Set([cwd]);
    if (!seen.has(currentCwd)) {
        seen.add(currentCwd);
        result.push(currentCwd);
    }

    if (identity.primaryRoot !== null) {
        appendLinkedCwd(result, seen, identity.primaryRoot, identity);
    }

    const worktreesPath = path.join(identity.commonDir, "worktrees");
    if (!fs.existsSync(worktreesPath)) return result;
    const worktrees = canonicalize(worktreesPath);
    if (worktrees === null) return null;
    const registered = fs.readdirSync(worktrees, {withFileTypes: true})
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    for (const name of registered) {
        const gitDir = canonicalize(path.join(worktrees, name));
        if (gitDir === null || path.dirname(gitDir) !== worktrees) continue;
        const gitFile = readGitPath(path.join(gitDir, "gitdir"), gitDir, "");
        if (gitFile === null || path.basename(gitFile) !== ".git") continue;
        appendLinkedCwd(result, seen, path.dirname(gitFile), identity);
    }
    return result;
}

function appendLinkedCwd(result: string[], seen: Set<string>, checkoutRoot: string, identity: RepositoryIdentity): void {
    const root = canonicalize(checkoutRoot);
    if (root === null) return;
    const candidate = canonicalize(path.join(root, identity.relativeCwd));
    if (candidate === null || !isDirectory(candidate) || !isWithin(candidate, root)) return;
    const candidateIdentity = repositoryIdentity(candidate);
    if (candidateIdentity === null) return;
    if (candidateIdentity.commonDir === identity.commonDir
        && candidateIdentity.relativeCwd === identity.relativeCwd
        && !seen.has(candidate)) {
        seen.add(candidate);
        result.push(candidate);
    }
}

function repositoryIdentity(cwd: string): RepositoryIdentity | null {
    const canonicalCwd = canonicalize(cwd);
    if (canonicalCwd === null || !isDirectory(canonicalCwd)) return null;

    const repoRoot = findGitRepoRoot(canonicalCwd);
    if (repoRoot === null) return null;
    const checkoutRoot = canonicalize(repoRoot);
    if (checkoutRoot === null || !isWithin(canonicalCwd, checkoutRoot)) return null;
    const relativeCwd = path.relative(checkoutRoot, canonicalCwd);

    const gitEntry = path.join(checkoutRoot, ".git");
    const entry = lstat(gitEntry);
    if (entry === null || entry.isSymbolicLink()) return null;

    let commonDir: string | null;
    if (entry.isDirectory()) {
        commonDir = canonicalize(gitEntry);
    } else if (entry.isFile()) {
        const gitDir = readGitPath(gitEntry, checkoutRoot, "gitdir:");
        if (gitDir === null || !isDirectory(gitDir)) return null;
        commonDir = readGitPath(path.join(gitDir, "commondir"), gitDir, "");
        if (commonDir === null || !isDirectory(commonDir)) return null;
        const registeredRoot = canonicalize(path.join(commonDir, "worktrees"));
        if (registeredRoot === null || path.dirname(gitDir) !== registeredRoot) return null;
        const backlink = readGitPath(path.join(gitDir, "gitdir"), gitDir, "");
        if (backlink === null || backlink !== canonicalize(gitEntry)) return null;
    } else {
        return null;
    }
    if (commonDir === null) return null;

    return {commonDir, relativeCwd, primaryRoot: primaryCheckoutRoot(commonDir)};
}

/**
 * The checkout whose `.git` directory is `commonDir`, or `null`. The linked worktrees of a bare repository
 * have no primary checkout, but they are listed all the same.
 */
function primaryCheckoutRoot(commonDir: string): string | null {
    if (path.basename(commonDir) !== ".git") return null;
    const primaryRoot = path.dirname(commonDir);
    const primaryGitEntry = path.join(primaryRoot, ".git");
    const primaryEntry = lstat(primaryGitEntry);
    if (primaryEntry === null
        || !primaryEntry.isDirectory()
        || canonicalize(primaryGitEntry) !== commonDir) {
        return null;
    }
    return primaryRoot;
}

/** The nearest ancestor of `dir` with a `.git` file, or a `.git` directory that has a `HEAD`. */
function findGitRepoRoot(dir: string): string | null {
    let current = dir;
    for (;;) {
        const dotGit = path.join(current, ".git");
        if (fs.existsSync(dotGit) && (!isDirectory(dotGit) || fs.existsSync(path.join(dotGit, "HEAD")))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/** Reads a one-line Git path file, as `.git`, `commondir` or `gitdir`, and resolves it against `relativeTo`. */
function readGitPath(file: string, relativeTo: string, prefix: string): string | null {
    const stats = lstat(file);
    if (stats === null || !stats.isFile()) return null;
    let contents: string;
    try {
        contents = fs.readFileSync(file, "utf8").trim();
    } catch {
        return null;
    }
    if (!contents.startsWith(prefix)) return null;
    const value = contents.slice(prefix.length).trim();
    if (value.length === 0 || value.includes("\n") || value.includes("\r")) return null;
    return canonicalize(path.resolve(relativeTo, value));
}

function canonicalize(value: string): string | null {
    if (!path.isAbsolute(value)) return null;
    try {
        return fs.realpathSync.native(value);
    } catch {
        return null;
    }
}

function lstat(value: string): fs.Stats | null {
    try {
        return fs.lstatSync(value);
    } catch {
        return null;
    }
}

function isDirectory(value: string): boolean {
    try {
        return fs.statSync(value).isDirectory();
    } catch {
        return false;
    }
}

function isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The file that Codex writes into the own Git directory of a worktree that it made, `<main>/.git/worktrees/<name>`, as
 * `{"version":1,"ownerThreadId":"<id>"}`. JetBrains Air reads the same file to tell such a worktree.
 */
export const CODEX_WORKTREE_MARKER_FILE = "codex-thread.json";

/** How long {@link CodexWorktreeMarks} keeps what it read from the disk: a minute, as Air's native rule does. */
export const CODEX_WORKTREE_MARKS_TTL_MS = 60_000;

/**
 * Tells whether the absolute `cwd`, the root of a linked Git worktree or a path below it, lies in a worktree that
 * Codex made: one whose own Git directory `<main>/.git/worktrees/<name>` holds a regular file
 * {@link CODEX_WORKTREE_MARKER_FILE}. Only the file's existence counts, not its owner thread, since several threads can
 * share the worktree. The main worktree never counts, and neither do the worktrees of a bare repository.
 *
 * It gives the same answer as JetBrains Air's native rule, `codexMadeWorktreeDirectoryOf` over
 * `LinkedGitWorktrees.mainWorktreeRoot` and `LinkedGitWorktrees.linkedWorktreesMarkedBy`, step by step. Paths are
 * normalized but never resolved to their real path, so a cwd is matched as Codex stored it in `Thread.cwd`, the same
 * string that Air matches. It reads the Git administrative files and never runs Git; {@link CodexWorktreeMarks} keeps
 * its reads for a minute.
 */
export function isCodexWorktreeCwd(cwd: string): boolean {
    const directory = normalizedAbsolutePath(cwd);
    if (directory === null) return false;
    const mainRoot = mainWorktreeRootOrNull(directory);
    return mainRoot !== null && isUnderAny(directory, codexMadeWorktreesOrEmpty(mainRoot));
}

/** Whether `cwd` is a Windows UNC path, as `\\server\share\…` or `\\wsl.localhost\…`, whose reads can be slow. */
export function isUncPath(cwd: string): boolean {
    return cwd.startsWith("\\\\") || (process.platform === "win32" && cwd.startsWith("//"));
}

/**
 * {@link isCodexWorktreeCwd} with its disk reads kept for `ttlMs`, as Air's `LinkedGitWorktreeRoots` and
 * `MarkedLinkedGitWorktrees` keep them: the main worktree root per normalized cwd, and the worktrees that Codex made per
 * main worktree root. A marker written later shows once the entry expires. Each map keeps at most `maxEntries` entries.
 */
export class CodexWorktreeMarks {
    private readonly mainRoots = new Map<string, {value: string | null; readAt: number}>();
    private readonly madeWorktrees = new Map<string, {value: string[]; readAt: number}>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;
    private readonly clock: () => number;

    constructor(options: {ttlMs?: number; maxEntries?: number; clock?: () => number} = {}) {
        this.ttlMs = options.ttlMs ?? CODEX_WORKTREE_MARKS_TTL_MS;
        this.maxEntries = options.maxEntries ?? 4096;
        this.clock = options.clock ?? Date.now;
    }

    isCodexWorktreeCwd(cwd: string): boolean {
        const directory = normalizedAbsolutePath(cwd);
        if (directory === null) return false;
        const mainRoot = this.cached(this.mainRoots, directory, () => mainWorktreeRootOrNull(directory));
        if (mainRoot === null) return false;
        return isUnderAny(directory, this.cached(this.madeWorktrees, mainRoot, () => codexMadeWorktreesOrEmpty(mainRoot)));
    }

    private cached<T>(entries: Map<string, {value: T; readAt: number}>, key: string, read: () => T): T {
        const now = this.clock();
        const entry = entries.get(key);
        if (entry !== undefined && now - entry.readAt < this.ttlMs) return entry.value;
        const value = read();
        if (entries.size >= this.maxEntries) entries.clear();
        entries.set(key, {value, readAt: now});
        return value;
    }
}

const DOT_GIT = ".git";
const GITDIR_PREFIX = "gitdir:";
const MAX_GIT_FILE_BYTES = 4096;

/** `cwd` normalized, without resolving links, when it is absolute; `null` otherwise. Java's `Path.normalize`. */
function normalizedAbsolutePath(cwd: string): string | null {
    if (!isNativeAbsolute(cwd) || !isValidNativePath(cwd)) return null;
    return path.resolve(cwd);
}

/**
 * Air's `LinkedGitWorktrees.mainWorktreeRoot`: the nearest `.git` entry at or above `directory` decides. A directory,
 * even through a link and even without `HEAD`, is a main worktree: `null`. A regular file, even through a link, is read
 * as the `.git` file of a linked worktree. Any other entry, such as a broken link, gives `null` too.
 */
function mainWorktreeRootOrNull(directory: string): string | null {
    try {
        let current = directory;
        for (;;) {
            const dotGit = path.join(current, DOT_GIT);
            const target = stat(dotGit);
            if (target?.isDirectory()) return null;
            if (target?.isFile()) return mainRootOfDotGitFile(dotGit, current);
            if (lstat(dotGit) !== null) return null;
            const parent = path.dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    } catch {
        return null;
    }
}

/**
 * The main worktree root of the linked worktree `worktree`, whose `.git` file `dotGit` reads
 * `gitdir: <main>/.git/worktrees/<name>`: the parent of the common Git directory that the `commondir` file of that Git
 * directory names, or of `<gitdir>/../..` without the file. The common Git directory must be a directory named `.git`,
 * so a bare repository gives `null`.
 */
function mainRootOfDotGitFile(dotGit: string, worktree: string): string | null {
    const line = readFirstLine(dotGit);
    if (line === null || !line.startsWith(GITDIR_PREFIX)) return null;
    const gitDir = resolveAgainst(worktree, kotlinTrim(line.slice(GITDIR_PREFIX.length)));
    if (gitDir === null || !namesEqual(parentName(gitDir), "worktrees")) return null;
    const commonDir = commonDirOf(gitDir);
    if (commonDir === null || !namesEqual(path.basename(commonDir), DOT_GIT) || !isDirectory(commonDir)) return null;
    return path.dirname(commonDir);
}

function commonDirOf(gitDir: string): string | null {
    const commonDirFile = path.join(gitDir, "commondir");
    if (!isRegularFile(commonDirFile)) return parentOrNull(parentOrNull(gitDir));
    const value = readFirstLine(commonDirFile);
    return value === null ? null : resolveAgainst(gitDir, value);
}

/**
 * Air's `LinkedGitWorktrees.linkedWorktreesMarkedBy` with Codex's marker: the linked worktrees of `mainRoot` whose own
 * Git directory holds the marker as a regular file, even through a link. A worktree is the parent of the `.git` file
 * that the `gitdir` file of its Git directory names, and it must be a directory.
 */
function codexMadeWorktreesOrEmpty(mainRoot: string): string[] {
    try {
        const worktreesDirectory = path.join(mainRoot, DOT_GIT, "worktrees");
        if (!isDirectory(worktreesDirectory)) return [];
        const worktrees = new Set<string>();
        for (const name of fs.readdirSync(worktreesDirectory)) {
            const gitDir = path.join(worktreesDirectory, name);
            if (!isRegularFile(path.join(gitDir, CODEX_WORKTREE_MARKER_FILE))) continue;
            const line = readFirstLine(path.join(gitDir, "gitdir"));
            const dotGit = line === null ? null : resolveAgainst(gitDir, line);
            if (dotGit === null || !namesEqual(path.basename(dotGit), DOT_GIT)) continue;
            const worktree = parentOrNull(dotGit);
            if (worktree !== null && isDirectory(worktree)) worktrees.add(worktree);
        }
        return [...worktrees].sort();
    } catch {
        return [];
    }
}

/** Java's `Path.startsWith` of normalized absolute paths: by whole names, ignoring case on Windows. */
function isUnderAny(directory: string, worktrees: string[]): boolean {
    return worktrees.some(worktree => {
        const relative = path.relative(worktree, directory);
        return relative === ""
            || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
}

/** The trimmed first line of a Git file of at most 4 KiB, or `null` when it is empty or not UTF-8, as Air reads it. */
function readFirstLine(file: string): string | null {
    let fd: number | undefined;
    try {
        // One descriptor for the size check and the read, so the file cannot change between them.
        fd = fs.openSync(file, "r");
        if (fs.fstatSync(fd).size > MAX_GIT_FILE_BYTES) return null;
        const contents = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(fs.readFileSync(fd));
        const line = kotlinTrim(contents.split(/\r\n|\n|\r/, 1)[0] ?? "");
        return line.length === 0 ? null : line;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

const KOTLIN_WHITESPACE = "[\\t\\n\\v\\f\\r\\u001c-\\u001f\\p{Zs}\\p{Zl}\\p{Zp}]";
const KOTLIN_TRIM = new RegExp(`^${KOTLIN_WHITESPACE}+|${KOTLIN_WHITESPACE}+$`, "gu");

/** Kotlin's `String.trim()`: Java whitespace and Unicode space separators, but not a byte order mark as in JavaScript. */
function kotlinTrim(value: string): string {
    return value.replace(KOTLIN_TRIM, "");
}

/** Java's `base.resolve(value).normalize()`, or `null` for an empty path or one that Java does not parse. */
function resolveAgainst(base: string, value: string): string | null {
    if (value.length === 0 || !isValidNativePath(value)) return null;
    return path.resolve(base, value);
}

/** An absolute path as Java's `Path.isAbsolute` tells it: on Windows, with a drive and a root, or UNC. */
function isNativeAbsolute(value: string): boolean {
    if (process.platform !== "win32") return path.isAbsolute(value);
    return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

/** A path that Java's `Path.of` parses: no NUL, and on Windows none of `<>:"|?*` or a control character past the drive. */
function isValidNativePath(value: string): boolean {
    if (process.platform !== "win32") return !value.includes("\0");
    return !/[<>:"|?*\u0000-\u001f]/.test(value.replace(/^[a-zA-Z]:/, ""));
}

/** Compares a file name ignoring case, as Air does for `.git` and `worktrees`. */
function namesEqual(name: string | null, expected: string): boolean {
    return name !== null && name.toLowerCase() === expected;
}

function parentOrNull(value: string | null): string | null {
    if (value === null) return null;
    const parent = path.dirname(value);
    return parent === value ? null : parent;
}

function parentName(value: string): string | null {
    const parent = parentOrNull(value);
    return parent === null ? null : path.basename(parent);
}

function stat(value: string): fs.Stats | null {
    try {
        return fs.statSync(value);
    } catch {
        return null;
    }
}

function isRegularFile(value: string): boolean {
    return stat(value)?.isFile() ?? false;
}
