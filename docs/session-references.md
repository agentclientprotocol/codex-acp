# Cross-session references

The adapter recognizes an ACP `resource_link` with this URI form:

```text
acp-session://reference?sessionId=<Codex thread ID>
```

The client can add query parameters for navigation. The adapter reads only `sessionId`.

The adapter passes `codex://threads/<Codex thread ID>` to Codex. Codex resolves this deep link.

The adapter does not pass the link title. It does not read or copy the referenced session.

The adapter preserves the order and number of links. It leaves other resource links unchanged.
