# Session outputs

Set `CODEX_ACP_SESSION_OUTPUTS_DIR` to an absolute POSIX directory owned by the
adapter's Bot runtime. The session owns the subdirectory named for its Codex
thread ID. Developer instructions direct the model to write deliverables there.

On ACP v1 and v2, the adapter advertises `_meta["com.oomol.leina/sessionOutputs"]`
with `{"version":1}` when the directory is configured. The client must scope the
connection to the authorized Bot and check access to the individual session.

- `_com.oomol.leina/outputs/list` takes `{sessionId}` and returns
  `{outputs:[{id,name,ref,size,revision}]}`. The list includes at most 500
  regular files. A missing directory returns an empty list. `id` is a stable
  URL-safe encoding of the relative filename for this session. `ref` matches
  absolute Markdown file references, and `size` is the byte length.
- `_com.oomol.leina/outputs/read` takes `{sessionId,outputId,offset,length,revision?}`.
  It returns `{name,size,revision,dataBase64}` with up to 1 MiB of bytes. Use
  the first response's `revision` in subsequent reads to detect changes.
  A missing or out-of-scope file returns `-32002`, a changed file returns
  `-32010`, and invalid parameters return `-32602`.
- `session/delete` deletes the Codex thread and then the session's output
  directory. Retry the same request if cleanup fails after thread deletion.

The adapter serves the current file contents. The same ID can read updated
bytes if the file is replaced. The caller uses a new revision on the next download.
