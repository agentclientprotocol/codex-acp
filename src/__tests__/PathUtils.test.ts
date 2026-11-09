import {describe, expect, it} from "vitest";
import {
    arePathBasenamesEqual,
    arePathsEqual,
    isAbsolutePathLike,
    isAbsoluteProtocolPath,
    normalizePathForComparison,
} from "../PathUtils";

describe("PathUtils", () => {
    it.each([
        ["/workspace", true], ["C:\\repo", true], ["C:/repo", true], ["\\\\server\\share\\repo", true],
        ["", false], ["repo", false], [" /workspace", false], ["file:///workspace", false],
        ["C:repo", false], ["\\repo", false], ["/workspace\0", false],
    ] as const)("checks the ACP absolute-path syntax: %j", (value, expected) => {
        expect(isAbsoluteProtocolPath(value)).toBe(expected);
    });

    it("normalizes Windows paths for comparison", () => {
        expect(arePathsEqual(
            "D:\\workspace\\sample-project\\",
            "d:/workspace/sample-project",
        )).toBe(true);
        expect(normalizePathForComparison("D:\\workspace\\sample-project\\"))
            .toBe("d:/workspace/sample-project");
    });

    it("keeps POSIX paths case-sensitive", () => {
        expect(arePathsEqual("/repo/project", "/repo/project/")).toBe(true);
        expect(arePathsEqual("/repo/project", "/repo/Project")).toBe(false);
    });

    it("detects Windows absolute paths on any host platform", () => {
        expect(isAbsolutePathLike("D:/workspace/sample-project")).toBe(true);
        expect(isAbsolutePathLike("D:\\workspace\\sample-project")).toBe(true);
        expect(isAbsolutePathLike("\\\\Server\\Share\\Project")).toBe(true);
        expect(isAbsolutePathLike("sample-project")).toBe(false);
    });

    it("compares Windows basenames case-insensitively", () => {
        expect(arePathBasenamesEqual(
            "D:\\workspace\\sample-project\\",
            "SAMPLE-PROJECT",
        )).toBe(true);
        expect(arePathBasenamesEqual(
            "D:\\workspace\\sample-project\\",
            "other-project",
        )).toBe(false);
    });

    it("preserves UNC share roots while trimming nested trailing separators", () => {
        expect(normalizePathForComparison("\\\\Server\\Share\\")).toBe("//server/share/");
        expect(normalizePathForComparison("\\\\Server\\Share\\Project\\")).toBe("//server/share/project");
    });
});
