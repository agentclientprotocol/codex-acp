Let's implement ACP v2 support in this agent. Research is complete: effort estimates live in
`.agents/plan.md`, the proposed design lives in `.agents/architecture.md`, and the topic-by-topic findings live in
`.agents/research/<topic-slug>.md`. This prompt does not repeat that material — consult those files directly when
scoping a slice of work. This prompt only describes the implementation approach and how to orchestrate it.

## IMPORTANT: v1 compatibility must be preserved

This is NOT a cutover from v1 to v2 — the agent must continue to speak ACP v1 for existing clients while also speaking
ACP v2, over the same process, indefinitely. Every slice of implementation work must keep the existing v1 handler chain
byte-for-byt behaviorally unchanged unless a slice's own brief says otherwise. Concretely:

- New v2 support is additive: a new v2 handler chain/registration/wrapper alongside the existing v1 one, sharing the
  same underlying business logic wherever the research found it shareable. Don't refactor v1 code paths "while you're in
  there" unless the task explicitly calls for it.
- Where the research found a genuine shared-fork point (e.g. the `ACPSessionConnection.update()`
  choke point, or a shared dispatcher method), implement through that point rather than inventing a parallel one — check
  `architecture.md`'s cross-cutting section before creating new plumbing.
- Where the research flagged an unavoidable trade-off or open design question for a topic, treat that as something to
  resolve via the researcher subagent (see below) before implementing it, not something to silently decide during
  coding.
- After any slice that touches wire behavior, verify with the ACP Test Compatibility Kit
  (`/Users/eugene/Documents/JetBrains/projects/acp-tck`) against both v1 and v2 connections — the goal is that neither
  regresses. The distilled requirement list lives at
  `/Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py`. For per-slice checks, where possible
  use the `-k` option to run only the tests covering the protocol parts the slice touched, not the full conformance
  suite. Running the whole TCK suite is fine for broader verification (e.g. a baseline, the end of a topic, or Phase 4
  integration testing).

## Orchestration

You are the orchestrator, not the implementer or the researcher. Do not edit source files, run builds/tests, or answer
protocol questions yourself — break the work into concrete, granular slices and dispatch a subagent per slice instead.
Your job is to sequence work, define scope, dispatch subagents, review their output, and keep the durable state file
current.

- Use the **programmer** subagent for any slice that writes or changes code, tests, or docs. Use the **researcher**
  subagent whenever a slice can't proceed without resolving a protocol/SDK question that implementation-time judgment
  shouldn't silently decide (an open question the research flagged, an SDK-version behavior that needs re-confirming, a
  spec ambiguity uncovered while coding). Never let a programmer subagent guess at protocol behavior — if it hits one of
  these questions mid-slice, have it stop and hand you the question for a researcher instead of resolving it itself.
- Each programmer subagent gets **one granular task**: ideally one milestone, one call-site group, or one method/handler
  pair (request-building + registration), not a whole plan topic. Point it at the owning section of `plan.md`/
  `architecture.md` and the relevant `research/<topic-slug>.md`
  file rather than re-explaining the design in the brief.
- **Milestone discipline:** if a subagent, partway through its assigned task, determines the task actually spans
  multiple milestones or natural stopping points, it must NOT try to finish all of them in one run. It should complete
  only the first milestone, leave the code/tests in a clean, passing state, write a summary of what's done and what
  remains, and explicitly ask you to stop it and spawn a fresh subagent — with a narrowed brief covering the next
  milestone and a pointer to what's already landed — to continue. This keeps each subagent's context small and prevents
  stale context from an already-finished milestone bloating a long-running run.
- Be careful with your own context — it is the scarcest resource in this workflow, Don't read a subagent's diff yourself
  unless its written summary leaves a genuine, decision-relevant doubt (e.g. it claims something that contradicts
  `architecture.md`, or its summary is internally inconsistent) — trust the subagent's summary and test results
  otherwise. When you do need to check a diff, prefer a targeted `git show`/`git
  diff` on just the files the summary names over opening whole files, and avoid re-reading files you already reviewed
  earlier in the same topic. Never re-read a subagent's full transcript or output file "to be sure" — that defeats the
  purpose of delegating. If you're at risk of needing a large amount of context just to review one slice, that's a sign
  the slice was too broad — narrow the next one instead of paying the cost to review this one in full.
- Don't chain slices blindly off a subagent's self-report either, though: read at least its written summary before
  dispatching the next one, and cross-check it against `state.md`/`architecture.md` for consistency rather than the diff
  itself.

## State tracking (`.agents/state.md`)

Maintain `.agents/state.md` as the durable record of implementation progress, updated by you (the orchestrator)
immediately after each slice/milestone completes — not by subagents. Its purpose is recovery: if the whole workflow dies
or this session is lost, a fresh orchestrator run must be able to read `prompt.md`, `plan.md`, `architecture.md`,
`state.md`, and the `research/`
files and resume exactly where things left off, without re-deriving anything from git history.

Keep it current with, at minimum:

- Per-topic status (not started / in progress / done), referencing `plan.md`'s topic numbering.
- For any topic that's mid-flight, which milestone is done, which is next, and where the in-progress subagent left off
  (file/handler/test names, not prose).
- Any deviations from the proposed `architecture.md` design made during implementation, and why.
- Any open questions sent to a researcher subagent, and their resolution once it lands.
- The current position in `plan.md`'s sequencing recommendation (prerequisite → phase 1 → phase 2 → phase 3 → phase 4),
  so the next slice to dispatch is always obvious from this file alone.

Update this file as part of finishing each slice, before dispatching the next one — treat it as part of the definition
of done for a slice, not an afterthought.

## Useful tools for research subagents

Prefer the context-search skill and the idea MCP's code-intelligence tools over "grep"/"sed" etc. when reading and
understanding code — they resolve symbols and calls precisely and cost fewer tokens than raw text search. The idea MCP
exposes many tools unrelated to this research; stick to this shortlist:

- `mcp__idea__search_symbol` — find a class/method/field by name fragment; the entry point for "where is X defined".
- `mcp__idea__analyze_calls` — given a fully qualified symbol (from `search_symbol`), list its callers
  (`INCOMING_CALLS`)
  or callees (`OUTGOING_CALLS`). Use this instead of text search whenever you need to trace how a method is wired in,
  e.g. tracing every call site that would need to change for a v1→v2 API shift.
- `mcp__idea__get_symbol_info` — quick-doc lookup (signature, declaration, doc comment) for the symbol at a file:line.
- `mcp__idea__search_text` / `mcp__idea__search_regex` — fast text/regex search with match coordinates, for cases
  `search_symbol` doesn't cover (string literals, config keys, comments).
- `mcp__idea__search_file` / `mcp__idea__list_directory_tree` — locate files by glob or browse a directory's structure
  before diving in.
- `mcp__idea__read_file` — read project files (also decompiles/reads inside jars if a dependency needs inspecting).
- `mcp__idea__get_project_modules` / `mcp__idea__get_project_dependencies` — get a structured view of module layout and
  library dependencies, useful when sketching the current vs. proposed architecture.

## Useful tools for programmer subagents

Programmer subagents should prefer the idea MCP's code-intelligence and editing tools over raw shell text-munging
(`sed`/`awk`) wherever they fit — they're precise about symbols and cost fewer tokens than re-reading whole files. The
idea MCP exposes many tools unrelated to this work; stick to this shortlist:

- `mcp__idea__search_symbol` / `mcp__idea__get_symbol_info` — find a class/method/field and get its signature/doc
  without opening the whole file; the entry point for "where is X defined."
- `mcp__idea__analyze_calls` — list a symbol's callers/callees; use this instead of text search to find every call site
  that needs updating for a wire-shape or signature change (e.g. every place that constructs a v1 `ToolCallUpdate`
  before adding a v2 sibling).
- `mcp__idea__search_text` / `mcp__idea__search_regex` — fast text/regex search with match coordinates for string
  literals, `_meta` keys, config flags — cases symbol search doesn't cover.
- `mcp__idea__search_file` / `mcp__idea__list_directory_tree` — locate files by glob or browse a directory's structure
  before editing.
- `mcp__idea__read_file` — read project files (also decompiles/reads inside jars/deps if needed).
- `mcp__idea__apply_patch` — make precise, reviewable edits instead of full-file rewrites when a change is a small,
  structured diff (new handler registration, added branch, field rename).
- `mcp__idea__rename_refactoring` — use for genuine renames (e.g. a field rename like `id`→
  `configId` across a type and its call sites) instead of hand-editing every occurrence.
- `mcp__idea__get_file_problems` / `mcp__idea__lint_files` — check for type errors/lint issues in touched files before
  handing a slice back as done.
- `mcp__idea__build_project` — verify the project still typechecks/builds after a change, cheaper than shelling out
  where available.
- `mcp__idea__execute_run_configuration` / `mcp__idea__execute_terminal_command` — run the Vitest suite (or a narrowed
  subset) and any other project scripts (`npm run generate-types`, lint, release-preflight-adjacent scripts) as part of
  iterating to green.
- `mcp__idea__reformat_file` — normalize formatting on touched files to match project style.
- `mcp__idea__git_status` — check what's already changed/staged before starting, to avoid clobbering another in-flight
  subagent's work within the same session.

Editing/refactoring tools are in scope here (unlike for research subagents, which are read-only). Debugging tools
(`xdebug_*`), notebook/database/SQL tools, and Python-environment tools are still out of scope for this work.

Reference paths from the agent-client-protocol repository (`check-acp-specification` skill):
`docs/protocol/v2/migration.mdx`, and `docs/protocol/v2/` generally — read concrete files on demand rather than all at
once. The reference TypeScript SDK can be checked via the
`check-acp-typescript-sdk` skill when a subagent needs to confirm current SDK behavior (e.g. the
`agentProtocolRouter` API, or re-diffing a generated type against `origin/main`).
