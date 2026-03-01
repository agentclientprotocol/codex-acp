# Codex Update Playbook

Use this checklist when Codex version bumps cause compile/test breakage.

## Common Type Breakages

1. New required model fields.
Symptoms:
- `Property 'hidden' is missing in type ...`
Fix:
- Add `hidden: false` (or expected value) in all `Model` fixtures.

2. Thread shape expansion.
Symptoms:
- Missing `status`, `agentNickname`, `agentRole`, `name` in `Thread`.
Fix:
- Add these fields in test fixtures and mocks.

3. Thread item schema changes.
Symptoms:
- `agentMessage` missing `phase`.
Fix:
- Add `phase: null` unless specific phase is required by test.

4. Rate limits payload changes.
Symptoms:
- Missing `limitId` / `limitName` in `RateLimitSnapshot`.
Fix:
- Include `limitId` and `limitName` under `rateLimits` snapshot object.
- If notification wrapper changed, map from new shape in handler.

5. Sandbox policy contract changes.
Symptoms:
- Missing `access` for read-only or `readOnlyAccess` for workspace-write policy.
Fix:
- Provide required nested objects in policy fixtures and runtime mapping.

6. Thread start/resume required flags.
Symptoms:
- Missing `persistExtendedHistory`.
Fix:
- Set explicitly in `threadStart` and `threadResume` params.
- Keep `false` unless user confirms enabling experimental behavior.

## Event Compatibility Patterns

1. New tool-like items/events.
Approach:
- Add mapper function in `CodexToolCallMapper.ts`.
- Emit `tool_call` on start and `tool_call_update` on completion.
- Include meaningful `kind`, `title`, and `rawInput`.

2. Streaming/progressive session events.
Approach:
- Keep stable `toolCallId`.
- First event: `tool_call`, subsequent events: `tool_call_update`.
- Completion event should set `status: completed` or `failed`.

3. Informational infra events (e.g., model reroute).
Approach:
- Emit `agent_thought_chunk` with concise user-readable text.

## Test Strategy

1. Fix types first (`npm run typecheck`).
2. Run focused tests for touched event/file.
3. Update snapshots only after confirming expected behavior.
4. Run full suite at end.

## Known Env-Dependent Failures

Authentication integration tests may fail on CI/local machines due OS keychain restrictions:
- examples: `failed to save api key`, `logout failed`, `Operation not permitted`.
Treat separately from migration regressions.
