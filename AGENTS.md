# Repository Guidelines

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.
- `.github/workflows/ci.yml` — CI mirrors the local workflow: typecheck → tests → bundle.
- `scripts/` — release tooling (`release-preflight.sh`, `next-preview-version.mjs`), kept outside `src/` so it stays out of `tsc`'s `rootDir` and the published tarball; its tests sit next to it as `*.test.mjs`.

## Coding Style

- Keep edits consistent with existing formatting.
- Return `null` for "looked it up, found nothing". Use `undefined` for optional parameters and `?:` properties. For state that is not set yet, follow the surrounding type (`SessionState` uses `| null`).
- Treat an incoming `null` in an optional field like an absent value (ACP allows `_meta: null`).
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.
- Code comments should be concise and in plain language; avoid verbosity and overly specific detail.
- When adding env/config knobs, document them in `readme-dev.md`.

## Architecture & Design Fit

- Before coding, read the code the change plugs into and find the module that owns the state or concept. Build on that module, not beside it.
- Prefer extending an existing mechanism over adding a new one, even if it takes a small refactor (moving a helper, generalizing a function). Add a parallel path, special case, or flag only when the existing structure can't support the change.
- Before writing new logic, check whether it already exists in sibling handlers of the same flow, in the other protocol version's handler, or in helpers that already work with the same data. Reuse or extend it instead of adding a second version.
- Put shared logic in the module that owns the concept, not in one caller or an unrelated file. The same goes for guards, filters and cleanup, so every caller gets them. If guards, flags or fallbacks pile up in one place, restructure instead of adding another.
- If a result is meant to match another request's output, reuse that request's logic.
- The adapter serves ACP v1 and v2. A change that is not meant for one protocol version only must work correctly in both. v2 handlers convert the request to v1 types and reuse the v1 logic; keep v2-only differences in the conversion.
- New optional request fields and `_meta` keys must not reject requests that were valid before.
- If a workaround or new path is unavoidable (e.g. a Codex limitation), say why in a short code comment and in the PR description.

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Cover both ACP v1 and v2 when a change affects what a client receives (updates, responses, replay). A change to internal logic only does not need its tests duplicated per version.
- Before adding a test, search for existing tests of the same API and scenario. Don't add cases that take the same code path. Tests that differ only in input belong in one `it.each`. Don't repeat a unit test's assertion in a wire/router test unless the wire level checks something more.
- For each behavior the docs promise, including what is omitted or rejected, have a test that would fail if it broke.
- Use `/run-codex` skill (`.claude/skills/run-codex/`) to test with real Codex and observe actual events.

## Pull Requests

- Squash merges use the PR title as the commit subject, and release-please parses it to compute the next version. Titles must be conventional commits using one of: `feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`. `conventional-prs.yml` rejects anything else.
- The title also decides the release: `feat:` bumps the minor, `fix:`/`perf:`/`revert:` the patch, a `!` bumps the major, and `chore:`/`ci:`/`docs:` and friends do not release at all.

## Releasing

- Stable releases are fully automated by release-please. There is no manual release workflow, and the version is never chosen by hand — it follows from the commit history.
- `npm run release:preflight` verifies it is safe to release and prints the PR number and version; then `gh pr merge <pr-number> --squash`.
- The preflight is the guard-list as code; if it exits non-zero, follow what it prints rather than merging.
- Pushes to `main` trigger preview publishing directly, without waiting for CI or release-please. Automatic previews skip commits authored by `acp-release-bot[bot]` or whose message starts with `chore(main): release `.
- Previews build and publish the exact pushed commit to npm under the `preview` dist-tag, then independently tag it as `v<version>` and dispatch the agent registry update. Only `latest` is reserved for stable releases. Manual previews publish the requested ref; `publish_npm` applies only to the stable channel.
- Preview publish jobs are serialized without cancelling the running job, but newer pushes can replace a queued preview, so not every commit gets a preview. There is no staging branch.
- Full runbook, including how to recover a stalled release: [`docs/RELEASES.md`](docs/RELEASES.md).

## Docs

- Keep `README.md` short. Put a feature's wire contract in `docs/<feature>.md` and link to it. Describe the whole method (capability, request, every outcome), not only the new option.
- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).
