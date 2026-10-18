# 故障排查

先在 laptop 的仓库目录运行：

```sh
node cli.mjs doctor --ssh my-dev
```

使用安装时的源 SSH 别名。诊断只检查配置和程序状态，不发模型请求。`--json` 方便保存结构化结果；公开前仍需检查和脱敏。

如果安装时指定了 `--alias my-cursor`，这里及后续升级、卸载也必须带同一选项，例如 `node cli.mjs doctor --ssh my-dev --alias my-cursor`。

## SSH 正常，但 App 没有显示 Cursor 模型

- 在 App 的 SSH 连接设置中添加或启用安装器输出的桥别名，并选择该连接下的项目。
- 检查 `doctor` 是否确认桥专用环境生效。安装器依次检测 `CODEX_HOME` 和 `LC_CURSOR_CODEX_BRIDGE` 转发；两者都被拒绝时，需要管理员允许相应变量。安装器不修改 `sshd_config`。
- 不要把普通 Codex 连接误认为桥连接。桥和普通连接有不同别名、状态目录和 wrapper。
- 若 App 尚未刷新，断开该桥连接后重新连接。不要重启原 tmux Agent 来刷新 App。

## 找不到 Node、Cursor 或 Codex

交互式 shell 中可用的命令未必在 SSH 登录环境中可用。可用 `--node-path`、`--agent-path`、`--codex-path` 指定**远端绝对路径**；不要传 laptop 路径。

缺少 Node.js 22+ 或原版 Codex CLI 时，安装器自动下载固定版本并校验摘要，保存到用户私有运行时目录。下载失败时检查开发机到 `nodejs.org` 和 `registry.npmjs.org` 的 HTTPS 网络；不要跳过校验。远端需 Linux glibc x64/arm64、Python 3.8+ 和 bash，musl 不受支持。

Cursor 登录属于远端用户环境。使用正确 SSH 用户并由账号拥有者完成登录；不要把登录 token 或他人的凭据放入仓库。

## 旧会话没有出现或历史没有刷新

空会话要先在 Cursor CLI 中产生可读取的消息。默认扫描当前 SSH 用户的 `.cursor`；不同用户、不同来源目录的历史不会自动混合。没有 tmux 实时绑定时，更新时间取决于 Cursor 写入 transcript 的时机。

如果历史路径可读而仍未发现，报告 Cursor Agent 版本、安装版本和脱敏的诊断结果，不要上传真实 transcript 或数据库。

## 不能向现有 tmux 会话发送

确认 Agent 处于同一用户的默认 tmux server，使用受支持的终端布局，并且输入框为空、当前轮次结束且没有菜单或审批。模型切换、审批和自由文本回答先在原 CLI 处理。

若出现 `unrecognized-footer-or-overlay`，表示输入框下方的状态栏或附加界面未通过识别。窄终端中的路径和分支换行曾触发误判；`v0.1.2` 支持在右边缘空格后换行的分支分隔符。升级后重新连接桥即可加载修复。此错误也可能来自真实菜单或审批，不能据此认定输入框为空；不要自动清空草稿或按键关闭未知界面。

若出现：

```text
Cursor input changed or could not be verified after paste;
text remains as an unsubmitted draft in tmux. Review it in Cursor CLI
```

这表示桥未能确认粘贴后的输入，文本可能仍作为草稿留在 CLI 中。**不要盲目重复发送或再粘贴一遍。**先在 Cursor CLI 查看草稿及是否已产生回复。只有持久化恢复凭据、原进程、模型、历史和草稿原文全部一致时，桥才允许将相同原文作为已有草稿重试；它不会自动清空或提交普通草稿。

`v0.1.3` 修复了窄窗口下较长消息软换行后被输入框裁剪的问题。受支持的 Cursor 输入框最多显示六个视觉行；桥会计算所需列宽，在独占、未缩放的 tmux 窗口中自动临时扩宽，等待终端重绘，再校验完整原文。提交或失败后恢复原尺寸，并保留 `window-size` 原有的显式配置或继承关系。若有人同时调整布局或选项，桥会保留对方的改动；已经提交的消息不会因恢复窗口失败而被误记为发送失败。

扩宽不改消息、光标或 Cursor 进程，也不会只凭可见后半段放行。超过 800 个 UTF-16 字符的粘贴仍使用 Cursor 自己的折叠标记，并校验同一会话保存的完整内容。较短消息若本身含超过六个显式文本行、所需列宽超过 1007，或者窗口有多个 pane 或处于缩放状态，桥无法通过扩宽验证全文，会在粘贴前说明原因。此限制只适用于共享现有 tmux 的代发路径。

错误在历史中保留不代表发生了新的发送请求；排查时区分旧失败记录、重新打开聊天和新的发送尝试。输入框布局、进程状态或模型格式不兼容时，代发会被拒绝。请提供 Agent/App 版本和脱敏诊断，保留草稿待检查。

## 升级或卸载提示忙碌

等待现有桥任务完成后再运行命令。若状态与 App 显示不同，先查看诊断，不要直接 `pkill node`、`pkill agent` 或删除 socket。这些命令可能影响其他任务。

安装器不会管理之前手工部署的旧桥，也不会迁移其记录。若旧服务不支持 maintenance RPC，应按旧部署自己的说明处理；不要把它误认为新安装的服务。

## 提交问题

说明操作步骤、发生时间、期望和实际结果，以及安装器/Node/Agent/Codex/App 的版本。附上经过检查的 `doctor --json` 输出。不要上传 SSH 私钥、登录 token、聊天记录、tmux 完整画面、Cursor 数据库或含个人配置的压缩包。更多说明见 [隐私与问题反馈](security.md)。
