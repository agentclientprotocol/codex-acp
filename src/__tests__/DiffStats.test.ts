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
            version: 1, added: count, removed: 0, firstChangedLine: count === 0 ? null : 1,
        });
        expect(calculator.deletedFile(text)).toEqual({
            version: 1, added: 0, removed: count, firstChangedLine: count === 0 ? null : 1,
        });
    });

    it.each([
        {
            name: 'replacement with blank context',
            old: 'first\n\nold\n', next: 'first\n\nnew\nextra\n',
            patch: '@@ -1,3 +1,4 @@\n first\n \n-old\n+new\n+extra\n',
            added: 2, removed: 1, firstChangedLine: 3,
        },
        {
            name: 'deletion at EOF clamps to the last remaining line',
            old: 'first\nlast\n', next: 'first\n',
            patch: '@@ -2 +1,0 @@\n-last\n',
            added: 0, removed: 1, firstChangedLine: 1,
        },
        {
            name: 'deletion of the entire file clamps to line one',
            old: 'first\nlast\n', next: '',
            patch: '@@ -1,2 +0,0 @@\n-first\n-last\n',
            added: 0, removed: 2, firstChangedLine: 1,
        },
        {
            name: 'insertion after EOF',
            old: 'first\n', next: 'first\nsecond\nthird\n',
            patch: '@@ -1,0 +2,2 @@\n+second\n+third\n',
            added: 2, removed: 0, firstChangedLine: 2,
        },
        {
            name: 'multiple hunks with shifted coordinates',
            old: 'one\ntwo\nthree\nfour\nfive\n', next: 'one\nTWO\ninserted\nthree\nfour\nFIVE\n',
            patch: '@@ -2 +2,2 @@\n-two\n+TWO\n+inserted\n@@ -5 +6 @@\n-five\n+FIVE\n',
            added: 3, removed: 2, firstChangedLine: 2,
        },
        {
            name: 'missing EOF newline markers do not count as lines',
            old: 'old', next: 'new',
            patch: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
            added: 1, removed: 1, firstChangedLine: 1,
        },
        {
            name: 'a single EOF newline does not change normalized lines',
            old: 'same', next: 'same\n',
            patch: '@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n',
            added: 0, removed: 0, firstChangedLine: null,
        },
        {
            name: 'a blank line differs from an empty file',
            old: '', next: '\n',
            patch: '@@ -0,0 +1 @@\n+\n',
            added: 1, removed: 0, firstChangedLine: 1,
        },
        {
            name: 'CRLF file contents',
            old: 'first\r\nold\r\n', next: 'first\r\nnew\r\n',
            patch: '@@ -1,2 +1,2 @@\n first\n-old\n+new\n',
            added: 1, removed: 1, firstChangedLine: 2,
        },
        {
            name: 'CR file contents',
            old: 'first\rold\r', next: 'first\rnew\r',
            patch: '@@ -1,2 +1,2 @@\n first\n-old\n+new\n',
            added: 1, removed: 1, firstChangedLine: 2,
        },
        {
            name: 'the patch counts are retained even when a minimal diff is smaller',
            old: 'same\nold\n', next: 'same\nnew\n',
            patch: '@@ -1,2 +1,2 @@\n-same\n-old\n+same\n+new\n',
            added: 2, removed: 2, firstChangedLine: 1,
        },
    ])('$name', ({ old, next, patch, added, removed, firstChangedLine }) => {
        expect(calculator.update(parsePatch(patch)[0]!, old, next)).toEqual({ version: 1, added, removed, firstChangedLine });
    });

    it('omits statistics if patch application relocated a hunk', () => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        expect(calculator.update(patch, 'prefix\nold\n', 'prefix\nnew\n')).toBeNull();
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
        expect(calculator.update(patch, 'old\n', 'new\n')).toBeNull();
    });

    it('omits overlapping hunks', () => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        patch.hunks.push({ ...patch.hunks[0]! });
        expect(calculator.update(patch, 'old\n', 'new\n')).toBeNull();
    });

    it('omits binary patches and missing hunks', () => {
        const patch = parsePatch('@@ -1 +1 @@\n-old\n+new\n')[0]!;
        expect(calculator.update({ ...patch, hunks: [] }, 'old', 'new')).toBeNull();
        patch.isBinary = true;
        expect(calculator.update(patch, 'old\n', 'new\n')).toBeNull();
    });
});
