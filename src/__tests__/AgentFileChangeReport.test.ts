import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {
    AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH,
    AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES,
    AgentFileChangeReportError,
    createReportedAgentFileChangeReport,
    parseAgentFileChangeReportRequest,
} from "../AgentFileChangeReport";

function modified(pathname: string): string {
    return `diff --git a/${pathname} b/${pathname}\n--- a/${pathname}\n+++ b/${pathname}\n@@ -1 +1 @@\n-old\n+new\n`;
}

describe("agent file-change report", () => {
    it("accepts only a versioned request with a bounded opaque id", () => {
        expect(parseAgentFileChangeReportRequest({
            jetbrains: {air: {agentFileChangeReportRequest: {version: 1, requestId: "turn.42:audit-1"}}},
        })).toEqual({version: 1, requestId: "turn.42:audit-1"});

        for (const request of [
            {version: 2, requestId: "request-id"},
            {version: 1, requestId: "contains spaces"},
            {version: 1, requestId: "x".repeat(129)},
            {version: 1, requestId: "request-id", extra: true},
            true,
        ]) {
            expect(parseAgentFileChangeReportRequest({
                jetbrains: {air: {agentFileChangeReportRequest: request}},
            })).toBeNull();
        }
    });

    it("extracts add, update, delete, rename, and binary paths from an aggregated diff", () => {
        const diff = [
            modified("src/Main.kt"),
            "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
            "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
            "diff --git a/before.txt b/after.txt\nsimilarity index 100%\nrename from before.txt\nrename to after.txt\n",
            "diff --git a/image.png b/image.png\nindex 111..222 100644\nBinary files a/image.png and b/image.png differ\n",
        ].join("");

        expect(createReportedAgentFileChangeReport(
            "request-id",
            diff,
            {cwd: "/repo", additionalDirectories: []},
        )).toEqual({
            version: 1,
            requestId: "request-id",
            status: "reported",
            paths: [
                "/repo/src/Main.kt",
                "/repo/new.txt",
                "/repo/old.txt",
                "/repo/before.txt",
                "/repo/after.txt",
                "/repo/image.png",
            ],
            declaredComplete: false,
            truncated: false,
            uncertainty: "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.",
        });
    });

    it("reports an empty incomplete list when the turn emitted no diff", () => {
        expect(createReportedAgentFileChangeReport(
            "request-empty",
            "",
            {cwd: "/repo", additionalDirectories: []},
        )).toEqual({
            version: 1,
            requestId: "request-empty",
            status: "reported",
            paths: [],
            declaredComplete: false,
            truncated: false,
            uncertainty: "Codex turn diffs may omit same-content renames and changes made outside apply_patch, including shell commands, version-control commands, generators, and child processes.",
        });
    });

    it("decodes quoted Git paths", () => {
        const diff = "diff --git \"a/\\303\\251 file.txt\" \"b/\\303\\251 file.txt\"\n"
            + "--- \"a/\\303\\251 file.txt\"\n"
            + "+++ \"b/\\303\\251 file.txt\"\n"
            + "@@ -1 +1 @@\n-old\n+new\n";

        expect(createReportedAgentFileChangeReport(
            "request-quoted",
            diff,
            {cwd: "/repo", additionalDirectories: []},
        ).paths).toEqual(["/repo/é file.txt"]);
    });

    it("keeps additional roots and marks rejected paths as incomplete", () => {
        const diff = modified("src/A.kt")
            + "diff --git /generated/out.txt /generated/out.txt\n--- /generated/out.txt\n+++ /generated/out.txt\n@@ -1 +1 @@\n-old\n+new\n"
            + "diff --git /outside/out.txt /outside/out.txt\n--- /outside/out.txt\n+++ /outside/out.txt\n@@ -1 +1 @@\n-old\n+new\n";

        expect(createReportedAgentFileChangeReport(
            "request-id",
            diff,
            {cwd: "/repo", additionalDirectories: ["/generated"]},
        )).toMatchObject({
            paths: ["/repo/src/A.kt", "/generated/out.txt"],
            declaredComplete: false,
            truncated: true,
        });
    });

    it("deduplicates Windows paths case-insensitively", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            modified("src/A.kt") + modified("SRC/a.KT"),
            {cwd: "C:\\Work\\Repo", additionalDirectories: []},
        );

        expect(report.paths).toEqual(["C:\\Work\\Repo\\src\\A.kt"]);
        expect(report.declaredComplete).toBe(false);
    });

    it("resolves repository-relative diff paths from a nested working directory", () => {
        if (process.platform === "win32") return;

        const repository = fs.mkdtempSync(path.join(os.tmpdir(), "file-report-repo-"));
        const cwd = path.join(repository, "packages", "app");
        fs.mkdirSync(path.join(repository, ".git"));
        fs.mkdirSync(cwd, {recursive: true});
        try {
            const report = createReportedAgentFileChangeReport(
                "request-git-root",
                modified("packages/app/src/Main.ts"),
                {cwd, additionalDirectories: []},
            );

            expect(report.paths).toEqual([
                path.join(fs.realpathSync.native(cwd), "src", "Main.ts"),
            ]);

            const cwdRelativeReport = createReportedAgentFileChangeReport(
                "request-cwd-root",
                modified("src/Main.ts"),
                {cwd, additionalDirectories: []},
            );
            expect(cwdRelativeReport.paths).toEqual([
                path.join(fs.realpathSync.native(cwd), "src", "Main.ts"),
            ]);
        } finally {
            fs.rmSync(repository, {recursive: true, force: true});
        }
    });

    it("resolves a repository-relative path into a sibling additional root", () => {
        if (process.platform === "win32") return;

        const repository = fs.mkdtempSync(path.join(os.tmpdir(), "file-report-roots-"));
        const cwd = path.join(repository, "packages", "app");
        const generated = path.join(repository, "generated");
        fs.mkdirSync(path.join(repository, ".git"));
        fs.mkdirSync(cwd, {recursive: true});
        fs.mkdirSync(generated);
        try {
            const report = createReportedAgentFileChangeReport(
                "request-additional-root",
                modified("generated/out.txt"),
                {cwd, additionalDirectories: [generated]},
            );

            expect(report.paths).toEqual([
                path.join(fs.realpathSync.native(generated), "out.txt"),
            ]);
        } finally {
            fs.rmSync(repository, {recursive: true, force: true});
        }
    });

    it("accepts canonical paths under a symlinked workspace root", () => {
        if (process.platform === "win32") return;

        const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-report-real-"));
        const linkedRoot = `${realRoot}-link`;
        fs.symlinkSync(realRoot, linkedRoot, "dir");
        try {
            const report = createReportedAgentFileChangeReport(
                "request-symlink-root",
                modified("generated.ts"),
                {cwd: linkedRoot, additionalDirectories: []},
            );
            expect(report.paths).toEqual([path.join(fs.realpathSync.native(realRoot), "generated.ts")]);
        } finally {
            fs.unlinkSync(linkedRoot);
            fs.rmSync(realRoot, {recursive: true, force: true});
        }
    });

    it("classifies malformed non-empty diff as invalid output", () => {
        expect(() => createReportedAgentFileChangeReport(
            "request-id",
            "not a unified diff",
            {cwd: "/repo", additionalDirectories: []},
        )).toThrow(AgentFileChangeReportError);

        try {
            createReportedAgentFileChangeReport(
                "request-id",
                "not a unified diff",
                {cwd: "/repo", additionalDirectories: []},
            );
        } catch (error) {
            expect(error).toMatchObject({reason: "invalidOutput"});
        }
    });

    it("keeps valid paths when another path exceeds the per-path cap", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            modified("valid.txt") + modified("x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH + 1)),
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(report.paths).toEqual(["/repo/valid.txt"]);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });

    it("applies the path cap after removing Git's header prefix", () => {
        const relativePath = "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH - "/repo/".length);
        const report = createReportedAgentFileChangeReport(
            "request-boundary",
            modified(relativePath),
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(report.paths).toEqual([`/repo/${relativePath}`]);
        expect(report.paths[0]).toHaveLength(AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH);
    });

    it("caps the serialized report", () => {
        const diff = Array.from(
            {length: 1_024},
            (_, index) => modified(`generated/${index}-${"x".repeat(240)}.txt`),
        ).join("");
        const report = createReportedAgentFileChangeReport(
            "request-id",
            diff,
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(Buffer.byteLength(JSON.stringify(report), "utf8"))
            .toBeLessThanOrEqual(AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });
});
