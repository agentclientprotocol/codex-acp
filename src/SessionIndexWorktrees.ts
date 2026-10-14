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
    /** The canonical own Git directory of a linked worktree, `<commonDir>/worktrees/<name>`; `null` for the primary checkout. */
    worktreeGitDir: string | null;
}

/**
 * The file that Codex writes into the own Git directory of a worktree that it made, as
 * `{"version":1,"ownerThreadId":"<id>"}`. JetBrains Air reads the same file to tell such a worktree.
 */
export const CODEX_WORKTREE_MARKER_FILE = "codex-thread.json";

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

/**
 * Tells whether `cwd`, its root or a directory below, lies in a linked worktree that Codex made: one whose own Git
 * directory, `<common Git dir>/worktrees/<name>`, holds {@link CODEX_WORKTREE_MARKER_FILE}. Only the file's existence
 * counts, not its owner thread, since several threads can share the worktree. The primary checkout never counts.
 * Reads the Git administrative files and never runs Git.
 */
export function isCodexWorktreeCwd(cwd: string): boolean {
    try {
        // Most rows lie in a primary checkout, whose `.git` is a directory: no Git file is read for it.
        const canonicalCwd = canonicalize(cwd);
        if (canonicalCwd === null) return false;
        const repo = findGitRepo(canonicalCwd);
        if (repo === null || repo.dotGitIsDirectory || !isDirectory(canonicalCwd)) return false;
        const gitDir = repositoryIdentityAt(canonicalCwd, repo.root, false)?.worktreeGitDir ?? null;
        if (gitDir === null) return false;
        return lstat(path.join(gitDir, CODEX_WORKTREE_MARKER_FILE))?.isFile() ?? false;
    } catch {
        return false;
    }
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

    const repoRoot = findGitRepo(canonicalCwd)?.root ?? null;
    if (repoRoot === null) return null;
    return repositoryIdentityAt(canonicalCwd, repoRoot, true);
}

/**
 * The {@link repositoryIdentity} of the directory `canonicalCwd` in the checkout at `repoRoot`. Without
 * `withPrimaryRoot`, `primaryRoot` is `null` and not looked up.
 */
function repositoryIdentityAt(canonicalCwd: string, repoRoot: string, withPrimaryRoot: boolean): RepositoryIdentity | null {
    const checkoutRoot = canonicalize(repoRoot);
    if (checkoutRoot === null || !isWithin(canonicalCwd, checkoutRoot)) return null;
    const relativeCwd = path.relative(checkoutRoot, canonicalCwd);

    const gitEntry = path.join(checkoutRoot, ".git");
    const entry = lstat(gitEntry);
    if (entry === null || entry.isSymbolicLink()) return null;

    let commonDir: string | null;
    let worktreeGitDir: string | null = null;
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
        worktreeGitDir = gitDir;
    } else {
        return null;
    }
    if (commonDir === null) return null;

    const primaryRoot = withPrimaryRoot ? primaryCheckoutRoot(commonDir) : null;
    return {commonDir, relativeCwd, primaryRoot, worktreeGitDir};
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

/**
 * The nearest ancestor of `dir` with a `.git` file, or a `.git` directory that has a `HEAD`, and whether that
 * `.git` is a directory.
 */
function findGitRepo(dir: string): {root: string; dotGitIsDirectory: boolean} | null {
    let current = dir;
    for (;;) {
        const dotGit = path.join(current, ".git");
        if (fs.existsSync(dotGit)) {
            const dotGitIsDirectory = isDirectory(dotGit);
            if (!dotGitIsDirectory || fs.existsSync(path.join(dotGit, "HEAD"))) {
                return {root: current, dotGitIsDirectory};
            }
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
