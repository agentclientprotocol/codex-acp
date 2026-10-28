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
            ':codex-file-citation{path="C:\\repo\\_build\\a.md"}',
            ':codex-file-citation{path="C:\\My Docs\\(1)\\a.md"}',
        ].join("\n"), cwd)).toBe([
            "[src/app.ts](/repo/src/app.ts)",
            "[/abs/a.txt](/abs/a.txt)",
            "[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)",
            "[docs/my notes (v2).md:12](</repo/docs/my notes (v2).md:12>)",
            "[a\\[1\\].md](/repo/a[1].md)",
            // A backslash before punctuation is escaped, so it is not read as an escape.
            "[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)",
            "[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)",
        ].join("\n"));
    });

    it("keeps directives in code, escaped or without a path as written", () => {
        const citation = ':codex-file-citation{path="a.txt"}';
        for (const text of [
            `\`${citation}\``,
            `\`\`\`text\n${citation}\n\`\`\`\n`,
            `\\${citation}`,
            `:::${citation}`,
            ':codex-file-citation{path="a.txt" path="b.txt"}',
            ':codex-file-citation{path="a\n.txt"}',
            ':codex-file-citation{purpose="source"}',
            ':codex-file-citation{path=""}',
            ':codex-file-citation{path="a.txt" broken}',
            "Ratio 3:4 and :codex-file without a body",
        ]) {
            expect(renderFileCitations(text, cwd)).toBe(text);
        }
    });

    it("parses the directive the way Codex does", () => {
        expect(renderFileCitations([
            ":codex-file-citation{path='a.txt'}",
            ':codex-file-citation{ path = "b.txt" }',
            '::codex-file-citation{path="c.txt"}',
            ':codex-file-citation{purpose="source"path="d.txt"}',
            ':codex-file-citation{path="e\\"f.txt"}',
        ].join("\n"), cwd)).toBe([
            "[a.txt](/repo/a.txt)",
            "[b.txt](/repo/b.txt)",
            "[c.txt](/repo/c.txt)",
            "[d.txt](/repo/d.txt)",
            '[e"f.txt](/repo/e"f.txt)',
        ].join("\n"));
    });

    it("parses in linear time", () => {
        for (const text of [
            `:codex-file-citation{path=${"!a=".repeat(5000)}"}`,
            `:codex-file-citation{path=a${" ".repeat(5000)}!}`,
            ':codex-file-citation{path="x '.repeat(5000),
        ]) {
            const started = performance.now();
            expect(renderFileCitations(text, cwd)).toBe(text);
            expect(performance.now() - started).toBeLessThan(1000);
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
