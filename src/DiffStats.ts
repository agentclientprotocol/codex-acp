import type { StructuredPatch } from "diff";

export type DiffStats = {
    version: 1;
    added: number;
    removed: number;
    firstChangedLine: number | null;
};

export class DiffStatsCalculator {
    addedFile(text: string): DiffStats {
        const added = this.lineCount(text);
        return { version: 1, added, removed: 0, firstChangedLine: added === 0 ? null : 1 };
    }

    deletedFile(text: string): DiffStats {
        const removed = this.lineCount(text);
        return { version: 1, added: 0, removed, firstChangedLine: removed === 0 ? null : 1 };
    }

    update(patch: StructuredPatch, oldText: string, newText: string): DiffStats | null {
        if (patch.isBinary || patch.hunks.length === 0) return null;
        const oldLineCount = this.lineCount(oldText);
        const newLineCount = this.lineCount(newText);
        let added = 0;
        let removed = 0;
        let firstChangedLine: number | null = null;
        let previousOldEnd = 1;
        let previousNewEnd = 1;
        for (const hunk of patch.hunks) {
            const { oldStart, oldLines, newStart, newLines } = hunk;
            if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger) ||
                oldStart < previousOldEnd || newStart < previousNewEnd || oldLines < 0 || newLines < 0 ||
                oldStart + oldLines > oldLineCount + 1 || newStart + newLines > newLineCount + 1 ||
                newStart - oldStart !== added - removed) return null;
            let oldConsumed = 0;
            let newConsumed = 0;
            let previousWasContent = false;
            for (const line of hunk.lines) {
                switch (line[0]) {
                    case '+':
                        firstChangedLine ??= newStart + newConsumed;
                        added++;
                        newConsumed++;
                        previousWasContent = true;
                        break;
                    case '-':
                        firstChangedLine ??= newStart + newConsumed;
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
        if (oldLineCount + added - removed !== newLineCount ||
            !this.matchesHunks(patch, oldText, false) || !this.matchesHunks(patch, newText, true)) return null;
        if (this.sameLines(oldText, newText)) return { version: 1, added: 0, removed: 0, firstChangedLine: null };
        if (firstChangedLine === null) return null;
        return {
            version: 1,
            added,
            removed,
            firstChangedLine: Math.max(1, Math.min(firstChangedLine, newLineCount)),
        };
    }

    private matchesHunks(patch: StructuredPatch, text: string, newSide: boolean): boolean {
        let offset = 0;
        let lineNumber = 1;
        for (const hunk of patch.hunks) {
            const start = newSide ? hunk.newStart : hunk.oldStart;
            while (lineNumber < start) {
                offset = this.nextLine(text, offset);
                lineNumber++;
            }
            for (const line of hunk.lines) {
                if (line[0] === '\\' || line[0] === (newSide ? '-' : '+')) continue;
                let end = offset;
                while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
                const expected = line.slice(1).replace(/\r$/, '');
                if (text.slice(offset, end) !== expected) return false;
                offset = this.nextLine(text, offset);
                lineNumber++;
            }
        }
        return true;
    }

    private nextLine(text: string, offset: number): number {
        while (offset < text.length && text[offset] !== '\n' && text[offset] !== '\r') offset++;
        if (offset === text.length) return offset;
        return offset + (text[offset] === '\r' && text[offset + 1] === '\n' ? 2 : 1);
    }

    private lineCount(text: string): number {
        let count = 0;
        let offset = 0;
        while (offset < text.length) {
            offset = this.nextLine(text, offset);
            count++;
        }
        return count;
    }

    private sameLines(left: string, right: string): boolean {
        if (left === right) return true;
        if (left.length === 0 || right.length === 0) return false;
        const leftEnd = this.contentEnd(left);
        const rightEnd = this.contentEnd(right);
        let leftOffset = 0;
        let rightOffset = 0;
        while (leftOffset < leftEnd && rightOffset < rightEnd) {
            let leftChar = left[leftOffset++];
            let rightChar = right[rightOffset++];
            if (leftChar === '\r') {
                if (left[leftOffset] === '\n') leftOffset++;
                leftChar = '\n';
            }
            if (rightChar === '\r') {
                if (right[rightOffset] === '\n') rightOffset++;
                rightChar = '\n';
            }
            if (leftChar !== rightChar) return false;
        }
        return leftOffset === leftEnd && rightOffset === rightEnd;
    }

    private contentEnd(text: string): number {
        if (text.endsWith('\r\n')) return text.length - 2;
        if (text.endsWith('\n') || text.endsWith('\r')) return text.length - 1;
        return text.length;
    }
}
