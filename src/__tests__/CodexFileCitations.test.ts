import {describe, expect, it} from "vitest";
import {FileCitationStream, renderFileCitations} from "../CodexFileCitations";

const cwd = "/repo";

describe("renderFileCitations", () => {
    it("renders citations as Markdown file links", () => {
        expect(renderFileCitations([
            ':codex-file-citation{path="src/app.ts" purpose="source"}',
            ':codex-file-citation{path=/abs/a.txt purpose=output}',
            ':codex-file-citation{path="C:\\repo\\report.xlsx"}',
            ':codex-file-citation{path="docs/my notes (v2).md:12"}',
            ':codex-file-citation{path="a[1].md"}',
        ].join("\n"), cwd)).toBe([
            "[src/app.ts](/repo/src/app.ts)",
            "[/abs/a.txt](/abs/a.txt)",
            "[C:\\\\repo\\\\report.xlsx](C:\\repo\\report.xlsx)",
            "[docs/my notes (v2).md:12](</repo/docs/my notes (v2).md:12>)",
            "[a\\[1\\].md](/repo/a[1].md)",
        ].join("\n"));
    });

    it("keeps directives in code, escaped or without a path as written", () => {
        const citation = ':codex-file-citation{path="a.txt"}';
        for (const text of [
            `\`${citation}\``,
            `\`\`\`text\n${citation}\n\`\`\`\n`,
            `\\${citation}`,
            `:${citation}`,
            ':codex-file-citation{purpose="source"}',
            ':codex-file-citation{path=""}',
            ':codex-file-citation{path="a.txt" broken}',
            "Ratio 3:4 and :codex-file without a body",
        ]) {
            expect(renderFileCitations(text, cwd)).toBe(text);
        }
    });

    it("renders a citation after a closed code span", () => {
        expect(renderFileCitations('`x` :codex-file-citation{path="a.txt"}', cwd))
            .toBe("`x` [a.txt](/repo/a.txt)");
    });
});

describe("FileCitationStream", () => {
    it("renders a citation split across deltas at any point", () => {
        const text = 'See :codex-file-citation{path="a.txt" purpose="source"} and ``:codex-file-citation{path="b"}``.';
        const expected = renderFileCitations(text, cwd);
        for (let split = 0; split <= text.length; split++) {
            const stream = new FileCitationStream(cwd);
            const output = stream.push(text.slice(0, split)) + stream.push(text.slice(split)) + stream.flush();
            expect(output).toBe(expected);
        }
        expect(expected).toBe('See [a.txt](/repo/a.txt) and ``:codex-file-citation{path="b"}``.');
    });

    it("passes an unfinished directive through once it gets too long", () => {
        const stream = new FileCitationStream(cwd);
        const text = `:codex-file-citation{path="${"a".repeat(5000)}`;
        expect(stream.push(text)).toBe(text);
        expect(stream.flush()).toBe("");
    });
});
