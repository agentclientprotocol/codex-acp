import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {CodexWorktreeMarks, isCodexWorktreeCwd, isUncPath, linkedWorktreeCwds} from "../SessionIndexWorktrees";

/**
 * Builds the Git administrative files of a repository with linked worktrees, the way
 * `git worktree add` lays them out, without running Git.
 */
function createRepository(root: string, worktreeNames: string[]): {repo: string, worktrees: string[]} {
    const repo = path.join(root, "repo");
    const commonDir = path.join(repo, ".git");
    fs.mkdirSync(path.join(commonDir, "worktrees"), {recursive: true});
    fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(repo, "src", "pkg"), {recursive: true});
    const worktrees = worktreeNames.map(name => {
        const checkout = path.join(root, "worktrees", name);
        const adminDir = path.join(commonDir, "worktrees", name);
        fs.mkdirSync(path.join(checkout, "src", "pkg"), {recursive: true});
        fs.mkdirSync(adminDir, {recursive: true});
        fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${adminDir}\n`);
        fs.writeFileSync(path.join(adminDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(adminDir, "gitdir"), `${path.join(checkout, ".git")}\n`);
        fs.writeFileSync(path.join(adminDir, "HEAD"), `ref: refs/heads/${name}\n`);
        return checkout;
    });
    return {repo, worktrees};
}

describe("linkedWorktreeCwds", () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-worktrees-")));
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    it("returns only the cwd outside a Git checkout", () => {
        const plain = path.join(root, "plain");
        fs.mkdirSync(plain);

        expect(linkedWorktreeCwds(plain)).toEqual([plain]);
    });

    it("returns only the cwd for a directory that does not exist", () => {
        const missing = path.join(root, "missing");

        expect(linkedWorktreeCwds(missing)).toEqual([missing]);
    });

    it("adds every linked worktree of the primary checkout", () => {
        const {repo, worktrees} = createRepository(root, ["feature-b", "feature-a"]);

        expect(linkedWorktreeCwds(repo)).toEqual([repo, worktrees[1], worktrees[0]]);
    });

    it("adds the primary checkout and the other worktrees from a linked worktree", () => {
        const {repo, worktrees} = createRepository(root, ["feature-a", "feature-b"]);

        expect(linkedWorktreeCwds(worktrees[1]!)).toEqual([worktrees[1], repo, worktrees[0]]);
    });

    it("keeps the directory of the cwd inside each checkout", () => {
        const {repo, worktrees} = createRepository(root, ["feature-a"]);

        expect(linkedWorktreeCwds(path.join(repo, "src", "pkg"))).toEqual([
            path.join(repo, "src", "pkg"),
            path.join(worktrees[0]!, "src", "pkg"),
        ]);
    });

    it("drops a worktree whose directory is gone", () => {
        const {repo, worktrees} = createRepository(root, ["feature-a", "removed"]);
        fs.rmSync(worktrees[1]!, {recursive: true, force: true});

        expect(linkedWorktreeCwds(repo)).toEqual([repo, worktrees[0]]);
    });

    it("drops a worktree whose administrative link does not point back", () => {
        const {repo, worktrees} = createRepository(root, ["feature-a", "foreign"]);
        fs.writeFileSync(path.join(worktrees[1]!, ".git"), `gitdir: ${path.join(root, "elsewhere")}\n`);

        expect(linkedWorktreeCwds(repo)).toEqual([repo, worktrees[0]]);
    });

    it("adds the linked worktrees of a bare repository, which has no primary checkout", () => {
        const commonDir = path.join(root, "repo.git");
        fs.mkdirSync(path.join(commonDir, "worktrees"), {recursive: true});
        fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
        const worktrees = ["main", "feature"].map(name => {
            const checkout = path.join(root, name);
            const adminDir = path.join(commonDir, "worktrees", name);
            fs.mkdirSync(checkout);
            fs.mkdirSync(adminDir);
            fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${adminDir}\n`);
            fs.writeFileSync(path.join(adminDir, "commondir"), "../..\n");
            fs.writeFileSync(path.join(adminDir, "gitdir"), `${path.join(checkout, ".git")}\n`);
            return checkout;
        });

        expect(linkedWorktreeCwds(worktrees[0]!)).toEqual([worktrees[0], worktrees[1]]);
    });

    it("adds the canonical cwd after the requested spelling", () => {
        const {repo, worktrees} = createRepository(root, ["feature-a"]);
        const link = path.join(root, "link");
        fs.symlinkSync(repo, link);

        expect(linkedWorktreeCwds(link)).toEqual([link, repo, worktrees[0]]);
    });
});

describe("isCodexWorktreeCwd", () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-worktrees-")));
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    function markAsCodexWorktree(name: string): void {
        fs.writeFileSync(
            path.join(root, "repo", ".git", "worktrees", name, "codex-thread.json"),
            `${JSON.stringify({version: 1, ownerThreadId: "01a0637c-5b99-7242-9064-04545d605fdb"})}\n`,
        );
    }

    it("tells the root and the directories of a linked worktree whose Git directory has codex-thread.json", () => {
        const {repo, worktrees} = createRepository(root, ["codex", "user"]);
        markAsCodexWorktree("codex");
        // In the common Git directory the file marks nothing.
        fs.writeFileSync(path.join(repo, ".git", "codex-thread.json"), "{}\n");
        const plain = path.join(root, "plain");
        fs.mkdirSync(plain);

        expect({
            codexRoot: isCodexWorktreeCwd(worktrees[0]!),
            codexSubdirectory: isCodexWorktreeCwd(path.join(worktrees[0]!, "src", "pkg")),
            userWorktree: isCodexWorktreeCwd(worktrees[1]!),
            primaryCheckout: isCodexWorktreeCwd(repo),
            outsideGit: isCodexWorktreeCwd(plain),
            missing: isCodexWorktreeCwd(path.join(root, "missing")),
            relative: isCodexWorktreeCwd("repo"),
        }).toEqual({
            codexRoot: true,
            codexSubdirectory: true,
            userWorktree: false,
            primaryCheckout: false,
            outsideGit: false,
            missing: false,
            relative: false,
        });
    });

    it("keys on the file, whatever its owner, but not on a directory of that name", () => {
        const {worktrees} = createRepository(root, ["shared", "directory"]);
        fs.writeFileSync(path.join(root, "repo", ".git", "worktrees", "shared", "codex-thread.json"), "{}\n");
        fs.mkdirSync(path.join(root, "repo", ".git", "worktrees", "directory", "codex-thread.json"));

        expect([isCodexWorktreeCwd(worktrees[0]!), isCodexWorktreeCwd(worktrees[1]!)]).toEqual([true, false]);
    });

    it("ignores the file of a worktree whose administrative link does not point back", () => {
        const {worktrees} = createRepository(root, ["foreign"]);
        markAsCodexWorktree("foreign");
        fs.writeFileSync(path.join(root, "repo", ".git", "worktrees", "foreign", "gitdir"), `${path.join(root, "elsewhere", ".git")}\n`);

        expect(isCodexWorktreeCwd(worktrees[0]!)).toBe(false);
    });

    // The cases below follow Air's native rule, `LinkedGitWorktrees.mainWorktreeRoot` and `linkedWorktreesMarkedBy`.

    it("marks no worktree of a bare repository, whose common Git directory is not a .git directory", () => {
        const bare = path.join(root, "repo.git");
        const adminDir = path.join(bare, "worktrees", "codex");
        const worktree = path.join(root, "codex");
        fs.mkdirSync(adminDir, {recursive: true});
        fs.mkdirSync(worktree);
        fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${adminDir}\n`);
        fs.writeFileSync(path.join(adminDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(adminDir, "gitdir"), `${path.join(worktree, ".git")}\n`);
        fs.writeFileSync(path.join(adminDir, "codex-thread.json"), "{}\n");

        expect(isCodexWorktreeCwd(worktree)).toBe(false);
    });

    it("marks no worktree whose common Git directory named .git is a file", () => {
        const {repo, worktrees} = createRepository(root, ["codex"]);
        markAsCodexWorktree("codex");
        const adminDir = path.join(repo, ".git", "worktrees", "codex");
        fs.writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
        fs.writeFileSync(path.join(adminDir, "commondir"), `${path.join(root, ".git")}\n`);

        expect(isCodexWorktreeCwd(worktrees[0]!)).toBe(false);
    });

    it("follows a marker that links to a file, but not one that links to a directory", () => {
        const {worktrees} = createRepository(root, ["file", "directory"]);
        const admin = path.join(root, "repo", ".git", "worktrees");
        fs.writeFileSync(path.join(root, "marker.json"), "{}\n");
        fs.mkdirSync(path.join(root, "marker-directory"));
        fs.symlinkSync(path.join(root, "marker.json"), path.join(admin, "file", "codex-thread.json"), "file");
        fs.symlinkSync(path.join(root, "marker-directory"), path.join(admin, "directory", "codex-thread.json"), "dir");

        expect([isCodexWorktreeCwd(worktrees[0]!), isCodexWorktreeCwd(worktrees[1]!)]).toEqual([true, false]);
    });

    it("reads a .git that links to a file as the .git file of the worktree", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        markAsCodexWorktree("codex");
        const dotGit = path.join(worktrees[0]!, ".git");
        fs.renameSync(dotGit, path.join(root, "dot-git-file"));
        fs.symlinkSync(path.join(root, "dot-git-file"), dotGit, "file");

        expect(isCodexWorktreeCwd(path.join(worktrees[0]!, "src"))).toBe(true);
    });

    it("stops at the first .git entry above the cwd: a directory without HEAD or a broken link", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        markAsCodexWorktree("codex");
        const worktree = worktrees[0]!;
        fs.mkdirSync(path.join(worktree, "src", ".git"));
        fs.symlinkSync(path.join(root, "missing"), path.join(worktree, "src", "pkg", ".git"), "file");
        fs.mkdirSync(path.join(worktree, "docs"));

        expect({
            root: isCodexWorktreeCwd(worktree),
            sibling: isCodexWorktreeCwd(path.join(worktree, "docs")),
            gitDirectoryWithoutHead: isCodexWorktreeCwd(path.join(worktree, "src")),
            brokenGitLink: isCodexWorktreeCwd(path.join(worktree, "src", "pkg")),
        }).toEqual({root: true, sibling: true, gitDirectoryWithoutHead: false, brokenGitLink: false});
    });

    it("takes the common Git directory two levels above the worktree's Git directory without a commondir file", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        markAsCodexWorktree("codex");
        fs.rmSync(path.join(root, "repo", ".git", "worktrees", "codex", "commondir"));

        expect(isCodexWorktreeCwd(worktrees[0]!)).toBe(true);
    });

    it("matches the cwd as given, not its real path: a link to a Codex worktree is not marked", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        markAsCodexWorktree("codex");
        const link = path.join(root, "link");
        fs.symlinkSync(worktrees[0]!, link, "dir");

        expect([isCodexWorktreeCwd(link), isCodexWorktreeCwd(path.join(worktrees[0]!, "src", "..", "src"))]).toEqual([false, true]);
    });

    it("marks a path in the worktree that the gitdir file names, which need not exist itself", () => {
        const {worktrees} = createRepository(root, ["relative", "outside"]);
        markAsCodexWorktree("relative");
        markAsCodexWorktree("outside");
        const admin = path.join(root, "repo", ".git", "worktrees");
        // A relative gitdir file resolves against the worktree's Git directory.
        fs.writeFileSync(path.join(admin, "relative", "gitdir"), `${path.relative(path.join(admin, "relative"), path.join(worktrees[0]!, ".git"))}\n`);
        // The gitdir file names another existing directory: the cwd is not under it.
        fs.mkdirSync(path.join(root, "other"));
        fs.writeFileSync(path.join(admin, "outside", "gitdir"), `${path.join(root, "other", ".git")}\n`);

        expect({
            relativeGitdir: isCodexWorktreeCwd(path.join(worktrees[0]!, "missing", "dir")),
            otherDirectory: isCodexWorktreeCwd(worktrees[1]!),
        }).toEqual({relativeGitdir: true, otherDirectory: false});
    });
});

describe("CodexWorktreeMarks", () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-worktrees-")));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(root, {recursive: true, force: true});
    });

    it("keeps its reads for the TTL: a marker written later shows once the entry expires", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        let now = 1_000;
        const marks = new CodexWorktreeMarks({ttlMs: 60_000, clock: () => now});

        const before = marks.isCodexWorktreeCwd(worktrees[0]!);
        fs.writeFileSync(path.join(root, "repo", ".git", "worktrees", "codex", "codex-thread.json"), "{}\n");
        now += 59_999;
        const withinTtl = marks.isCodexWorktreeCwd(worktrees[0]!);
        now += 1;
        const afterTtl = marks.isCodexWorktreeCwd(worktrees[0]!);

        expect([before, withinTtl, afterTtl]).toEqual([false, false, true]);
    });

    it("reads nothing from the disk for a cwd it read within the TTL", () => {
        const {worktrees} = createRepository(root, ["codex"]);
        fs.writeFileSync(path.join(root, "repo", ".git", "worktrees", "codex", "codex-thread.json"), "{}\n");
        const marks = new CodexWorktreeMarks({clock: () => 0});
        expect(marks.isCodexWorktreeCwd(worktrees[0]!)).toBe(true);
        const reads = [
            vi.spyOn(fs, "statSync"),
            vi.spyOn(fs, "lstatSync"),
            vi.spyOn(fs, "readFileSync"),
            vi.spyOn(fs, "readdirSync"),
            vi.spyOn(fs.realpathSync, "native"),
        ];

        expect(marks.isCodexWorktreeCwd(worktrees[0]!)).toBe(true);
        expect(reads.map(read => read.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    });
});

describe("isUncPath", () => {
    it("tells a UNC path, such as a WSL one", () => {
        expect([
            isUncPath("\\\\wsl.localhost\\Ubuntu\\home\\user"),
            isUncPath("\\\\server\\share"),
            isUncPath("C:\\repo"),
            isUncPath("/home/user"),
        ]).toEqual([true, true, false, false]);
    });
});
