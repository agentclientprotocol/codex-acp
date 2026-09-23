import {describe, expect, it} from "vitest";
import {parsePatch} from "diff";
import {
    createAddedFileGitPatch,
    createDeletedFileGitPatch,
    createUpdateGitPatch,
    DIFF_PATCH_MAX_BYTES,
} from "../GitPatch";

describe("GitPatch", () => {
    it("strips the leading slash of an absolute path in every header", () => {
        expect(createUpdateGitPatch("/workspace/src/App.ts", "/workspace/src/App.ts", "@@ -1 +1 @@\n-old\n+new\n")).toBe(
            "diff --git a/workspace/src/App.ts b/workspace/src/App.ts\n"
            + "--- a/workspace/src/App.ts\n"
            + "+++ b/workspace/src/App.ts\n"
            + "@@ -1 +1 @@\n-old\n+new\n",
        );
    });

    it("adds rename headers and uses the target path", () => {
        expect(createUpdateGitPatch("/w/Old.kt", "/w/New.kt", "@@ -1 +1 @@\n-old\n+new\n")).toBe(
            "diff --git a/w/Old.kt b/w/New.kt\n"
            + "rename from w/Old.kt\n"
            + "rename to w/New.kt\n"
            + "--- a/w/Old.kt\n"
            + "+++ b/w/New.kt\n"
            + "@@ -1 +1 @@\n-old\n+new\n",
        );
    });

    it("replaces the file headers that Codex supplied", () => {
        const patch = createUpdateGitPatch(
            "/w/App.ts",
            "/w/App.ts",
            "--- /w/App.ts\n+++ /w/App.ts\n@@ -1 +1 @@\n-old\n+new\n",
        );

        expect(patch).toBe(
            "diff --git a/w/App.ts b/w/App.ts\n--- a/w/App.ts\n+++ b/w/App.ts\n@@ -1 +1 @@\n-old\n+new\n",
        );
    });

    it("quotes a path as Git does", () => {
        const patch = createUpdateGitPatch("/w/a\"b.txt", "/w/a\"b.txt", "@@ -1 +1 @@\n-old\n+new\n");

        expect(patch).toContain("diff --git \"a/w/a\\\"b.txt\" \"b/w/a\\\"b.txt\"\n");
        expect(patch).toContain("--- \"a/w/a\\\"b.txt\"\n");
        expect(createUpdateGitPatch("/w/a b.txt", "/w/a b.txt", "@@ -1 +1 @@\n-old\n+new\n"))
            .toContain("--- a/w/a b.txt\t\n+++ b/w/a b.txt\t\n");
    });

    it("keeps carriage returns in update hunks and whole-file patches", () => {
        expect(createUpdateGitPatch("/w/a.txt", "/w/a.txt", "@@ -1 +1 @@\n-old\r\n+new\r\n"))
            .toContain("@@ -1 +1 @@\n-old\r\n+new\r\n");
        expect(createAddedFileGitPatch("/w/a.txt", "one\r\ntwo\r\n")).toContain("@@ -0,0 +1,2 @@\n+one\r\n+two\r\n");
    });

    it("builds a whole-file patch for an added file", () => {
        expect(createAddedFileGitPatch("/w/New.kt", "one\ntwo\n")).toBe(
            "diff --git a/w/New.kt b/w/New.kt\n"
            + "new file mode 100644\n"
            + "--- /dev/null\n"
            + "+++ b/w/New.kt\n"
            + "@@ -0,0 +1,2 @@\n+one\n+two\n",
        );
    });

    it("builds a whole-file patch for a deleted file without a final newline", () => {
        const patch = createDeletedFileGitPatch("/w/Old.kt", "last");

        expect(patch).toBe(
            "diff --git a/w/Old.kt b/w/Old.kt\n"
            + "deleted file mode 100644\n"
            + "--- a/w/Old.kt\n"
            + "+++ /dev/null\n"
            + "@@ -1 +0,0 @@\n-last\n\\ No newline at end of file\n",
        );
        expect(parsePatch(patch!)[0]!.hunks[0]!.lines).toEqual(["-last", "\\ No newline at end of file"]);
    });

    it("builds no patch for an empty, binary or huge file", () => {
        expect(createAddedFileGitPatch("/w/empty", "")).toBeNull();
        expect(createDeletedFileGitPatch("/w/empty", "")).toBeNull();
        expect(createAddedFileGitPatch("/w/image.png", "PNG\0\x01\x02")).toBeNull();
        expect(createUpdateGitPatch("/w/b.bin", "/w/b.bin", "@@ -1 +1 @@\n-a\0\n+b\0\n")).toBeNull();
        expect(createAddedFileGitPatch("/w/huge.txt", "x".repeat(DIFF_PATCH_MAX_BYTES))).toBeNull();
    });

    it("builds no patch for a malformed or empty update diff", () => {
        expect(createUpdateGitPatch("/w/a", "/w/a", "")).toBeNull();
        expect(createUpdateGitPatch("/w/a", "/w/b", "")).toBeNull();
        expect(createUpdateGitPatch("/w/a", "/w/a", "@@ broken @@\n+x\n")).toBeNull();
        expect(createUpdateGitPatch("/w/a", "/w/a", "@@ -1 +1 @@\n-old\n+new\n+extra\n")).toBeNull();
        expect(createUpdateGitPatch("/w/a", "/w/a", "preamble\n@@ -1 +1 @@\n-old\n+new\n")).toBeNull();
    });
});
