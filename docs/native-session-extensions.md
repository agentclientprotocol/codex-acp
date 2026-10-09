# Local native session extensions

This local test build integrates PR #508 on main `51aa211` (adapter 2.1.1, locked Codex 0.160.1, ACP SDK 1.5.0). It preserves current-main hooks, attachments, tool-call reports and compaction handling. No Codeg changes, global installation, push or new PR are included.

## Negotiated operations

Read the `initialize` metadata before invoking any extension. These are named methods with strict schemas, not a generic native RPC tunnel.

| Capability | Method | Contract |
|---|---|---|
| AIR `sessionRewind` | `_session/rewind` | Same ID, exclusive `beforeMessage`, optional `resumeAtMessage`; `{rewound:true}` only after persisted-prefix verification. |
| `_meta.steering.idleBehavior` | `_session/steering` | Opt in with `_meta.steering.idleBehavior:"promptRequired"`; idle returns `{outcome:"promptRequired"}` without starting a model request. Non-opted clients retain the existing idle new-turn behavior. |
| `_meta.runtime` | `_session/runtime/read` | `resource`: context, usage, mcp, commands, plugins. Unknown measurements stay null. Commands are native skills; this is not a list of every Desktop UI command. |
| `_meta.runtime` | `_session/runtime/control` | `action`: reloadSkills, reconnectMcp, reloadPlugins. Skill reload republishes available commands. MCP/plugins are provider-wide idle operations; their acknowledgement is not runtime readiness. |
| `_meta.archive` | `_session/archive`, `_session/unarchive` | `{sessionId}`; reversible native archive, same ID. Existing standard session/delete keeps its prior archive-backed behavior. No permanent delete. Archive closes local routing; unarchive requires load to reopen. |
| `_meta.discovery` | `_session/search` | Bounded searchTerm/cursor/limit/archived. Searches user sources appServer/cli/vscode. Current native search can miss text retained only through ancestor rollout lineage after rewind. |
| `_meta.discovery` | `_session/attachments` | list/add/remove native metadata only. Does not create/delete a file, worktree, PR or prompt attachment. Loaded-session ownership required. |
| `_meta.queue` | `_session/queue` | Only list is advertised after actual-native version and positive nonmutating method probe. Writes/start return unsupported before native mutation. Pending native queues prevent ACP load/resume to avoid unowned auto-dispatch. |
| `_meta.fileRevert` | `_session/files/revert` | `{sessionId,toolCallId,dryRun,previewToken?}`; reverse one completed native fileChange tool's recorded text patches in Git. Preview token required for apply. History stays unchanged. |

## File reversal

Preview and commit re-read native history and fingerprint affected files. A stale preview, conflict, unknown change kind, binary/unsupported patch or unsafe path fails closed for the entire batch. Git uses reverse check/apply without --index/--cached/--3way, preserving the user's index and unrelated bytes. Reverted text follows Git attributes/autocrlf and is not promised to be byte-identical to its original encoding/newlines. Shell changes, unrecorded subagents and whole-workspace checkpoints are outside coverage.

The server reserves the provider while validating loaded native threads and background terminals. External editors and unrelated processes are not controlled by this fence; Git conflict checks and fresh fingerprints narrow but do not eliminate an OS-level race.

## Timeouts and recovery

POSIX supervision uses the current runtime and adds no external Node dependency. Compiled Bun executables re-enter fixed built-in supervisor/guardian modes before importing the ACP application or reading configuration/log settings; these modes require private pipe descriptors and accept no executable source. Node and direct Bun runs execute the same built-in helper implementation. The two small helpers preserve the provider's exit status and perform cleanup from within the owned group; they do not interpret ACP traffic. stdin EOF and stdout/stderr use inherited descriptors, common termination signals are forwarded, and the extra control pipe is unreferenced in the adapter. A POSIX provider spawn error is reported on stderr with supervisor exit code 1. Orphaned processes must be reaped by the host init (use --init in containers); unreaped groups can time out rather than be reported stopped. Compiled native CODEX_PATH launch is tested with Node absent from PATH; this does not establish compatibility of the separate bundled JavaScript launcher path in compiled distributions.

Runtime mutations have a 30-second deadline. Timeout invalidates local sessions and attempts to terminate the owned provider; reconnect the ACP adapter and explicitly load a session. No mutation is replayed. POSIX launches the provider (including the default Node launcher and native child) in a dedicated process group with a guardian. A private control pipe requests SIGKILL from inside that group; launcher/supervisor exit or adapter pipe closure also triggers cleanup. The adapter never sends a destructive signal to a remembered POSIX PID or PGID. Termination succeeds only after the supervisor exits and the group disappears; an unverifiable group or a five-second deadline is a failure, not a stopped-provider result. Processes that deliberately leave the group are outside this guarantee. Windows retains taskkill /T /F for a live owned launcher; if the launcher has already exited, tree ownership can no longer be verified and termination fails without targeting its old PID. Repeated termination calls share the same result, including failures. Read timeouts return unavailable. A history mutation with an uncertain outcome blocks further sends until successful load/reconciliation.

## Desktop parity boundaries

Supported and locally exercised: same-ID first/latest/historical/repeated rewind, cancel-and-settle, cold load, resend context truncation, runtime status/control, archive/unarchive, attachment metadata persistence, safe idle steering, native search of current rollout, queue inspection and per-tool text patch reversal.

Not claimed: full native queue automatic-turn adoption, realtime audio/voice, timeline API, complete Desktop project/worktree/UI management, whole-session file checkpoint restore, binary reverse patches, all child process/background writer isolation, or complete search over retained ancestor rollouts. A native schema method does not establish an implemented ACP handler.

## Validation

Full suite: 82 test files passed, 8 skipped; 1342 tests passed, 39 skipped on Windows. Typecheck/build passed. Additional file/lifecycle regression: 28 passed. Isolated ACP plus native plus localhost mock model covered 0.160.1 and CODEX_PATH 0.159.3; no real model or real user session was used. Independent focused review passed 6/6 reproductions, including real owned-child termination. The native file RPC E2E passed 9 checks (actual apply_patch, persisted replay, preview, stale/conflict refusal, index/unrelated-byte preservation and same-session continuation). These are scoped findings, not proof of every interleaving.
