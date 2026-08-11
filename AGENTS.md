# Repository Guidelines

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.
- `.github/workflows/ci.yml` — CI mirrors the local workflow: typecheck → tests → bundle.

## Coding Style & Naming Conventions

- Keep edits consistent with existing formatting.
- When adding env/config knobs, document them in `readme-dev.md`.
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Use `/run-codex` skill (`.claude/skills/run-codex/`) to test with real Codex and observe actual events.

## Pull Requests

- Squash merges use the PR title as the commit subject, and release-please parses it to compute the next version. Titles must be conventional commits using one of: `feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`. `conventional-prs.yml` rejects anything else.
- The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:`/`revert:` the patch, a `!` bumps the major, and `chore:`/`ci:`/`docs:` and friends do not release at all.

## Releasing

- Releases are fully automated by release-please. There is no manual release workflow, and the version is never chosen by hand — it follows from the commit history.
- `npm run release:preflight` verifies it is safe to release and prints the PR number and version; then `gh pr merge <pr-number> --squash`.
- The preflight is the guard-list as code; if it exits non-zero, follow what it prints rather than merging.
- Full runbook, including how to recover a stalled release: [`docs/RELEASES.md`](docs/RELEASES.md).

## Docs

- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).
