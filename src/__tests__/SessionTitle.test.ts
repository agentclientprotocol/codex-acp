import {describe, expect, it} from "vitest";
import {MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle} from "../SessionTitle";

describe("normalizeSessionTitle", () => {
    it("collapses whitespace and returns null for a blank title", () => {
        expect(normalizeSessionTitle("  Fix the flaky\n test  ")).toBe("Fix the flaky test");
        expect(normalizeSessionTitle(" \n ")).toBeNull();
        expect(normalizeSessionTitle(null)).toBeNull();
        expect(normalizeSessionTitle(undefined)).toBeNull();
    });

    it("keeps a title at the limit unchanged", () => {
        const title = "a".repeat(MAX_SESSION_TITLE_LENGTH);

        expect(normalizeSessionTitle(title)).toBe(title);
    });

    it("cuts a long title to the limit with an ellipsis", () => {
        const title = normalizeSessionTitle("a".repeat(25_023));

        expect(title).toBe(`${"a".repeat(MAX_SESSION_TITLE_LENGTH - 1)}…`);
        expect(title).toHaveLength(MAX_SESSION_TITLE_LENGTH);
    });

    it("does not split a surrogate pair at the cut", () => {
        const title = normalizeSessionTitle(`${"a".repeat(MAX_SESSION_TITLE_LENGTH - 2)}😀😀`);

        expect(title).toBe(`${"a".repeat(MAX_SESSION_TITLE_LENGTH - 2)}…`);
    });
});
