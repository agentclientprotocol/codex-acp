# Native persistent queue controls / 原生持久队列

## English

Inspect `initialize._meta.queue.actions`; only individually probed native methods
are advertised. The tested floor is native 0.160.1, not an asserted first release.
All requests use `_session/queue` and a `sessionId`:

| action | Additional fields | Native result |
| --- | --- | --- |
| list | optional cursor, limit | data, nextCursor |
| add | input, clientUserMessageId | queuedSubmission |
| update | queuedSubmissionId, input | queuedSubmission |
| delete | queuedSubmissionId | deleted |
| reorder | queuedSubmissionIds | empty object |
| start | optional queuedSubmissionId | turn |

Responses are `{status:"ok",result:...}` or `{status:"unsupported"}`. Native
failures stay errors. `input` uses native UserInput, including `text_elements`;
this method does not convert ACP prompt blocks. `update` preserves the original
client message ID. Reorder supplies every current pending ID exactly once; a
stale set is rejected by native storage. List again after a conflict.

Queue persistence and scheduling use Codex's original `thread/queue/*` methods.
Adding to a loaded idle thread can start generation immediately. While a turn
runs, additions remain pending. Successful or failed completion advances the
queue. Consumption means accepted for execution, not successful completion.
Explicit start can select a non-head entry; subsequent entries retain their
order and drain automatically. It does not copy the entry into `session/prompt`.

The adapter installs notifications and interactive delegates before add/start or
native resume. Autonomous turns use fresh event and permission contexts.
Ordinary ACP updates carry output/tools/usage; `_session/queue/turn` carries
`{sessionId,turn}` at start and completion, including native status/error.
`_session/queue/changed` carries `{sessionId}` as an invalidation, not a snapshot
or an acknowledgement that generation has stopped. These notification names
are also exposed in the capability. Hosts must register them before use.

`session/cancel` interrupts the current owned turn. A native interrupted turn
preserves pending messages and suppresses automatic advancement; use explicit
start to continue. Cancel racing a completed turn is not an atomic pause of the
whole queue. Queue entries can still be edited/reordered/deleted during active
generation. Close keeps the closing fence while interrupting/unsubscribing.
The native unsubscribe operation is not itself a durable pause.

Unloaded queues can be listed, edited, reordered and deleted without resuming.
Add without an ACP session requires native `notLoaded` status, because an
unsubscribed but still loaded thread can auto-dispatch. Load an idle session
before explicit start. Load/resume may automatically execute a non-interrupted
persisted queue. Ordinary prompts are refused while a pending/active queue is
observed; use the queue start/control operations or explicit steering.
External native writers remain outside the adapter's admission fence.

Queue mutations are serialized against local lifecycle/settings changes and
bounded at 30 seconds. A timeout invalidates and terminates the provider using
the existing runtime recovery path. An ambiguous mutation failure fences later
queue writes until successful load/reconciliation. Never automatically retry an
add/start: admission and durable queue deletion are not one atomic operation.
No exactly-once execution, independent pause API or arbitrary native RPC tunnel
is promised. Subagent behavior remains subject to existing negotiated support.

Native source references: `codex-rs/app-server/src/request_processors/thread_queue_processor.rs`,
`codex-rs/ext/queue/src/service.rs`, `codex-rs/state/src/runtime/queued_items.rs`
at `e9e6cf63492da108a3cabaf3cc7b23d0640ef4cf`. Desktop calls the same six queue
operations. Source semantics and executable verification are separate evidence.

## 中文

客户端先读取 `initialize._meta.queue.actions`，仅调用逐项原生探测通过的动作。
接口 `_session/queue` 统一带 `sessionId`，参数和返回见上表。新增/编辑采用原生
UserInput（含 `text_elements`），不把 ACP prompt 格式直接混入。编辑保留原始
clientUserMessageId；重排必须包含当前全部待发 ID 且各一次，集合陈旧则重读后处理。

原生负责持久化和派发，不另建调度器。空闲已加载会话的 add 可能立即生成；生成中
新增则排队，正常结束或失败后继续下一条。start 可选择非队首消息，该条结束后按
剩余顺序继续。不能通过重发同一文本模拟 start，否则可能重复执行。

ACP 在 resume/add/start 前注册事件和审批处理，自动轮次使用独立生命周期。
输出/工具/用量沿用普通 session/update；`_session/queue/turn` 通知开始/结束及原生
turn 状态，`_session/queue/changed` 提醒重读列表。前端应先注册这两个通知。

session/cancel 中断当前轮次；原生 interrupted 状态保留剩余消息、暂停自动推进，
显式 start 恢复。取消恰好遇到轮次完成不构成全队列原子暂停，unsubscribe 也不等于
持久暂停。生成中允许编辑/重排/删除待发项。未加载队列可管理；无 ACP 本地会话时
add 必须确认原生 notLoaded，避免未订阅但仍已加载的线程自动生成无人处理。
load/resume 可能恢复非 interrupted 队列并自动执行。

30 秒 mutation 超时沿用 provider 失效与终止流程；结果不明确时要求成功 load 对账。
不自动重试 add/start、不承诺 exactly-once。外部原生客户端的并发写入不受 ACP
本地保护锁控制。此次仅扩展 ACP，Codeg 界面接入和全局安装不在本次改动中。
