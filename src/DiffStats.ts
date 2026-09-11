import type { StructuredPatch } from "diff";

export type DiffStats = {
    version: 1;
    added: number;
    removed: number;
};

export class DiffStatsCalculator {
    addedFile(text: string): DiffStats {
        return { version: 1, added: this.lineCount(text), removed: 0 };
    }

    deletedFile(text: string): DiffStats {
        return { version: 1, added: 0, removed: this.lineCount(text) };
    }

    update(patch: StructuredPatch): DiffStats | null {
        if (patch.isBinary || patch.hunks.length === 0) return null;
        let added = 0;
        let removed = 0;
        let previousOldEnd = 1;
        let previousNewEnd = 1;
        for (const hunk of patch.hunks) {
            const { oldStart, oldLines, newStart, newLines } = hunk;
            if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger) ||
                oldStart < previousOldEnd || newStart < previousNewEnd || oldLines < 0 || newLines < 0 ||
                newStart - oldStart !== added - removed) return null;
            let oldConsumed = 0;
            let newConsumed = 0;
            let previousWasContent = false;
            for (const line of hunk.lines) {
                switch (line[0]) {
                    case '+':
                        added++;
                        newConsumed++;
                        previousWasContent = true;
                        break;
                    case '-':
                        removed++;
                        oldConsumed++;
                        previousWasContent = true;
                        break;
                    case ' ':
                    case undefined:
                        oldConsumed++;
                        newConsumed++;
                        previousWasContent = true;
                        break;
                    case '\\':
                        if (!previousWasContent || line.replace(/\r$/, '') !== '\\ No newline at end of file') return null;
                        previousWasContent = false;
                        break;
                    default:
                        return null;
                }
            }
            if (oldConsumed !== oldLines || newConsumed !== newLines) return null;
            previousOldEnd = oldStart + oldLines;
            previousNewEnd = newStart + newLines;
        }
        return { version: 1, added, removed };
    }

    private lineCount(text: string): number {
        let count = 0;
        for (let offset = text.indexOf('\n'); offset >= 0; offset = text.indexOf('\n', offset + 1)) count++;
        for (let offset = text.indexOf('\r'); offset >= 0; offset = text.indexOf('\r', offset + 1)) {
            if (text[offset + 1] !== '\n') count++;
        }
        if (text.length > 0 && !text.endsWith('\n') && !text.endsWith('\r')) count++;
        return count;
    }
}
