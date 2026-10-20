# Cursor Codex Bridge

Use Cursor Agent and your Cursor account from the Codex desktop app's native SSH chats. Includes CLI history sync and an experimental connection to an existing tmux session.

在 **Codex 桌面 App 的原生侧边栏**查看远端 Cursor CLI 会话，并继续使用远端 Cursor Agent 和 Cursor 模型聊天。开发机可以是任何满足条件的 Linux SSH 主机。

**实验版本。** 这是社区维护的协议兼容桥，与 OpenAI、Cursor 均无隶属关系。它依赖两端未承诺兼容的接口和终端布局；无法识别输入框或确认进程身份时会拒绝代发。安装或诊断通过不等于所有聊天路径均已验证。

## 需要什么

- Laptop：Codex 桌面 App、Node.js 22 或更新版本（含 npm）、Git、OpenSSH、tar；已能无交互执行 `ssh my-dev true`。
- 开发机：Linux x64/arm64、glibc、Python 3.8 或更新版本、bash；当前 SSH 用户已安装并登录 Cursor Agent。
- 共享已有终端会话时：Cursor Agent 在同一用户的默认 tmux server 内运行。tmux 不是新建 ACP 聊天和历史同步的必要条件。

安装器复用远端可用的 Node.js 22+ 和原版 Codex CLI，缺少时自动下载固定版本到用户私有目录，不需 sudo 或全局 npm。Cursor Agent 和账号登录仍由用户准备；远端不需要 npm 或 tar。自动化测试不等于所有系统上的 Codex App 已通过端到端验收。

## 安装

在 laptop 上执行，把 `my-dev` 换成你已有的 SSH 别名：

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.8/cursor-codex-bridge-0.1.8.tgz cursor-codex install --ssh my-dev
```

这是 GitHub 预发布版本 `v0.1.8` 的安装包，不是 npm 同名包。`npx` 会下载该版本及其依赖，然后运行安装器。也可以从源码安装或修改：

```sh
git clone https://github.com/KatarinaYuan/cursor-codex-bridge.git
cd cursor-codex-bridge
git checkout v0.1.8
npm ci --ignore-scripts
node cli.mjs install --ssh my-dev
```

安装器为 Cursor 创建独立 SSH 别名，默认是 `my-dev-cursor`，保留普通 Codex 连接。安装结果会显示下一步：在 Codex App 的 SSH 连接设置中添加或启用生成的别名，随后选择该连接下的项目。

安装器支持 `--dry-run` 查看计划，以及 `--node-path`、`--agent-path`、`--codex-path` 指定远端二进制路径。在源码目录中例如：

```sh
node cli.mjs install --ssh my-dev --dry-run
node cli.mjs install --ssh my-dev --alias my-cursor \
  --agent-path /usr/local/bin/agent \
  --codex-path /opt/node/bin/codex \
  --node-path /opt/node/bin/node
```

安装不会向模型发送探测消息。安装器先尝试转发 `CODEX_HOME`，不被接受时再尝试常见的 `LC_CURSOR_CODEX_BRIDGE` 通道；两者都被拒绝时报告限制，不修改 SSH 服务端策略。具体配置、下载来源和存储位置见 [架构](docs/architecture.md) 与 [排障](docs/troubleshooting.md)。

## 诊断、升级和卸载

以下命令在任意 laptop 目录运行，不需要克隆仓库。先为当前终端设置安装包地址：

```sh
BRIDGE_PACKAGE_URL=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.8/cursor-codex-bridge-0.1.8.tgz

# 只读检查；不调用付费模型，也不向现有聊天发测试消息
npx --yes --package="$BRIDGE_PACKAGE_URL" cursor-codex doctor --ssh my-dev
npx --yes --package="$BRIDGE_PACKAGE_URL" cursor-codex doctor --ssh my-dev --json

# 将所选安装包版本部署到现有安装
npx --yes --package="$BRIDGE_PACKAGE_URL" cursor-codex upgrade --ssh my-dev

# 移除安装器拥有的程序和配置，保留聊天记录与原 Cursor 数据
npx --yes --package="$BRIDGE_PACKAGE_URL" cursor-codex uninstall --ssh my-dev
```

`doctor` 返回码为 `0` 表示检查通过、`1` 表示发现阻断问题。升级到新版本时，从 [Releases](https://github.com/KatarinaYuan/cursor-codex-bridge/releases) 取得目标版本安装包 URL，替换 `BRIDGE_PACKAGE_URL` 后运行 `upgrade`；它部署当前调用的版本，不自行选择最新版本。用同一版本再次升级也可以。上面的地址已固定到修复中英文混排短消息输入换行核验，并保留稳定来源身份、多行发送和 Recents 支持的 `v0.1.8`。升级完成后运行 `doctor`；若 App 仍缓存旧会话列表，在 SSH 设置中断开桥连接后重新连接。

升级和卸载遇到进行中的桥任务会拒绝操作；等待任务结束后再运行。程序不会结束原 Cursor Agent 或清空 tmux 草稿。源码安装也可在目标版本 checkout 使用 `node cli.mjs` 执行这些子命令，参数相同。

如果安装时使用了 `--alias my-cursor`，后续 `doctor`、`upgrade` 和 `uninstall` 都需传入相同的 `--alias my-cursor`。卸载保留桥状态、原 Cursor 数据和共享的私有运行时。安装器只管理本项目创建的安装；它不会接管或迁移之前手工部署的桥。

当前通过 GitHub 源码和 Release 安装包分发，尚未发布到 npm；请勿使用 npm 上未经核对的同名包。

## 让 Codex 帮朋友安装

仓库附带一个安装 skill，可安装到 laptop 的 Codex skill 目录：

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.8/cursor-codex-bridge-0.1.8.tgz cursor-codex install-skill
```

也可指定目录：

```sh
npx --yes --package="$BRIDGE_PACKAGE_URL" cursor-codex install-skill --skill-dir "$HOME/.codex/skills"
```

这里的 `BRIDGE_PACKAGE_URL` 使用上文定义的版本地址。源码目录中也可运行 `node cli.mjs install-skill`。`--skill-dir` 指定 skill 的父目录。

已有官方旧版 skill 的朋友也可直接运行同一条 `v0.1.8 install-skill` 命令：与目标内容相同则不改动；识别到未修改的官方 `v0.1.1`、`v0.1.2`、`v0.1.3`、`v0.1.4`、`v0.1.5`、`v0.1.6` 或 `v0.1.7` 两文件内容时，先保留旧目录备份，再原子更新，并输出备份路径。自定义内容、额外文件或符号链接会拒绝覆盖，保留用户修改，无需先手动删除旧目录。

也可以一条命令升级远端桥和本机安装 skill：

```sh
npx --yes --package="$BRIDGE_PACKAGE_URL" -c 'cursor-codex upgrade --ssh my-dev && cursor-codex install-skill'
```

把 `my-dev` 换成安装时的源 SSH 别名；如原来有自定义桥别名，在 `upgrade` 后补上同一 `--alias my-cursor`。完成后运行上文的 `doctor`。单独执行 `upgrade` 只升级远端桥，不更新本机 skill。

随后在 Codex 中选择该 skill，或输入：

> 使用 $install-cursor-codex-bridge，把 Cursor Codex Bridge 安装到 SSH 别名 my-dev。安装后运行诊断。

朋友也可以直接把仓库地址发给自己的 Codex，要求按照 README 安装。Skill 负责调用确定性的安装器，常驻功能由远端协议桥提供。

## 功能与边界

| 路径 | 行为 |
| --- | --- |
| 新建聊天 | 使用 Cursor ACP，模型列表来自远端 Cursor；支持已实现的原生审批和选项提问 |
| 既有 CLI 会话 | 扫描当前用户 Cursor 历史，保留 Cursor 会话 ID 并映射到原生聊天 |
| 自动同步 | 默认每 2 秒发现新会话和历史更新；不发送模型请求 |
| Recents 侧边栏 | 按会话实际活动时间显示；正确区分普通会话和置顶／自定义分区，避免把全部 Cursor 会话误列为置顶 |
| 已有 tmux 会话 | 精确绑定原进程，尝试在同一输入框发送文字、观察回复，并用正式历史校准 |

`v0.1.5` 根据 Cursor 来源轮次 ID 观察 tmux 中的新任务，已完成的历史不会因终端残留忙碌画面再次生成原生运行轮次。桥保存来源轮次与原生轮次的对应凭据；重连后可以继续观察同一任务，或读取已完成的正式历史，不重复发送提示词。旧版遗留且缺少该凭据的悬空轮次需要单独诊断，不能仅凭终端画面自动删除；详见 [排障](docs/troubleshooting.md)。

旧 CLI 会话只支持文字。tmux 内的提问、审批和模型切换需在原 Cursor CLI 处理；已有草稿、忙碌状态或无法识别的界面会阻止代发。主题、Cursor 版本和模型显示格式变化可能需要适配。

`v0.1.6` 支持短消息包含超过六个显式文本行，保留原文、空行及首尾换行，无需合并段落。桥在原 pane 中临时独占输入，粘贴一次，再逐页核验完整草稿，确认后只提交一次；结束后恢复终端输入及临时窗口设置。窄窗口的软换行仍自动处理。已有草稿、输入锁、`pipe-pane` 或不支持的布局会阻止代发；详见 [排障](docs/troubleshooting.md)。

`v0.1.8` 修复短消息中英文混排时，桥与 Cursor 输入框的软换行计算不一致而导致粘贴后核验失败的问题。桥在粘贴前按更保守的输入布局规划临时列宽，核验仍要求草稿原文完整一致；保留首尾换行，不要求用户手动拉宽窗口或合并段落。无法确认布局、进程、模型或草稿时仍拒绝发送 Enter，并保留草稿供检查。

`v0.1.7` 用完整用户消息封套中的时间戳和正文识别同一真人请求，避免 transcript 截取范围变化后，位置编号指向另一轮。Cursor 注入的完整运行时工具目录作为上下文处理，不再把同一请求的后续回复拆成新轮次。桥保留原 Cursor 历史，通过来源映射保留既有原生聊天、轮次和消息 ID；旧格式缺少完整封套时仍兼容当前会话匹配，但不建立新的稳定提交恢复凭据；重复封套拒绝自动归属。旧版已卡住的轮次仍需按完整来源证据单独诊断，升级不会仅凭相同提示词接管任务。

Codex 的部分功能（例如运行中追加消息、fork、compact 和 Codex 专有多代理流程）尚未兼容。历史导入不重建旧工具卡片，空会话在产生可读历史后出现。桥不能保证与今后的 Codex App 或 Cursor 版本兼容。

了解 [架构与数据存储](docs/architecture.md)、[故障排查](docs/troubleshooting.md) 和 [隐私与问题反馈](docs/security.md)。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
```

测试使用模拟 Cursor 和隔离的临时数据，不发送付费模型请求。部分集成测试需要真实 Codex CLI；找不到该程序时会跳过。输入租约的进程与终端集成测试需要 Linux 和 tmux，其他环境会跳过。这些跳过不能计为集成验证成功。可通过 `CURSOR_BRIDGE_TEST_REAL_CODEX` 指定 Codex 可执行文件。

附带尚未启用的 [GitHub Actions 模板](docs/github-actions-test.yml)，配置 Node.js 22/24、Linux/macOS。启用时将其保存为 `.github/workflows/test.yml`。真实 SSH、Codex App、Cursor 账号及现有 tmux 的组合需要单独验收。本版测试范围见 [v0.1.8 验证说明](docs/verification-v0.1.8.md)；来源身份修复见 [v0.1.7 验证说明](docs/verification-v0.1.7.md)，多行发送等历史功能的测试范围见 [v0.1.6 验证说明](docs/verification-v0.1.6.md)，长消息发送的历史验收见 [v0.1.3 验证说明](docs/verification-v0.1.3.md)。欢迎附带脱敏诊断提交 issue 或 PR。

## 许可证

[MIT](LICENSE)。Cursor、Codex 及其他第三方程序不包含在本仓库的许可范围内，需由用户自行安装并遵守其条款。
