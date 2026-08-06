# Codex goal extension

Codex goals are a vendor extension implemented by `codex-acp`; they are not part of the base Agent Client Protocol.

## Commands and state

An ACP client starts and controls one goal per session through the built-in commands:

- `/goal <objective>` starts a goal.
- `/goal pause` pauses it.
- `/goal resume` resumes it.
- `/goal clear` removes it.

Goal state is published in `session_info_update._meta.codex.goal`. The snapshot contains `objective`, `status`, `tokenBudget`, `timeUsedSeconds`, `createdAt`, and `controlMethod`. `controlMethod` is `_codex/session/goal_control`; that extension method accepts `pause` and `clear` actions for clients that expose goal controls outside the prompt composer.

## Prompt lifecycle

Starting or resuming an active goal creates one logical ACP prompt lifecycle. Every automatic Codex turn produced by that goal belongs to the same prompt, including turns that start after an idle gap.

The prompt completes when:

- the goal becomes `paused` or `complete`;
- the goal is cleared;
- its current turn is interrupted; or
- setting the goal produces no continuation turn within the runtime-effects grace period.

A terminal goal update does not complete the prompt until the currently routed turn finishes. A completed turn does not complete the prompt while the goal remains `active`.

This correlation is local to `codex-acp`; the Codex app-server wire protocol remains unchanged. `GoalRunLifecycle` owns the state machine, while `CodexAppServerClient` only routes `thread/goal/*`, `turn/*`, and thread-status notifications into it.
