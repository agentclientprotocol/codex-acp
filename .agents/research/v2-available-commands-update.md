# What is the ACP v2 wire shape of `available_commands_update` / `AvailableCommand` (especially `input`), how does it differ from v1, and how should codex-acp render its v1-shaped internal updates for v2 connections?

**Sources checked:**
- `agent-client-protocol` (spec) @ `c2452704b53af74238d11d9fb0d5f816b802f9df` (2026-09-23), `git pull --ff-only`: already up to date
- `acp-typescript-sdk` @ `69fda3703bfb3a33d2f0e9fa6b90081270297d4c` (`v1.5.0-1-g69fda37`, 2026-09-23), `git pull --ff-only`: already up to date
- Installed `@agentclientprotocol/sdk` 1.5.0 in `codex-acp/node_modules` (`dist/v2/schema/*.gen.*`)
- codex-acp working tree on branch `eugenethedev/acp-v2` (HEAD `2d822df`)

**Confidence:** high. The spec JSON schemas (stable v2 and unstable v2), the Rust models, the migration guide, the slash-commands doc, the SDK's generated types and zod validators all agree. I also checked the SDK's receive-side parsing by running its v2 zod validator on sample payloads.

## Answer

The only wire difference in this variant is inside `AvailableCommand.input`. In v1 it is an untagged `{hint, _meta?}` (`UnstructuredCommandInput`). In v2 it is a tagged union: `{type: "text", hint, _meta?}` (`TextCommandInput` plus a required `type: "text"`), or an open "other" variant `{type: string, ...}` for custom (`_`-prefixed) or future types. Everything else is the same on both versions: the `sessionUpdate: "available_commands_update"` tag, the `availableCommands` array, `name`, `description`, the optional and nullable `input`, and `_meta` at the update, command and input levels.

`toV2SessionUpdate` should copy the update and, for each command whose `input` is a non-null object, add `type: "text"`. Commands with `input: null` or no `input` pass through unchanged, since null is valid in v2.

A v2 client still invokes a command as a plain text block (`"/name rest"`) in `session/prompt`, so codex-acp's slash-command parsing does not need to change. What does change on v2 is the prompt insertion contract for locally handled commands (return a `messageId` and report a `user_message`). That belongs to the prompt-lifecycle work and is listed under Open questions.

## Requirements

| # | Requirement | Tier | Citation |
|---|-------------|------|----------|
| 1 | Agent may advertise commands via `available_commands_update` after creating a session, and may re-send it at any time to replace the list | MAY | spec `docs/protocol/v2/slash-commands.mdx:10`, `:77` |
| 2 | `AvailableCommandsUpdate.availableCommands` (array of `AvailableCommand`) is required | MUST | spec `schema/v2/schema.json:5516` (`required: ["availableCommands"]`); `schema/v2/schema.unstable.json:7219` |
| 3 | `AvailableCommand.name` and `.description` (strings) are required | MUST | spec `schema/v2/schema.json:5418` (`required: ["name","description"]`); `docs/protocol/v2/slash-commands.mdx:53-59` |
| 4 | `AvailableCommand.input` is optional and nullable (`anyOf [AvailableCommandInput, null]`) | MAY | spec `schema/v2/schema.json:5418` (input property); `docs/protocol/v2/slash-commands.mdx:61-63`; Rust `agent-client-protocol-schema/src/v2/client.rs:1415-1418` |
| 5 | When `input` is present it MUST carry a `type` discriminator (`required: ["type"]` in both union arms); text input uses `type: "text"` | MUST | spec `schema/v2/schema.json:5451-5498`; `docs/protocol/v2/migration.mdx:73`, `:674`, `:742` ("Add the `type: \"text\"` discriminator to command `input` specifications") |
| 6 | `TextCommandInput.hint` (string) is required | MUST | spec `schema/v2/schema.json:5499` (`required: ["hint"]`); `docs/protocol/v2/slash-commands.mdx:69-71` |
| 7 | `_meta` is optional and nullable on `AvailableCommandsUpdate`, `AvailableCommand` and `TextCommandInput`; implementations MUST NOT make assumptions about its values | MAY (field) / MUST NOT (interpretation) | spec `schema/v2/schema.json` `_meta` properties of the three defs above |
| 8 | Custom input types MUST begin with `_`; unknown non-`_` types are reserved for future ACP variants | MUST (only for agents that emit custom types; codex-acp does not) | spec `docs/protocol/v2/slash-commands.mdx:73`; `schema/v2/schema.json:5470-5497` (the "other" arm description) |
| 9 | Clients should preserve unknown input types when storing, replaying or proxying, and otherwise show the command without structured input | SHOULD (client-side) | spec `docs/protocol/v2/slash-commands.mdx:73`; `docs/protocol/v2/migration.mdx:696` |
| 10 | Clients read command `input` as a tagged union | client-side migration step | spec `docs/protocol/v2/migration.mdx:760` |
| 11 | Commands are run as ordinary text in `session/prompt` (`"/web agent client protocol"`) and may come with other content blocks | descriptive (unchanged from v1) | spec `docs/protocol/v2/slash-commands.mdx:79-100`; v1 `docs/protocol/v1/slash-commands.mdx:75+` |
| 12 | The v2 prompt insertion contract also applies to commands: the prompt response returns the inserted user message's `messageId`, and the agent reports it through `user_message` / `user_message_chunk` with the same ID, including for locally handled commands (live-only insertion allowed; if replayed, reuse the ID and do not run it again) | MUST per the prompt-lifecycle contract (adjacent topic, see Open questions) | spec `docs/protocol/v2/slash-commands.mdx:102-104`; `docs/protocol/v2/prompt-lifecycle.mdx:182` |
| 13 | No capability gates `available_commands_update` on v1 or v2 | n/a (not capability-conditional) | spec `docs/protocol/v2/slash-commands.mdx` (no capability mentioned); `docs/protocol/v2/prompt-lifecycle.mdx:30`, `:39` |

## Details

### v1 wire shape (stable `schema/v1/schema.json`; `schema.unstable.json` is identical for these defs)

- `SessionUpdate` arm: `sessionUpdate: "available_commands_update"` + `AvailableCommandsUpdate` (`schema/v1/schema.json:3752-3766`).
- `AvailableCommand` (`schema/v1/schema.json:4043`): `name` (req), `description` (req), `input?: AvailableCommandInput | null`, `_meta?`.
- `AvailableCommandInput` (`schema/v1/schema.json:4076`): `anyOf` with a single arm titled `unstructured` → `UnstructuredCommandInput`. It has **no discriminator**.
- `UnstructuredCommandInput` (`schema/v1/schema.json:4090`): `hint` (req), `_meta?`.
- `AvailableCommandsUpdate` (`schema/v1/schema.json:4107`): `availableCommands` (req), `_meta?`.
- Rust: `#[serde(untagged)] enum AvailableCommandInput { Unstructured(UnstructuredCommandInput) }` (`agent-client-protocol-schema/src/v1/client.rs:903-908`, `:917`).
- SDK 1.5.0 v1 types: `AvailableCommandInput = UnstructuredCommandInput` (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:3801`, `:3805`).

### v2 wire shape (stable `schema/v2/schema.json` and `schema/v2/schema.unstable.json`)

The two v2 files are identical for these definitions apart from the `_meta` doc links (`/protocol/v2/extensibility` vs `/protocol/v2/draft/extensibility`). I checked this with a `jq -S` diff.

- `SessionUpdate` arm name unchanged: `schema/v2/schema.json:4495-4509`, `schema/v2/schema.unstable.json:5948`.
- `AvailableCommand`: `schema/v2/schema.json:5418`, `schema.unstable.json:7121`. Same fields as v1.
- `AvailableCommandInput`: `schema/v2/schema.json:5451`, `schema.unstable.json:7154`. It is an `anyOf` of:
  1. `{type: const "text"}` (required `type`) `allOf` `TextCommandInput`
  2. `"other"`: `{type: string}` (required), `additionalProperties: true`, `not` `{type: "text"}`
- `TextCommandInput` (`schema/v2/schema.json:5499`, `schema.unstable.json:7202`): `hint` (req), `_meta?`. This is `UnstructuredCommandInput` under a new name.
- `AvailableCommandsUpdate`: `schema/v2/schema.json:5516`, `schema.unstable.json:7219`. Unchanged apart from a trailing period in the description.
- Rust v2: `#[serde(tag = "type", rename_all = "snake_case")] enum AvailableCommandInput { #[serde(rename="text")] Text(TextCommandInput), #[serde(untagged)] Other(OtherAvailableCommandInput) }` (`agent-client-protocol-schema/src/v2/client.rs:1464-1483`). `Other` refuses to deserialize a known type (`"text"`) that failed its schema (`:1517-1540`). The tests confirm the text serialization `{"type":"text","hint":"Describe changes"}` (`:3485-3499`), and that `{"hint": "Pick one"}` without a `type` is **rejected** as `AvailableCommandInput` (`:3780-3786`).
- SDK 1.5.0 v2 generated types (`node_modules/@agentclientprotocol/sdk/dist/v2/schema/types.gen.d.ts`): `AvailableCommand` `:4082` (`input?: AvailableCommandInput | null`), `AvailableCommandInput = (TextCommandInput & {type: "text"}) | {type: string; [key: string]: unknown}` `:4109`, `TextCommandInput` `:4125`, `AvailableCommandsUpdate` `:4144`, and the `SessionUpdate` arm `:3439`. The SDK checkout matches: `src/v2/schema/types.gen.ts:4414`, `:4442`, `:4461`, `:4481`.
- SDK 1.5.0 v2 zod (`dist/v2/schema/zod.gen.js`): `zTextCommandInput` `:2051`, `zAvailableCommandInput` `:2062` (`preserveCustomPayload(z.union([text.and({type: literal "text"}), excludeKnownTags({type: string}, "type", ["text"])]))`), `zAvailableCommand` `:2073` (`input: defaultOnError(zAvailableCommandInput.nullish(), () => undefined)`), `zAvailableCommandsUpdate` `:2082` (`vecSkipError`).

### Side-by-side

| Field | v1 | v2 | Mapping |
|---|---|---|---|
| `sessionUpdate` | `"available_commands_update"` | same | copy |
| `availableCommands` | `AvailableCommand[]` (req) | same | map each item |
| `_meta` (update) | optional, nullable | same | copy |
| `name` / `description` | req strings | same | copy |
| `_meta` (command) | optional, nullable | same | copy (codex-acp's `commandAction` extension keeps working) |
| `input` absent / `null` | allowed | allowed | copy unchanged |
| `input` object | `{hint, _meta?}` | `{type: "text", hint, _meta?}` | add `type: "text"` |

The upstream conversion helpers that were removed in `712dbfa` ("refactor(unstable-v2): remove conversion helpers (#1809)", deleted file `agent-client-protocol-schema/src/v2/conversion.rs`) implemented this same mapping: `v1::AvailableCommandInput::Unstructured(v) → v2::AvailableCommandInput::Text(v)`, with `UnstructuredCommandInput → TextCommandInput` copying `hint` and `_meta`. The v2 `Other` arm had no v1 form and returned an error. This is design-intent evidence only, because the helpers no longer exist.

### What codex-acp emits today

- Built in `src/CodexCommands.ts` `publish()` `:57-78`, which sends `{sessionUpdate: "available_commands_update", availableCommands}` through `ACPSessionConnection.update` (`:68-72`). The element type is the v1 SDK `AvailableCommand` (`:2`).
- `buildAvailableCommands` (`:86-106`) merges the built-ins with skill commands named `$<skill>`. Skill commands always get `input: null` (`:98-102`). Codex's `skills/list` metadata (`src/app-server/v2/SkillMetadata.ts`) has no input-hint field.
- Built-ins (`getBuiltinCommands`, `:111-184`):
  - `input: null`: `plan` (`:116`), `mcp` (`:130`), `skills` (`:135`), `status` (`:140`), `compact` (`:160`), `logout` (`:181`).
  - `input: {hint}` only (no `_meta`): `review` (`:145`), `review-branch` (`:150`), `review-commit` (`:155`), `goal` (`:165`), `rename` (`:176`).
  - Command-level `_meta.commandAction` extensions: `plan` (`:117-125`) and `goal` (`:166-171`).
  - codex-acp never sets `input._meta`. It also never omits `input`; it always uses `null` for commands without input.
- v2 routing: `ACPSessionConnection.ts:24-29` (`AcpV2Connection.updateSession`) sends `toV2SessionUpdate(update)` through `acpV2.methods.client.session.update`. `toV2SessionUpdate` currently throws `internalError` for `available_commands_update` (`src/AcpV2SessionUpdate.ts:41-51`). `publish()` catches that and logs it (`CodexCommands.ts:73-77`), so a v2 client gets no command list today. The failure is logged, not surfaced to the client.

### SDK send and receive behavior (why the rendering is needed)

- Sending: the v2 SDK does not validate outgoing notification params. Zod parsing only runs on receive (`acp-typescript-sdk src/v2/acp.ts:2150-2160` `parseParams`, used from `registerAppNotification` `:2229-2244`). `AcpV2SessionUpdate.ts:9` in codex-acp says the same. So a v1-shaped `input` would go onto the wire unchanged.
- Receiving on an SDK v2 client: `onNotification(methods.client.session.update, …)` uses the built-in spec with `zUpdateSessionNotification` (`src/v2/acp.ts:3417-3428`, `:2501-2503`). I ran the installed 1.5.0 validator on `availableCommands: [{name, description, input}]` and got:

  | sent `input` | client receives |
  |---|---|
  | `{hint:"x"}` (v1 shape) | `input` **silently dropped**, command kept |
  | `{type:"text", hint:"x"}` | `{hint:"x", type:"text"}` (zod puts `hint` first) |
  | `null` | `null` |
  | omitted | omitted |
  | `{type:"text"}` (no hint) | dropped |
  | `{type:"_choices", options:[1]}` | preserved as-is |

  A Rust v2 client behaves the same way. `input` is `DefaultOnError` (`v2/client.rs:1415-1418`) and `{hint}` fails the tagged enum (`:3780-3786`), so the hint is dropped without an error. Without the rendering, v2 clients would lose every input hint without any error.

### Invoking commands on v2

- Wire: this is unchanged. The client sends `session/prompt` with `prompt: [{type: "text", text: "/review focus on tests"}, …]` (`docs/protocol/v2/slash-commands.mdx:81-100`). There is no dedicated command-invocation method or structured argument payload in v1 or v2, and the `input` spec is only a UI hint.
- codex-acp parsing (`CodexCommands.ts:186-203` `parseCommand`: first block must be `type: "text"` and start with `/`; the name is lower-cased and the rest trimmed; `$`-prefixed names fall through to Codex at `:213`) does not depend on the command-advertisement wire shape. It keeps working as long as the v2 prompt path hands it text blocks in the same `{type: "text", text}` form.
- What does change on v2 is the response and reporting around a handled command (Requirement 12): return `messageId`, and report a live `user_message` even when the command is handled locally (e.g. `/status`, `/rename`, `/logout`). That is prompt-lifecycle scope. See Open questions.

## Testability notes

- **Conforming rendering:** with the existing harness in `src/__tests__/CodexACPAgent/session-update-v2.test.ts` (`connectV2Client()` at `:56-74`, a real SDK v2 client over the router), send an `available_commands_update` holding (a) one command with `input: {hint}`, (b) one with `input: null`, (c) one with `_meta.commandAction`. Snapshot what the client receives with `toMatchFileSnapshot`. Conforming output: (a) has `input: {hint, type: "text"}` (zod key order is `hint` before `type`), (b) keeps `input: null`, (c) keeps `_meta` unchanged.
- **Non-conforming output is silent on the client side.** If the rendering is skipped, the client does *not* error. `input` just disappears (see the receive table). A test must therefore assert that `input` is present with `type: "text"`, not only that a notification arrived. A snapshot covers this.
- **Pure unit test:** `toV2SessionUpdate()` is a pure function, so a direct call can assert the exact outgoing object (with `type` and field order as written), independent of zod reordering. This catches a regression before the client's parser hides it.
- **End-to-end:** the existing `available-commands-build-in.json` / `available-commands-skills.json` scenarios (`CodexAcpClient.test.ts:1581`, `:1615`) run on v1. A v2 variant of one of them would cover the full `publish()` → router → v2 client path.
- **v1 regression:** the v1 path must still emit untagged `{hint}`. `session-update-v1-routed.json` (`session-update-v2.test.ts:119-140`) is the model for this.
- **Unobservable / not testable here:** whether a real client renders hints, and whether it preserves unknown `type`s. Those are client-side behaviors.

## Discrepancies

- **Spec, SDK and Rust agree** on the v2 shape and on lenient receive-side handling (drop invalid `input`, skip invalid list items). I found no conflict in this variant.
- **Only prose states the `_` prefix rule for custom types.** `slash-commands.mdx:73` says custom types MUST begin with `_`, but neither the JSON schema's `other` arm (`schema/v2/schema.json:5470-5497`) nor the SDK zod (`excludeKnownTags(..., ["text"])`) enforces it. Any non-`text` string is accepted. This does not matter to codex-acp, which only emits `text`.
- **Doc example vs. codex-acp:** the spec examples omit `input` for commands without input (`slash-commands.mdx:29-32`), and Rust serializes `None` as an omitted key (`skip_serializing_none`, `v2/client.rs:1403`). codex-acp sends `input: null`. Both forms are schema-valid in v1 and v2, and the SDK zod keeps `null`, so this is a style difference, not a conformance issue.
- **codex-acp is currently stricter than necessary:** `toV2SessionUpdate` throws (`AcpV2SessionUpdate.ts:41-51`), so v2 clients get no command list, while the protocol-level failure mode would only be lost hints. The mapping below is lossless, so the throw can simply be replaced.

## Open questions

1. **v2 prompt insertion contract for locally handled slash commands** (Requirement 12: `messageId` in the prompt response, a live `user_message` / `user_message_chunk` for commands handled in `tryHandleCommand`, no re-run on replay). This belongs to the prompt-lifecycle topic; `.agents/research/v2-prompt-lifecycle-and-turn-state-machine.md:134` already mentions `tryHandleCommand`. Route it there to confirm it is covered.
2. **v2 `ContentBlock` typing for `tryHandleCommand` / `parseCommand`.** These take v1 `acp.ContentBlock[]` (`CodexCommands.ts:186`, `:206-207`). The text block itself is `{type: "text", text}` on both versions, but whether the v2 prompt handler passes v2 blocks straight through or converts them first belongs to whoever owns the v2 `session/prompt` binding.
3. **Command-emitted agent text on v2.** `/status`, `/skills`, `/mcp` and `/logout` reply with `agent_message_chunk` (`CodexCommands.ts:271`, `:286`, `:300`, `:318`), which currently throws on v2 because `messageId` is now required. This is already tracked as "Topic 6" in `AcpV2SessionUpdate.ts:32-38` and `.agents/research/v2-tool-calls-messages-and-terminal-streaming.md:287`.

## Mapping for toV2SessionUpdate

Replace the `available_commands_update` throw in `src/AcpV2SessionUpdate.ts` (`:42`, currently grouped with the subagent/async-task cases at `:41-51`) with its own case:

```ts
case "available_commands_update":
    return {
        ...update,                       // keeps sessionUpdate and update-level _meta
        availableCommands: update.availableCommands.map((command) => ({
            ...command,                  // keeps name, description, command-level _meta (e.g. commandAction)
            input: command.input == null
                ? command.input          // null stays null; undefined stays omitted — both valid in v2
                : {...command.input, type: "text" as const},  // v1 UnstructuredCommandInput -> v2 TextCommandInput
        })),
    };
```

Rules:
1. `sessionUpdate`, update-level `_meta`, and each command's `name`, `description` and `_meta` are copied unchanged.
2. `input === null` → `null`. `input === undefined` / key absent → leave it absent. Do not produce `input: undefined` if you care about exact snapshot keys; `JSON.stringify` drops it anyway.
3. `input` object → `{...input, type: "text"}`. This keeps `hint` (required) and `input._meta` if present. Writing `type` last means the tag can never be overwritten. The v1 type is closed (`hint`, `_meta` only), so no other keys reach this branch.
4. Do not emit any other `type`. codex-acp has no custom input kinds. If one is ever added, it MUST use a `_`-prefixed type (`slash-commands.mdx:73`).
5. No other field in this variant differs between v1 and v2. The v1 path (`AcpConnection`) keeps sending the untagged `{hint}`.
