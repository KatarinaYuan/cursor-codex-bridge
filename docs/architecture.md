# 架构与数据存储

```text
Laptop 上的 Codex App 原生聊天
  └─ 独立 SSH 别名
      └─ 远端 codex wrapper
          └─ 原版 Codex proxy → 私有 Unix socket → 协议桥
              ├─ 新聊天 → Cursor ACP → Cursor 模型
              ├─ 旧聊天 → 运行中的 tmux Agent / 原 ID 恢复
              ├─ 历史扫描 → 原生 thread/turn 映射
              └─ 文件、终端等辅助 RPC → 原版 Codex support server
```

桥拦截聊天 API，Cursor 负责模型执行、账号和计费。辅助 Codex 进程负责原生 App 所需的其他接口；未实现的聊天 API 明确返回错误，不回退为 Codex 模型推理。安装器不修改 Codex App 安装文件。

## 三条聊天路径

新聊天通过 `agent acp` 通信，桥转换线程、消息、进度和审批。历史模型选项来自远端 Agent；不预设所有账号都拥有相同模型。

普通 Cursor CLI 历史与 ACP 会话命名空间不同。桥保存原 Cursor ID、工作目录、模型、原生 ID 和同步映射，以便续聊和去重。没有可用 tmux 绑定时，通过 `agent --resume` 恢复旧会话。

在 Linux 上，桥可通过进程打开的 Cursor 数据库关联默认 tmux server 内的窗口，核对 PID、启动时间、前台状态及会话 ID。成功绑定后共享原进程输入框；无法安全核对一个已知存活的进程时，拒绝另起 Agent。CLI 草稿、审批或未知界面均阻止自动输入。

tmux 实时预览来自终端画面，最终内容来自 Cursor 写入的历史。桥保留原生 turn/item ID，避免预览和正式回复重复。它不会替换已有 `pipe-pane` 或修改全局 tmux 配置。

## 数据与生命周期

安装器输出本次安装的程序、wrapper、状态目录和配置文件位置。安装 ID 是桥别名的小写形式经 SHA-256 后的前 16 位；自定义别名时，后续管理命令需继续传同一个 `--alias`。

| 内容 | 默认位置（远端当前用户） |
| --- | --- |
| 程序版本 | `~/.local/share/cursor-codex-bridge/<id>/releases/` |
| 当前版本 | `~/.local/share/cursor-codex-bridge/<id>/current` |
| Codex wrapper | `~/.local/share/cursor-codex-bridge/<id>/bin/codex` |
| 专用状态 / `CODEX_HOME` | `~/.local/state/cursor-codex-bridge/<id>/` |
| 共享私有运行时 | `~/.local/share/cursor-codex-bridge/runtimes/` |

每个独立连接使用专用 `CODEX_HOME`，避免与普通 Codex 会话存储混用。桥记录会包含聊天正文、来源 ID、工作目录和模型；请按私人聊天数据管理。安装器优先检测 SSH 是否允许 `CODEX_HOME` 环境转发，不允许时测试 `LC_CURSOR_CODEX_BRIDGE`（常见服务端接受 `LC_*`）；均不接受则停止并报告，不修改 `sshd_config`。

默认历史同步周期为 2 秒。后台扫描只读取 Cursor 来源数据；CLI 在历史中写入新内容后，桥向已连接的 App 推送变更。没有消息的会话不会立即出现在列表中，历史删除也不自动删除已导入的桥记录。

断开 SSH 或关闭 App 只结束桥观察；原来的 tmux Agent 继续运行。升级和卸载通过 maintenance RPC 建立空闲屏障后，仅向精确识别的桥服务发送 SIGTERM，不结束 Cursor Agent。忙碌时拒绝操作；缺少管理协议的旧手动部署不被接管。新安装可以与旧手动部署并存，但不迁移其配置或状态。

卸载保留桥记录、原 Cursor 数据和共享运行时。若确实要删除保留记录，请先检查安装器输出的路径并自行备份。

同一状态目录只运行一个桥服务。额外的排障客户端应连接现有 socket，不应另起共享同一 `CODEX_HOME` 的 stdio 桥。

## 缺失运行时的私有安装

远端有 Node.js 22+ 或原版 Codex CLI 时优先复用；否则安装到上述 `runtimes/`。安装器从 HTTPS 下载固定版本，并验证发布元数据中的摘要，失败即停止：

- Node.js `22.23.1`：官方 [nodejs.org 发布目录](https://nodejs.org/dist/v22.23.1/)，验证 `SHASUMS256.txt` 中的 SHA-256。
- Codex CLI `0.160.0`：官方平台包的 npm registry 元数据（例如 [Linux x64](https://registry.npmjs.org/@openai%2fcodex/0.160.0-linux-x64)），验证 tarball 的 SHA-512 integrity。

安装器用 Python 解包，不执行全局 npm 安装，不使用 sudo。支持 Linux glibc 的 x64/arm64；musl 环境无法使用所选官方 Node 构建，诊断会报告这一限制。使用已有程序时，其来源和更新由用户管理。

## 运行参数

这些是远端桥的环境变量，不是安装器 CLI 参数。修改时保留安装器生成的身份与路径设置，并在空闲时重新连接桥服务。

| 环境变量 | 用途 |
| --- | --- |
| `CURSOR_BRIDGE_SYNC_INTERVAL_MS` | 默认 `2000`，`0` 停用历史扫描，非零最小值 `50` |
| `CURSOR_BRIDGE_HISTORY_HOME` | 含 `.cursor` 的来源用户目录，默认当前用户 home |
| `CURSOR_BRIDGE_LIVE_TMUX` | Linux 默认开启；`0` 关闭实时绑定、保留历史同步 |
| `CURSOR_BRIDGE_TMUX` | 指定 tmux 可执行文件 |

开启日志不等于日志适合公开。默认 RPC 诊断不记录聊天正文，但可能含会话 ID、模型、路径和 SSH 主机信息，反馈问题前仍需脱敏。
