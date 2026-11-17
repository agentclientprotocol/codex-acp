import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodexConnection } from '../CodexJsonRpcConnection';

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return { ...original, spawn: vi.fn() };
});

// A real, shell-independent child keeps stdout reserved for JSON-RPC responses.
const fixture = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const request = JSON.parse(line);
        process.stderr.write(Buffer.from(request.params.bytes), () => {
            process.stdout.write(JSON.stringify({ id: request.id, result: 'ok' }) + '\\n');
        });
    });
`;

let codex: CodexConnection | undefined;
let closed: Promise<unknown> | undefined;
let tempDir: string;
let stderrListeners: ReturnType<typeof process.stderr.listeners>;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stderr-'));
    stderrListeners = process.stderr.listeners('error');
});

afterEach(async () => {
    try {
        if (codex) {
            codex.connection.dispose();
            codex.process.kill();
            await closed;
        }
    } finally {
        codex = undefined;
        closed = undefined;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.resetModules();
        for (const listener of process.stderr.listeners('error')) {
            if (!stderrListeners.includes(listener)) process.stderr.removeListener('error', listener);
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('CodexJsonRpcConnection', () => {
    it.each([
        { name: 'without file logging', fileLogs: false },
        { name: 'with file logging', fileLogs: true },
    ])('forwards live stderr $name', async ({ fileLogs }) => {
        const logDir = path.join(tempDir, 'logs');
        vi.stubEnv('APP_SERVER_LOGS', fileLogs ? logDir : undefined);
        // Logger reads APP_SERVER_LOGS when its module-level singleton is constructed.
        vi.resetModules();
        const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        vi.mocked(spawn).mockImplementation(() => original.spawn(process.execPath, ['-e', fixture]));
        const { startCodexConnection } = await import('../CodexJsonRpcConnection');
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        codex = startCodexConnection();
        closed = once(codex.process, 'close');

        const marker = Buffer.from('app-server diagnostic: 警告\n');
        await expect(codex.connection.sendRequest('diagnostic', { bytes: [...marker] })).resolves.toBe('ok');
        await vi.waitFor(() => {
            expect(Buffer.concat(stderr.mock.calls.map(([chunk]) => {
                expect(Buffer.isBuffer(chunk)).toBe(true);
                return chunk as Buffer;
            }))).toEqual(marker);
        });
        expect(codex.process.exitCode).toBeNull();
        expect(codex.process.signalCode).toBeNull();
        expect(stdout).not.toHaveBeenCalled();
        if (fileLogs) {
            const log = fs.readFileSync(path.join(logDir, 'app-server.log'), 'utf8');
            expect(log).toContain('[ERR]');
            expect(log).toContain('app-server diagnostic:');
        } else {
            expect(process.env['APP_SERVER_LOGS']).toBeUndefined();
            expect(fs.existsSync(logDir)).toBe(false);
            expect(fs.readdirSync(tempDir)).toEqual([]);
        }

        // Wait for the first byte to arrive before sending the rest of a UTF-8 character.
        // This forces a chunk boundary without depending on OS pipe coalescing or timers.
        stderr.mockClear();
        const unicode = Buffer.from('界\n');
        for (const bytes of [unicode.subarray(0, 1), unicode.subarray(1)]) {
            const count = stderr.mock.calls.length;
            await expect(codex.connection.sendRequest('diagnostic', { bytes: [...bytes] })).resolves.toBe('ok');
            await vi.waitFor(() => expect(stderr.mock.calls.length).toBeGreaterThan(count));
        }
        expect(stderr.mock.calls.every(([chunk]) => Buffer.isBuffer(chunk))).toBe(true);
        expect(Buffer.concat(stderr.mock.calls.map(([chunk]) => chunk as Buffer))).toEqual(unicode);
        expect(stdout).not.toHaveBeenCalled();
    }, 15_000);

    // The executable fixture uses a POSIX shebang and chmod.
    it.skipIf(process.platform === 'win32')('keeps serving JSON-RPC after the stderr reader closes', async () => {
        const fixturePath = path.join(tempDir, 'app-server.cjs');
        fs.writeFileSync(fixturePath, `#!${process.execPath}\n${fixture}`);
        fs.chmodSync(fixturePath, 0o755);
        const moduleUrl = new URL('../CodexJsonRpcConnection.ts', import.meta.url).href;
        const harness = `
            import { once } from 'node:events';
            import { startCodexConnection } from ${JSON.stringify(moduleUrl)};
            const codex = startCodexConnection(${JSON.stringify(fixturePath)});
            const closed = once(codex.process, 'close');
            try {
                const trigger = once(process.stdin, 'data');
                process.stdout.write('ready\\n');
                await trigger;
                process.stdin.destroy();
                const diagnostic = once(codex.process.stderr, 'data');
                const result = await codex.connection.sendRequest('diagnostic', {
                    bytes: [...Buffer.from('diagnostic after disconnect\\n')],
                });
                await diagnostic;
                // Allow the stderr write's asynchronous error to fire before completing.
                await new Promise(setImmediate);
                process.stdout.write(result + '\\n');
            } finally {
                codex.connection.dispose();
                codex.process.kill();
                await closed;
            }
        `;
        const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        const child = original.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', harness], {
            env: { ...process.env, APP_SERVER_LOGS: '' },
        });
        const childClosed = once(child, 'close');
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        try {
            await vi.waitFor(() => expect(output).toBe('ready\n'), { timeout: 10_000 });
            const stderrClosed = once(child.stderr, 'close');
            child.stderr.destroy();
            await stderrClosed;
            child.stdin.end('write diagnostic\n');
            expect(await childClosed).toEqual([0, null]);
            expect(output).toBe('ready\nok\n');
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await childClosed;
        }
    }, 15_000);
});
