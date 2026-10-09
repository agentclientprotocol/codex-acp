import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Thread, ThreadItem } from "../app-server/v2";
import { revertSessionFiles } from "../SessionFileRevert";

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((dir) => rm(dir, { recursive: true, force: true })),
    );
});
async function setup(changes?: unknown[]) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-file-revert-"));
    directories.push(cwd);
    execFileSync("git", ["init", "-q", cwd], { windowsHide: true });
    await writeFile(path.join(cwd, "changed.txt"), "old\n");
    execFileSync("git", ["add", "."], { cwd, windowsHide: true });
    const index = await readFile(path.join(cwd, ".git/index"));
    await writeFile(path.join(cwd, "changed.txt"), "new\n");
    await writeFile(path.join(cwd, "user.txt"), "keep user's work\n");
    const item = {
        type: "fileChange",
        id: "tool",
        status: "completed",
        changes: changes ?? [
            {
                path: path.join(cwd, "changed.txt"),
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
        ],
    } as ThreadItem;
    const readHistory = async () => ({
        thread: { id: "session", turns: [{ id: "turn", items: [item] }] } as Thread,
    });
    return {
        cwd,
        index,
        readHistory,
        session: { sessionId: "session", cwd, additionalDirectories: [] },
        request: { sessionId: "session", toolCallId: "tool", dryRun: true },
    };
}
describe("native file patch revert", () => {
    it("previews then reverses the Git text patch while preserving the real index and unrelated edits", async () => {
        const f = await setup();
        const preview = await revertSessionFiles(
            f.request,
            f.session,
            f.readHistory,
        );
        expect(preview.canRevert).toBe(true);
        expect(await readFile(path.join(f.cwd, "changed.txt"), "utf8")).toBe(
            "new\n",
        );
        const applied = await revertSessionFiles(
            { ...f.request, dryRun: false, previewToken: preview.previewToken },
            f.session,
            f.readHistory,
        );
        expect(applied.reverted).toBe(true);
        expect(
            (await readFile(path.join(f.cwd, "changed.txt"), "utf8")).replaceAll(
                "\r\n",
                "\n",
            ),
        ).toBe("old\n");
        expect(await readFile(path.join(f.cwd, "user.txt"), "utf8")).toBe("keep user's work\n");
        expect(await readFile(path.join(f.cwd, ".git/index"))).toEqual(f.index);
    });
    it("refuses a changed file after preview and does not overwrite the user's new content", async () => {
        const f = await setup();
        const preview = await revertSessionFiles(
            f.request,
            f.session,
            f.readHistory,
        );
        await writeFile(path.join(f.cwd, "changed.txt"), "new\nuser addition\n");
        expect(
            await revertSessionFiles(
                { ...f.request, dryRun: false, previewToken: preview.previewToken },
                f.session,
                f.readHistory,
            ),
        ).toMatchObject({ reverted: false, reason: "stale_preview" });
        expect(await readFile(path.join(f.cwd, "changed.txt"), "utf8")).toBe(
            "new\nuser addition\n",
        );
    });
    it("rejects paths outside the session and Git metadata", async () => {
        for (const file of ["../outside.txt", ".git/config"]) {
            const f = await setup([
                { path: file, kind: { type: "add" }, diff: "x\n" },
            ]);
            expect(
                await revertSessionFiles(f.request, f.session, f.readHistory),
            ).toMatchObject({ canRevert: false, reverted: false });
        }
    });
    it("does not touch files without an explicit preview token", async () => {
        const f = await setup();
        await expect(
            revertSessionFiles(
                { ...f.request, dryRun: false },
                f.session,
                f.readHistory,
            ),
        ).rejects.toThrow();
    });
    it("undoes recorded create/delete patches in one batch", async () => {
        const f = await setup([
            { path: "created.txt", kind: { type: "add" }, diff: "created\n" },
            { path: "deleted.txt", kind: { type: "delete" }, diff: "deleted\n" },
        ]);
        await writeFile(path.join(f.cwd, "created.txt"), "created\n");
        const preview = await revertSessionFiles(
            f.request,
            f.session,
            f.readHistory,
        );
        expect(preview.canRevert).toBe(true);
        expect(
            await revertSessionFiles(
                { ...f.request, dryRun: false, previewToken: preview.previewToken },
                f.session,
                f.readHistory,
            ),
        ).toMatchObject({ reverted: true });
        await expect(readFile(path.join(f.cwd, "created.txt"))).rejects.toThrow();
        expect(
            (await readFile(path.join(f.cwd, "deleted.txt"), "utf8")).replaceAll(
                "\r\n",
                "\n",
            ),
        ).toBe("deleted\n");
    });
    it("refuses a patch whose current content conflicts", async () => {
        const f = await setup();
        await writeFile(path.join(f.cwd, "changed.txt"), "different\n");
        expect(
            await revertSessionFiles(f.request, f.session, f.readHistory),
        ).toMatchObject({ reason: "patch_conflict", canRevert: false });
    });
    it("refuses directory nodes as patch targets", async () => {
        const f = await setup([
            { path: "folder", kind: { type: "add" }, diff: "x\n" },
        ]);
        await mkdir(path.join(f.cwd, "folder"));
        expect(
            await revertSessionFiles(f.request, f.session, f.readHistory),
        ).toMatchObject({ reason: "unsupported_file_type" });
    });
    it.each([{type:"futureKind"}, null, {}])("rejects an entire mixed batch with an unknown kind %j", async kind => {
        const f = await setup([
            {path:"changed.txt",kind:{type:"update",move_path:null},diff:"@@ -1 +1 @@\n-old\n+new\n"},
            {path:"user.txt",kind,diff:"user content"},
        ]);
        const result = await revertSessionFiles(f.request, f.session, f.readHistory);
        expect(result).toMatchObject({canRevert:false,reverted:false,reason:"unsupported_patch"});
        expect(await readFile(path.join(f.cwd,"changed.txt"),"utf8")).toBe("new\n");
        expect(await readFile(path.join(f.cwd,"user.txt"),"utf8")).toBe("keep user's work\n");
        expect(await readFile(path.join(f.cwd,".git/index"))).toEqual(f.index);
    });
    it("rejects a mixed batch containing a missing diff", async () => {
        const f=await setup([{path:"changed.txt",kind:{type:"update",move_path:null},diff:"@@ -1 +1 @@\n-old\n+new\n"},{path:"user.txt",kind:{type:"add"}}]);
        expect(await revertSessionFiles(f.request,f.session,f.readHistory)).toMatchObject({reverted:false,reason:"unsupported_patch"});
        expect(await readFile(path.join(f.cwd,"changed.txt"),"utf8")).toBe("new\n");
    });

});
