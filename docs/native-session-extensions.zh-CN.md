# 本地原生会话扩展

本测试版在 main `51aa211` 上整合 PR #508，adapter 2.1.1，冻结 Codex 0.160.1、SDK 1.5.0。保留主线 hooks、附件回放、工具调用协议与压缩处理。没有改 Codeg、全局安装、push 或新 PR。

## 已接入

- `_session/rewind`：保留原接口和作者提交；同 ID 回退首条、历史、最近消息。验证指纹/保留边界，生成中先取消并等待旧 prompt 清理，再调用原生回退并核验持久前缀。
- `_session/steering`：opt-in `_meta.steering.idleBehavior:"promptRequired"`，空闲返回 promptRequired，不偷偷启动模型。未 opt-in 保留旧行为。
- runtime read：context、usage、mcp、commands（native skills）、plugins。未知用量保留 null，不捏造分类。
- runtime control：reloadSkills、reconnectMcp、reloadPlugins；后两者要求 provider 空闲，确认回执不等于 runtimeReady。技能刷新后重发可用命令。
- archive/unarchive：原生可逆归档、同 ID；不新增永久删除。旧 session/delete 仍保持原来的 archive 语义。
- search：限定参数和 appServer/cli/vscode 来源；已验证当前 rollout synthetic 文本命中。回退后仅保留在祖先 rollout 的文本可能被原生搜索漏掉。
- attachments：原生 thread 元数据 list/add/remove、冷重启持久化；不创建/删除磁盘文件、PR 或 worktree。
- queue：只在真实 native 版本和无副作用探测通过后广告 list。写入/start 在 native mutation 前 unsupported；已有 durable pending queue 阻止 ACP load/resume，避免无人归属的自动生成。
- files/revert：限定单个已完成 native fileChange 工具的 Git 文本补丁。preview token 绑定原生补丁与文件指纹，提交前复核；不改会话历史。

## 文件语义与恢复

文件撤销不等于 whole checkpoint：不覆盖 shell、未记录子代理、二进制补丁。Git reverse check/apply 不用 --index/--cached/--3way；用户 index 和无关文件严格保持。恢复后的文本走 Git 属性/autocrlf，不保证原始字节或换行完全一致。未知 change kind、缺失 diff、冲突、陈旧 token、越界/链接路径整批拒绝。

runtime mutation 30 秒超时后使会话失效并尝试终止 provider，用户重连 ACP 再显式 load；不会自动重放 mutation。POSIX 将 provider（包括默认 Node launcher 及 native 子进程）置于独立进程组，通过私有控制管道请求组内 guardian 执行 SIGKILL；launcher/supervisor 退出或适配器管道关闭也触发清理。适配器不会向保存的 POSIX PID/PGID 发破坏性信号。只有 supervisor 已退出且组已消失才报告终止成功；无法确认或五秒超时均报失败。主动脱离该组的进程不在保证内。Windows 对仍存活的 owned launcher 使用 taskkill /T /F；launcher 已退出时无法再确认整树归属，明确报错且不针对旧 PID 清树。重复关闭复用同一结果，包括失败。读取超时返回 unavailable。历史回退 dispatch 后失败可能已改变磁盘，必须成功 load 对账再继续发送。

POSIX 监督复用当前运行时，不新增外部 Node 依赖。Bun 编译产物通过固定内置 supervisor/guardian 模式重入，在加载 ACP 模块或读取配置/日志设置前分发；模式要求私有管道描述符，不接收可执行源码。Node 和直接 Bun 运行使用同一份内置 helper 实现。两个小型 helper 分别负责保留 provider 退出状态和从 owned 组内部清理，不解释 ACP 消息；stdin EOF 和 stdout/stderr 使用继承的文件描述符，常规终止信号转发给 provider，额外控制管道在适配器中 unref。POSIX provider 启动失败通过 stderr 和 supervisor 退出码 1 报告。宿主 init 必须回收孤儿进程（容器使用 --init）；未回收的组可能超时报错，不虚报已停止。compiled native CODEX_PATH 路径已在 PATH 不含 Node 的条件下验证；这不代表另一个 bundled JavaScript launcher 路径在 compiled 发行物中的兼容性已得到验证。

## 尚未实现的 Desktop 能力

完整队列自动回合 observer/adoption、realtime voice、timeline、Desktop 项目/worktree/UI 全部管理、全工作区文件 checkpoint、二进制反向恢复、外部写入进程完全隔离、祖先 rollout 全文搜索均不宣称完成。native schema 存在某方法不等于本 ACP 已支持。

## 验证

Windows 完整套件 82 文件通过/8 跳过，1342 项通过/39 跳过；typecheck/build 通过；文件/lifecycle 增量 28 项通过。0.160.1 与 CODEX_PATH 0.159.3 的真实 ACP+native+localhost mock 模型隔离实验通过，未调用真实模型或用户会话。独立定向 review 六项复现全通过（含真实 owned-child 终止）；独立文件 RPC E2E 九项通过，覆盖真实 apply_patch、持久回放、预览、陈旧/冲突拒绝、index/无关文件字节保持、同会话继续；仍不代表所有交错均已验证。

协议细节见 [English](native-session-extensions.md)；原 rewind 作者 Nikita Ashikhmin，来源 [PR #508](https://github.com/agentclientprotocol/codex-acp/pull/508)，四条原提交保留在历史中。
