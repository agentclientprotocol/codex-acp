# TCK v2, targeted `-k test_initialize`: after slice 1a

- Date: 2026-09-24
- codex-acp: commit `852f102`; the v2 chain registers only `initialize`
- acp-tck: `5418887`, `--protocol-version 2 -k test_initialize` (7 of 103 tests selected)
- Scoped run, so the verdict (NOT CONFORMANT, exit 1) is meaningless; read the targeted rows.

## Targeted rows

| Requirement    | Result | Notes |
|----------------|--------|-------|
| ACP-INIT-001   | PASS   | |
| ACP-INIT-003   | PASS   | |
| ACP-INIT-201   | PASS   | |
| ACP-INIT-202   | PASS   | |
| ACP-INIT-203   | PASS   | was SKIPPED (VERSION-MISMATCH) before v2 existed |
| ACP-INIT-204   | PASS   | was SKIPPED (VERSION-MISMATCH) before v2 existed |
| ACP-SCHEMA-001 | FAIL   | expected intermediate state, see below |

## ACP-SCHEMA-001

The `initialize` exchange itself now negotiates `protocolVersion: 2` and returns the v2 shape. Because
`capabilities.session` is advertised, the test goes on to send `session/new`, which the v2 chain does not register yet,
so the agent answers `-32601 Method not found` and the test fails on the missing result. This clears once `session/new`
is registered on the v2 chain (a later slice).

Wire response from the transcript:

```json
{"protocolVersion":2,"info":{"name":"@agentclientprotocol/codex-acp","title":"Codex","version":"1.13.1"},
 "capabilities":{"session":{"prompt":{"image":{},"embeddedContext":{}},"mcp":{"stdio":{},"http":{}},"delete":{},
 "additionalDirectories":{},"fork":{}},"auth":{"_meta":{"authStatus":{}}},"providers":{}},
 "authMethods":[{"methodId":"api-key","name":"API Key","description":"Use an API key to authenticate",
 "_meta":{"api-key":{"provider":"openai"}},"type":"agent"},
 {"methodId":"chat-gpt","name":"ChatGPT","description":"Use ChatGPT to authenticate","type":"agent"}],
 "_meta":{"steering":{"supported":true},"goal":{...},"jetbrains":{"air":{...}}}}
```
