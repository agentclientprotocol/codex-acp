Let's research how this ACP wrapper can be migrated to the ACP v2.
No actual migration is needed for now, only research. 
You goal is to estimate the effort and how the new architecture will look like.

There's a helper ACP Test Compatibility Kit located at /Users/eugene/Documents/JetBrains/projects/acp-tck, which can be used
to assess agent conformance to ACP v1 or v2. During implementation it can be used to verify the compatibility.
You can also check a distilled list of core v2 requirements in this ACP TCK, they are located at /Users/eugene/Documents/JetBrains/projects/acp-tck/src/tck/v2/requirements.py.
You can use this list to help guide your research.

## Orchestration

You are the orchestrator, not the researcher. Do not read source files, run searches, or draft findings yourself —
break the work into concrete topics/questions and spawn a dedicated research subagent per topic instead. Your job is
to define scope, dispatch subagents, and assemble/reconcile their outputs.

- Each subagent gets a narrow, well-defined brief: one topic or question (e.g. "how does the current session-lifecycle
  handling in this wrapper map to ACP v2's session model, per docs/protocol/v2/session.mdx" or "diff v1 vs v2 permission
  request/response shapes and enumerate every call site in this repo that constructs or parses them"), plus which
  requirements from `requirements.py` it's responsible for, and which output file to write.
- Each subagent writes its own output into `.agents/research/<topic-slug>.md`, and updates `.agents/plan.md` (effort
  estimate) and `.agents/architecture.md` (proposed design) with only the sections it owns — don't have two subagents
  racing on the same file/section.
- If a subagent determines its assigned topic is actually broad enough to span multiple milestones, it must NOT try to
  finish all of them in one run. It should complete only the first milestone, write its results, then explicitly report
  back to you that the topic needs to be split and ask you to stop it and spawn a follow-up subagent (with a fresh,
  narrowed brief covering the next milestone, referencing what's already written) to continue.
- Read subagents' output files yourself to reconcile overlaps/contradictions before folding them into the final
  `plan.md`/`architecture.md`, but leave the actual code exploration to them.
- Use Sonnet with high effort as a model for research subagents.

## Tools for research subagents

Prefer the context-search skill and the idea MCP's code-intelligence tools over "grep"/"sed" etc. when reading and
understanding code — they resolve symbols and calls precisely and cost fewer tokens than raw text search. The idea MCP
exposes many tools unrelated to this research; stick to this shortlist:

- `mcp__idea__search_symbol` — find a class/method/field by name fragment; the entry point for "where is X defined".
- `mcp__idea__analyze_calls` — given a fully qualified symbol (from `search_symbol`), list its callers (`INCOMING_CALLS`)
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

This is a read-only research task, so editing/refactoring/debugging tools from the idea MCP (apply_patch, rename_refactoring,
xdebug_*, notebook/database/SQL tools, etc.) are out of scope.

Reference paths from agent-client-protocol repository (check-acp-specification skill):
docs/protocol/v2/migration.mdx - might be a good starting point
docs/protocol/v2 - directory with comprehensive v2 documentation, no need to read all of it at once, only read concrete files of interest on demand.
