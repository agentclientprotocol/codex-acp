import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {
    AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA,
    AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH,
    AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES,
    AgentFileChangeReportError,
    createReportedAgentFileChangeReport,
    parseAgentFileChangeReportRequest,
} from "../AgentFileChangeReport";
import type {Turn} from "../app-server/v2";

function completedReport(value: unknown): Turn {
    return {
        id: "audit-turn-id",
        items: [{
            type: "agentMessage",
            id: "audit-message-id",
            text: JSON.stringify(value),
            phase: "final_answer",
            memoryCitation: null,
        }],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

describe("agent file-change report", () => {
    it("uses a strict output schema with nullable uncertainty", () => {
        expect(AGENT_FILE_CHANGE_REPORT_OUTPUT_SCHEMA).toMatchObject({
            required: ["paths", "complete", "uncertainty"],
            properties: {
                uncertainty: {
                    anyOf: [{type: "string"}, {type: "null"}],
                },
            },
        });
    });

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
        expect(parseAgentFileChangeReportRequest({jetbrains: {air: {}}})).toBeNull();
    });

    it("normalizes POSIX paths, keeps additional roots, and marks rejected paths", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({
                paths: [
                    "src/A.kt",
                    "/repo/src/A.kt",
                    "../outside.kt",
                    "/repository/not-inside.kt",
                    "/generated/out.txt",
                    ".",
                    "bad\u0085path.kt",
                ],
                complete: true,
                uncertainty: "  generator output may be incomplete  ",
            }),
            {cwd: "/repo", additionalDirectories: ["/generated"]},
        );

        expect(report).toEqual({
            version: 1,
            requestId: "request-id",
            status: "reported",
            paths: ["/repo/src/A.kt", "/generated/out.txt"],
            declaredComplete: false,
            truncated: true,
            uncertainty: "generator output may be incomplete",
        });
    });

    it("treats null uncertainty as absent and reports an empty file list", () => {
        const report = createReportedAgentFileChangeReport(
            "request-empty",
            completedReport({paths: [], complete: true, uncertainty: null}),
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(report).toEqual({
            version: 1,
            requestId: "request-empty",
            status: "reported",
            paths: [],
            declaredComplete: true,
            truncated: false,
        });
    });

    it("preserves the provider error from a failed audit turn", () => {
        const turn = completedReport({});
        turn.status = "failed";
        turn.error = {
            message: "invalid_json_schema: missing uncertainty",
            codexErrorInfo: null,
            additionalDetails: null,
        };

        expect(() => createReportedAgentFileChangeReport(
            "request-failed",
            turn,
            {cwd: "/repo", additionalDirectories: []},
        )).toThrow("The audit turn failed: invalid_json_schema: missing uncertainty");
    });

    it("deduplicates Windows paths case-insensitively on a non-Windows host", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({
                paths: ["src\\A.kt", "c:/work/repo/SRC/a.KT", "D:/Generated/out.bin"],
                complete: true,
            }),
            {cwd: "C:\\Work\\Repo", additionalDirectories: ["D:\\Generated"]},
        );

        expect(report.paths).toEqual([
            "C:\\Work\\Repo\\src\\A.kt",
            "D:\\Generated\\out.bin",
        ]);
        expect(report.declaredComplete).toBe(true);
        expect(report.truncated).toBe(false);
    });

    it("supports UNC roots and rejects share-prefix collisions", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({
                paths: [
                    "folder/file.txt",
                    "//SERVER/Share/folder/FILE.txt",
                    "//server/share-other/out.txt",
                    "\\\\server",
                    "\\\\?\\C:\\unsafe.txt",
                ],
                complete: true,
            }),
            {cwd: "\\\\server\\share", additionalDirectories: []},
        );

        expect(report.paths).toEqual(["\\\\server\\share\\folder\\file.txt"]);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });

    it("accepts canonical paths under a symlinked workspace root", () => {
        if (process.platform === "win32") return;

        const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-audit-real-"));
        const linkedRoot = `${realRoot}-link`;
        fs.symlinkSync(realRoot, linkedRoot, "dir");
        try {
            const canonicalPath = path.join(fs.realpathSync.native(realRoot), "generated.ts");
            const report = createReportedAgentFileChangeReport(
                "request-symlink-root",
                completedReport({
                    paths: [canonicalPath, path.join(linkedRoot, "generated.ts")],
                    complete: true,
                }),
                {cwd: linkedRoot, additionalDirectories: []},
            );

            expect(report).toMatchObject({
                paths: [canonicalPath],
                declaredComplete: true,
                truncated: false,
            });
        } finally {
            fs.unlinkSync(linkedRoot);
            fs.rmSync(realRoot, {recursive: true, force: true});
        }
    });

    it("keeps valid paths when another path exceeds the per-path cap", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({
                paths: ["valid.txt", "x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH + 1)],
                complete: true,
            }),
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(report.paths).toEqual(["/repo/valid.txt"]);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });

    it("applies the per-path cap after resolving a relative path", () => {
        const longCwd = `/${"x".repeat(AGENT_FILE_CHANGE_REPORT_MAX_PATH_LENGTH - 2)}`;
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({paths: ["file.txt"], complete: true}),
            {cwd: longCwd, additionalDirectories: []},
        );

        expect(report.paths).toEqual([]);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });

    it("caps the serialized report rather than only the raw path bytes", () => {
        const report = createReportedAgentFileChangeReport(
            "request-id",
            completedReport({
                paths: Array.from(
                    {length: 1_024},
                    (_, index) => `generated/${index}-${"x".repeat(240)}.txt`,
                ),
                complete: true,
            }),
            {cwd: "/repo", additionalDirectories: []},
        );

        expect(Buffer.byteLength(JSON.stringify(report), "utf8"))
            .toBeLessThanOrEqual(AGENT_FILE_CHANGE_REPORT_MAX_TOTAL_BYTES);
        expect(report.declaredComplete).toBe(false);
        expect(report.truncated).toBe(true);
    });

    it("classifies malformed model output without exposing it on the wire", () => {
        const turn = completedReport({paths: ["a.txt"], complete: "yes"});

        expect(() => createReportedAgentFileChangeReport(
            "request-id",
            turn,
            {cwd: "/repo", additionalDirectories: []},
        )).toThrow(AgentFileChangeReportError);

        try {
            createReportedAgentFileChangeReport(
                "request-id",
                turn,
                {cwd: "/repo", additionalDirectories: []},
            );
        } catch (error) {
            expect(error).toMatchObject({reason: "invalidOutput"});
        }
    });
});
