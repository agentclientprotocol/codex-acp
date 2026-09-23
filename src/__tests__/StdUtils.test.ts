import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createJSONRPCReader } from '../StdUtils';

describe('JSON-RPC reader framing', () => {
    it.each([false, true])('frames fragmented and coalesced lines (decoded stream: %s)', decoded => {
        const stream = new PassThrough();
        if (decoded) stream.setEncoding('utf8');
        const callback = vi.fn();
        const subscription = createJSONRPCReader(stream).listen(callback);
        try {
            stream.write(' \r\n{"id":1,"result":');
            expect(callback).not.toHaveBeenCalled();
            stream.write('"first"}\r');
            expect(callback).not.toHaveBeenCalled();
            stream.write('\nnot json\n\n{"jsonrpc":"2.0","id":2,"result":');
            expect(callback.mock.calls).toEqual([[{ jsonrpc: '2.0', id: 1, result: 'first' }]]);
            stream.write('"second"}\n{"id":3,"result":"third"}\n');
            expect(callback.mock.calls).toEqual([
                [{ jsonrpc: '2.0', id: 1, result: 'first' }],
                [{ jsonrpc: '2.0', id: 2, result: 'second' }],
                [{ jsonrpc: '2.0', id: 3, result: 'third' }],
            ]);
        } finally {
            subscription.dispose();
            stream.destroy();
        }
    });

    it('delivers a large fragmented history page exactly once, then continues reading', () => {
        const stream = new PassThrough();
        const callback = vi.fn();
        const subscription = createJSONRPCReader(stream).listen(callback);
        const output = 'x'.repeat(64 * 1024 * 1024);
        const result = { data: [{ id: 'turn-1', items: [{ type: 'commandExecution', aggregatedOutput: output }] }], nextCursor: null };
        const bytes = Buffer.from(JSON.stringify({ id: 1, result }));
        try {
            for (let offset = 0; offset < bytes.length; offset += 32749) {
                stream.write(bytes.subarray(offset, offset + 32749));
            }
            expect(callback).not.toHaveBeenCalled();
            stream.write('\n{"id":2,"result":{}}\n');
            expect(callback).toHaveBeenCalledTimes(2);
            expect(callback.mock.calls[0]).toEqual([{ jsonrpc: '2.0', id: 1, result }]);
            expect(callback.mock.calls[1]).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
        } finally {
            subscription.dispose();
            stream.destroy();
        }
    });

    it('discards an incomplete message when the subscription is disposed', () => {
        const stream = new PassThrough();
        const reader = createJSONRPCReader(stream);
        const first = vi.fn();
        const second = vi.fn();
        const subscription = reader.listen(first);
        stream.write('{"id":1,"result":');
        subscription.dispose();
        expect(stream.listenerCount('data')).toBe(0);
        const replacement = reader.listen(second);
        try {
            stream.write('{"id":2,"result":"fresh"}\n');
            expect(first).not.toHaveBeenCalled();
            expect(second.mock.calls).toEqual([[{ jsonrpc: '2.0', id: 2, result: 'fresh' }]]);
        } finally {
            replacement.dispose();
            stream.destroy();
        }
    });
});
