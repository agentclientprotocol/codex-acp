# Cross-session references

The adapter recognizes an ACP `resource_link` with this URI form:

```text
acp-session://reference?sessionId=<Codex thread ID>
```

The client can add query parameters for navigation. The adapter reads only `sessionId`.

The adapter passes the thread ID and `codex://threads/<Codex thread ID>` to Codex.
It tells Codex to call `read_thread` before it uses the referenced content.

The adapter does not pass the link title. It does not copy the referenced session into the prompt.
The private MCP server reads the session only when Codex calls a thread tool.

The adapter preserves the order and number of links. It leaves other resource links unchanged.

See [`src/thread-tools-mcp/README.md`](../src/thread-tools-mcp/README.md) for the MCP server design.
