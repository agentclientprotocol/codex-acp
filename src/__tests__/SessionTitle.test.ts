import {describe, expect, it} from "vitest";
import {listedSessionTitle, MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle} from "../SessionTitle";

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

describe("listedSessionTitle", () => {
    it("takes the first non-blank of name, title, summary and preview", () => {
        const all = {name: "Name", title: "Title", summary: "Summary", preview: "Preview"};

        expect(listedSessionTitle(all)).toBe("Name");
        expect(listedSessionTitle({...all, name: " \n "})).toBe("Title");
        expect(listedSessionTitle({...all, name: null, title: ""})).toBe("Summary");
        expect(listedSessionTitle({...all, name: null, title: null, summary: "\t"})).toBe("Preview");
        expect(listedSessionTitle({name: null, preview: "Preview"})).toBe("Preview");
    });

    it("collapses whitespace and returns null when every field is blank", () => {
        expect(listedSessionTitle({name: "  Fix the flaky\n test  ", preview: ""})).toBe("Fix the flaky test");
        expect(listedSessionTitle({name: null, title: " ", summary: null, preview: " \n "})).toBeNull();
    });

    it("does not cut a long title", () => {
        const preview = "a".repeat(25_023);

        expect(listedSessionTitle({name: null, preview})).toBe(preview);
        expect(listedSessionTitle({name: `${"b".repeat(MAX_SESSION_TITLE_LENGTH)} tail`, preview})).toHaveLength(MAX_SESSION_TITLE_LENGTH + 5);
    });
});
