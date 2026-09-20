import { parsePatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { DiffStatsCalculator } from '../DiffStats';

describe('ACP diff statistics', () => {
    const calculator = new DiffStatsCalculator();

    it.each([
        ['', 0],
        ['line', 1],
        ['line\n', 1],
        ['\n', 1],
        ['\n\n', 2],
        ['first\n\nlast\n', 3],
        ['first\r\n\r\nlast\r\n', 3],
        ['first\r\rlast\r', 3],
        ['first\r\nsecond\rthird\n', 3],
    ])('counts added and deleted lines in %j', (text, count) => {
        expect(calculator.addedFile(text)).toEqual({
            version: 1, added: count, removed: 0,
        });
        expect(calculator.deletedFile(text)).toEqual({
            version: 1, added: 0, removed: count,
        });
    });

    it.each([
        {
            name: 'replacement with blank context',
            patch: '@@ -1,3 +1,4 @@\n first\n \n-old\n+new\n+extra\n',
            added: 2, removed: 1,
        },
        {
            name: 'deletion at EOF',
            patch: '@@ -2 +1,0 @@\n-last\n',
            added: 0, removed: 1,
        },
        {
            name: 'deletion of the entire file',
            patch: '@@ -1,2 +0,0 @@\n-first\n-last\n',
            added: 0, removed: 2,
        },
        {
            name: 'insertion after EOF',
            patch: '@@ -1,0 +2,2 @@\n+second\n+third\n',
            added: 2, removed: 0,
        },
        {
            name: 'multiple hunks with shifted coordinates',
            patch: '@@ -2 +2,2 @@\n-two\n+TWO\n+inserted\n@@ -5 +6 @@\n-five\n+FIVE\n',
            added: 3, removed: 2,
        },
        {
            name: 'missing EOF newline markers do not count as lines',
            patch: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
            added: 1, removed: 1,
        },
        {
            name: 'counts the patch operations for an EOF newline change',
            patch: '@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n',
            added: 1, removed: 1,
        },
        {
            name: 'a blank line differs from an empty file',
            patch: '@@ -0,0 +1 @@\n+\n',
            added: 1, removed: 0,
        },
        {
            name: 'CRLF patch lines',
            patch: '@@ -1,2 +1,2 @@\r\n first\r\n-old\r\n+new\r\n',
            added: 1, removed: 1,
        },
        {
            name: 'the patch counts are retained even when a minimal diff is smaller',
            patch: '@@ -1,2 +1,2 @@\n-same\n-old\n+same\n+new\n',
            added: 2, removed: 2,
        },
    ])('$name', ({ patch, added, removed }) => {
        expect(calculator.update(parsePatch(patch)[0]!)).toEqual({ version: 1, added, removed });
    });

    it.each([
        { oldStart: -1 },
        { newStart: NaN },
        { newStart: 1.5 },
        { oldLines: 2 },
        { newLines: 0 },
        { lines: ['-old', '+new', '?garbage'] },
        { lines: ['\\ No newline at end of file', '-old', '+new'] },
        { lines: ['-old', '\\ invalid marker', '+new'] },
    ])('omits malformed hunk statistics: %j', (change) => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        patch.hunks[0] = { ...patch.hunks[0]!, ...change };
        expect(calculator.update(patch)).toBeNull();
    });

    it('counts a patch at large coordinates without requiring file texts', () => {
        const patch = parsePatch('@@ -1000000 +1000000 @@\n-old\n+new\n')[0]!;
        expect(calculator.update(patch)).toEqual({ version: 1, added: 1, removed: 1 });
    });

    it('omits overlapping hunks', () => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        patch.hunks.push({ ...patch.hunks[0]! });
        expect(calculator.update(patch)).toBeNull();
    });

    it('omits binary patches and missing hunks', () => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        expect(calculator.update({ ...patch, hunks: [] })).toBeNull();
        patch.isBinary = true;
        expect(calculator.update(patch)).toBeNull();
    });
});
