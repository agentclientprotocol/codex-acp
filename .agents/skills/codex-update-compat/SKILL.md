---
name: codex-update-compat
description: Upgrade Codex in this repository and resolve compatibility regressions caused by app-server schema/protocol changes. Use when bumping Codex/npm package versions, regenerating `src/app-server` types, fixing TypeScript errors after update, repairing event mappings, and updating tests/snapshots to match new Codex behavior (especially model list, thread/session fields, sandbox policy shape, and tool/event notifications).
---

# Codex Update Compat

Use this workflow to safely upgrade Codex and close update-induced regressions.

## Workflow

1. Inspect update scope before changing code.
Run:
```bash
git log --oneline -n 5
git show --name-only --oneline -n 1
```
Focus first on `package.json`, `package-lock.json`, and generated `src/app-server/**` changes.

2. Run typecheck and tests immediately.
Run:
```bash
npm run typecheck
npm test
```
Treat type errors as the migration guide for required protocol changes.

3. Fix runtime compatibility in source files.
Typical hotspots:
- `src/CodexAcpClient.ts`: thread start/resume params and initialize capabilities
- `src/AgentMode.ts`: sandbox policy shape changes
- `src/CodexEventHandler.ts`: new/changed server notifications
- `src/CodexAcpServer.ts`: history replay for new `ThreadItem` variants
- `src/CodexToolCallMapper.ts`: mapping new tool-like items to ACP events

4. Fix test fixtures and snapshots.
Update typed fixtures for new required fields instead of weakening types.
Then update snapshots only after behavior is intentionally verified.

5. Re-run targeted suites, then full checks.
Run focused tests for touched behavior, then:
```bash
npm run typecheck
npm test
```

## Non-Trivial Changes: Ask Before Finalizing

When migration requires behavior decisions (not only schema fixes), ask the user first. Examples:
- Enabling/disabling experimental flags (`persistExtendedHistory`, `experimentalApi`)
- User-visible messaging changes for new events (e.g., model reroute wording)
- Converting integration tests to mocks or skipping env-dependent tests

## Event Mapping Rule

Do not silently drop new event/item variants if they should be visible to users.
Map them to ACP updates:
- Tool-like operations -> `tool_call` / `tool_call_update`
- Informational reasoning/infra events -> `agent_thought_chunk` (if user-meaningful)
- Internal/noise events -> explicit no-op case (documented in switch)

## References

For common break patterns and ready fixes, read:
- `references/codex-update-playbook.md`
