---
name: run-codex
description: Run real Codex with a prompt to test and verify code during development. Use when debugging event handling, understanding Codex responses, or validating implementation changes against real behavior.
license: MIT
compatibility: Requires Node.js, tsx, and @openai/codex package installed. Codex authentication required.
---

# Run Real Codex Test

This skill runs real Codex with a prompt and captures all events for analysis during development.

## When to Use

- Testing new event handlers
- Debugging event processing issues
- Understanding Codex response format and event order
- Validating implementation changes against real Codex behavior
- Seeing actual token usage, rate limits, and other metadata

## How to Run

Execute the test script using npm:

```bash
npm run codex-test -- -p "Your prompt here"
```

### Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--prompt` | `-p` | Prompt to send to Codex (required) | - |
| `--cwd` | `-c` | Working directory for the session | Current dir |
| `--output` | `-o` | Output format: `all`, `codex`, `acp`, `summary` | `all` |
| `--json` | - | Output events as JSON | false |
| `--help` | `-h` | Show help message | - |

### Examples

```bash
# See all events for a simple prompt
npm run codex-test -- -p "What files are in this directory?"

# Test with specific working directory
npm run codex-test -- -p "Read the README" -c /path/to/project

# See only Codex events (raw server notifications)
npm run codex-test -- -p "Hello" -o codex

# See only summary (token usage, timing, event counts)
npm run codex-test -- -p "Hello" -o summary

# Get JSON output for analysis with jq
npm run codex-test -- -p "Hello" --json | jq '.method'
```

## Output

The script outputs events in real-time as they arrive:

1. **Codex Events** (`[CODEX]`): Raw events from Codex app server
   - `thread/started`, `turn/started`, `turn/completed`
   - `item/started`, `item/completed`, `item/agentMessage/delta`
   - `thread/tokenUsage/updated`, `account/rateLimits/updated`

2. **ACP Events** (`[ACP]`): Events sent to ACP connection
   - `sessionUpdate` with various update types

3. **Summary**: Aggregated statistics
   - Stop reason, duration, event counts
   - Token usage breakdown (input, cached, output, reasoning, total)
   - Event type frequency

4. **PromptResponse**: Full response object including `_meta.quota.token_count`
