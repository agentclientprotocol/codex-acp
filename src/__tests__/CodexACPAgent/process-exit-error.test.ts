import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import * as acp from '@agentclientprotocol/sdk';
import { startCodexConnection } from '../../CodexJsonRpcConnection';
import { CodexAppServerClient } from '../../CodexAppServerClient';
import { CodexAcpClient } from '../../CodexAcpClient';
import { CodexAcpServer } from '../../CodexAcpServer';
import { createMockConnections } from './test-utils';

describe('CodexACPAgent - process exit error', () => {
    it.skipIf(process.platform === 'win32')('includes the crashed process stderr', async () => {
        const fakeCodex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bad-')), 'codex');
        fs.writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex: failed to launch' >&2\nexit 1\n");
        fs.chmodSync(fakeCodex, 0o755);

        const connection = startCodexConnection(fakeCodex);
        let stderr = '';
        connection.process.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const codexClient = new CodexAcpClient(new CodexAppServerClient(connection.connection));
        const agent = new CodexAcpServer(
            createMockConnections().mockAcpConnection,
            codexClient,
            undefined,
            () => connection.process.exitCode,
            () => stderr,
        );

        await once(connection.process, 'close'); // process exited and stderr flushed

        await expect(agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION }))
            .rejects.toThrow("Codex process has exited with code 1:\ncodex: failed to launch");
    });
});
