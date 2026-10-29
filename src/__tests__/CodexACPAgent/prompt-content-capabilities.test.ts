import {describe, expect, it} from 'vitest';
import {connectSession} from './v2-prompt-harness';

describe.each([1, 2] as const)('ACP v%s prompt content capabilities', (version) => {
    it('rejects an unknown authentication method', async () => {
        const session = await connectSession(version);
        try {
            const error = await session.request(version === 1 ? "authenticate" : "auth/login", {methodId: "unknown"})
                .then(() => null, error => ({code: error.code, message: error.message}));
            expect(error?.code).toBe(-32602);
        } finally {
            session.connection.close();
        }
    });

    if (version === 2) it('rejects a known authentication method the client was not offered', async () => {
        const session = await connectSession(version);
        try {
            await expect(session.request("auth/login", {methodId: "gateway"})).rejects.toMatchObject({code: -32602});
        } finally {
            session.connection.close();
        }
    });

    it('reports an unknown session with its ID', async () => {
        const session = await connectSession(version);
        try {
            const errors = [];
            for (const method of ["session/prompt", "session/set_config_option"]) {
                errors.push(await session.request(method, {
                    sessionId: "missing-session", prompt: [{type: "text", text: "Hello"}],
                    configId: "model", type: "id", value: "gpt-5",
                }).then(() => null, error => ({code: error.code, message: error.message, data: error.data})));
            }
            await expect(JSON.stringify(errors, null, 2))
                .toMatchFileSnapshot(`data/unknown-session-v${version}.json`);
        } finally {
            session.connection.close();
        }
    });

    it('rejects unadvertised audio before inserting any part of a mixed prompt', async () => {
        const session = await connectSession(version);
        try {
            const error = await session.sendPrompt([
                {type: "text", text: "Transcribe this"},
                {type: "audio", data: "AA==", mimeType: "audio/wav"},
            ]).then(() => null, error => ({code: error.code, message: error.message}));
            await expect(JSON.stringify({error, turnStarts: session.turnStartParams, updates: session.transcript}, null, 2))
                .toMatchFileSnapshot(`data/prompt-content-capabilities-v${version}.json`);
        } finally {
            session.connection.close();
        }
    });
});
