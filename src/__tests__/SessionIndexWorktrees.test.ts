import {afterEach, beforeEach, describe, expect, it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {linkedWorktreeCwds} from "../SessionIndexWorktrees";

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
