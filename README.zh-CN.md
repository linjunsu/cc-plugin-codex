<p align="center">
  <img src="assets/cc-plugin-codex-logo.svg" height="128" alt="cc-plugin-codex" />
</p>

<h3 align="center">面向 Codex 的 Claude Code 插件</h3>

<p align="center">
  让 Codex 负责计划、监督、纠偏、验证和验收，由 Claude Code 执行具体工作。
</p>

<p align="center">
  <a href="README.md"><kbd>English</kbd></a>
  <a href="README.zh-CN.md"><kbd>简体中文</kbd></a>
</p>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> ·
  <a href="#命令"><strong>命令</strong></a> ·
  <a href="#工具日志"><strong>工具日志</strong></a> ·
  <a href="#开发"><strong>开发</strong></a> ·
  <a href="https://github.com/linjunsu/cc-plugin-codex/issues"><strong>问题反馈</strong></a>
</p>

---

## 这是什么？

`cc-plugin-codex` 允许 Codex 把具体工作委派给 Claude Code，同时继续由 Codex 掌控面向用户的主对话。

这个公开分支基于 Sendbird 以 Apache-2.0 许可证发布的 `cc-plugin-codex`，保留了原有的主要命令，并重点增强了监督执行能力：

- `$cc:rescue` 会把用户授权准确区分为 `diagnose`、`implement`、`publish` 或显式启用的 `autonomous` 模式。
- Todo 列表由 Codex 管理，每次只向 Claude Code 委派一个边界明确的检查点。
- 前台任务会实时输出工具、命令和文件事件，Codex 可以在执行过程中向 Claude Code 发送纠偏指令。
- 监督任务成功执行后会停在 `awaiting_review`，Codex 必须独立检查真实差异和验证结果，才能验收任务。
- 在受监督的实现和发布模式下，Claude Code 不能提交代码；最终提交由 Codex 在验收后完成，远端写操作仍需用户明确授权。
- Git 前后快照会检查文件、暂存区和 HEAD 的真实变化，即使修改来自 shell 命令也能被发现。

它沿用了 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的整体思路，但执行方向相反：Codex 承载插件并负责监督，Claude Code 负责执行委派任务。

## 快速开始

### 前置条件

- Node.js 18 或更高版本
- 支持插件的 Codex
- 已安装并登录 Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### 从本仓库安装

这个分支通过 Codex 的个人插件市场以源码形式分发，目前尚未发布到远程 Codex 插件市场。

Windows PowerShell：

```powershell
git clone https://github.com/linjunsu/cc-plugin-codex.git "$HOME\plugins\cc"
node "$HOME\plugins\cc\scripts\install-personal.mjs"
```

macOS/Linux：

```bash
git clone https://github.com/linjunsu/cc-plugin-codex.git "$HOME/plugins/cc"
node "$HOME/plugins/cc/scripts/install-personal.mjs"
```

POSIX 一行安装：

```bash
curl -fsSL "https://raw.githubusercontent.com/linjunsu/cc-plugin-codex/main/scripts/install.sh" | bash
```

安装程序会创建或更新 `~/.agents/plugins/marketplace.json`，安装 `cc@personal`，并启用 Codex 原生插件 hook 所需的功能开关。

安装完成后，重启 Codex 并运行：

```text
$cc:setup
```

### 更新

在本地仓库中执行：

```bash
git pull --ff-only
node scripts/install-personal.mjs
```

重新安装后请重启 Codex，使新的 skill 和 hook 哈希生效。已经创建的旧任务可能保留旧的 skill 快照，建议新建任务验证新版本。

### 卸载

```bash
node scripts/uninstall-personal.mjs
```

该命令会从 Codex 中移除 `cc@personal` 以及个人插件市场条目，但不会删除本地源码仓库。

## 命令

| 命令 | 作用 |
| --- | --- |
| `$cc:review` | 让 Claude Code 以只读方式审查当前改动 |
| `$cc:adversarial-review` | 更严格地质疑设计、假设和方案取舍 |
| `$cc:rescue` | 在 Codex 监督、纠偏和验收下执行调查或实现任务 |
| `$cc:status` | 列出正在运行和最近完成的 Claude Code 任务，或查看指定任务 |
| `$cc:result` | 查看已结束任务的结果 |
| `$cc:log` | 查看任务最近的执行日志 |
| `$cc:cancel` | 取消仍在运行的任务 |
| `$cc:setup` | 检查 Claude Code、插件 hook、登录状态和审查门禁配置 |

快速选择规则：

- 普通代码差异审查使用 `$cc:review`。
- 需要 Claude Code 对方案进行强压力测试时使用 `$cc:adversarial-review`。
- 需要 Claude Code 调查或实现，同时由 Codex 负责范围和正确性时使用 `$cc:rescue`。
- `$cc:log` 主要用于查看历史细节；受监督的 rescue 任务会自动向 Codex 输出实时事件。

### `$cc:review`

```text
$cc:review
$cc:review --background
$cc:review --base main
$cc:review --scope working-tree
$cc:review --model sonnet --effort high
```

参数：`--base <ref>`、`--scope <auto|working-tree|branch>`、`--wait`、`--background`、`--model <model>`、`--effort <low|medium|high|xhigh|max>`。

### `$cc:adversarial-review`

```text
$cc:adversarial-review
$cc:adversarial-review --background 质疑重试和回滚策略
$cc:adversarial-review --base main 检查缓存设计是否合理
```

支持与 `$cc:review` 相同的参数，还可以在参数后附加审查重点。

### `$cc:rescue`

```text
$cc:rescue 调查测试为什么开始失败
$cc:rescue 用最小改动修复失败测试
$cc:rescue --mode diagnose 解释引用编号错误
$cc:rescue --mode implement --fresh 实现缺失的校验
$cc:rescue --resume 继续上一次 Claude Code 任务
$cc:rescue --autonomous --background 在没有主动监督的情况下运行
```

默认使用前台监督。Codex 会把“为什么”“调查一下”等只读问题归为 `diagnose`，把“修复”“实现”等明确改动请求归为 `implement`。仓库中的规则文件只约束已获授权的操作方式，不会自行授予修改或发布权限。

参数：`--mode <diagnose|implement|publish|autonomous>`、`--autonomous`、`--background`、`--resume`、`--resume-last`、`--fresh`、`--write`（兼容旧版 autonomous 模式）、`--model <model>`、`--effort <low|medium|high|xhigh|max>`、`--prompt-file <path>`、`--contract-file <path>`、`--todo-id <id>`、`--acceptance <text>`、`--allowed-paths <paths>`、`--verify <command>`。

受监督模式只能在前台运行。后台任务必须显式使用 `--autonomous`，因为脱离当前 Codex 回合后无法进行实时语义监督和逐项验收。

## 监督流程

```text
用户意图
  -> Codex 选择 diagnose / implement / publish
  -> Codex 定义一个 Todo 及其验收证据
  -> Claude 执行，工具事件实时发送给 Codex
  -> Codex 在发现跑偏时纠正或取消任务
  -> Claude 停在 awaiting_review
  -> Codex 检查真实差异并重新运行验证
  -> Codex 接受或拒绝当前检查点
  -> 只有 Codex 可以提交已验收的实现改动
```

任务合同遵循 [`schemas/supervision-contract.schema.json`](schemas/supervision-contract.schema.json)。包含多个 Todo 的合同必须指定一个 `activeTodoId`，防止 Claude Code 跳过步骤或自行宣布整个计划完成。

companion 还提供了供 `$cc:rescue` 内部使用的监督命令：

```text
node scripts/claude-companion.mjs steer <job-id> "纠偏指令"
node scripts/claude-companion.mjs accept <job-id> "验收证据"
node scripts/claude-companion.mjs reject <job-id> "拒绝原因"
```

普通用户通常不需要直接调用这些命令。

### `$cc:status`

```text
$cc:status
$cc:status task-abc123
$cc:status --all
$cc:status --wait task-abc123
```

默认只显示当前 Codex 会话拥有的任务。使用 `--all` 可以查看整个工作区的任务历史。

### `$cc:result`

```text
$cc:result
$cc:result task-abc123
```

用于查看 Claude Code 已结束任务的回答或报告。

### `$cc:log`

```text
$cc:log
$cc:log task-abc123 --tail 120
$cc:log task-abc123 --all
$cc:log task-abc123 --json
```

用于查看历史执行细节。不要在受监督的前台任务中反复轮询日志；Codex 会自动接收精简的 `[cc:event]` 事件。

## 工具日志

任务运行时会捕获 Claude Code 的流式事件，把关键工具输入写入任务日志，同时向负责监督的 Codex 回合发送结构化事件。

可捕获的内容包括：

- `Bash` 命令和说明
- `PowerShell` 命令和说明
- `Write` 的文件路径和写入内容
- `Edit` 的文件路径、`old_string`、`new_string` 和 `replace_all`
- `MultiEdit` 的文件路径、编辑数量和编辑详情

在保存日志前，插件会对疑似敏感的键名和行内赋值进行脱敏，例如 `token=...`、`password=...`、`secret=...` 和 `api_key=...`。

JSON 结果还包含：

- `toolUses`：工具名称、脱敏输入、命令、文件以及该工具是否可能修改文件
- `changedFiles`：通过 Git 前后快照发现的净文件变化
- `touchedFiles`：从工具调用中识别出的全部文件路径

工具元数据只作为辅助信息。最终验收以前后 Git 快照为准，包括工作区内容、暂存区状态和 HEAD。这可以发现没有经过 Claude Code `Edit` 或 `Write` 工具的 shell 修改。

## 审查门禁

审查门禁是可选的停止 hook。启用后，在 Codex 中按 Ctrl+C 会先触发 Claude Code 审查 Codex 的最后一次回答，然后再决定是否允许停止。

```text
$cc:setup --enable-review-gate
$cc:setup --disable-review-gate
```

除非正在主动监控会话，否则建议保持关闭。停止事件会调用 Claude Code，可能快速消耗 token。

## 开发

运行轻量级公开源码检查：

```bash
npm run check
```

检查内容包括监督合同、工作区策略、shell 修改识别、接受/拒绝状态转换和纠偏队列。

执行本地 Codex 安装冒烟测试：

```bash
node scripts/install-personal.mjs
codex plugin list
```

这个分支不使用 `plugin-creator` 的 scaffold validator 作为发布门禁，因为该校验器不接受 manifest 中的 `hooks` 字段。本插件有意使用 Codex 原生 hook 来实现会话清理、未读结果提醒和可选审查门禁。

常用的直接检查命令：

```bash
node --check scripts/claude-companion.mjs
node --check scripts/lib/claude-cli.mjs
node --check scripts/install-personal.mjs
node --check scripts/uninstall-personal.mjs
```

## 来源与许可

这个分支基于 Sendbird 的 `cc-plugin-codex`，其中包含从 OpenAI `codex-plugin-cc` 改编的内容。

原始 NOTICE 保留在 [NOTICE](NOTICE) 中，项目使用 [Apache-2.0](LICENSE) 许可证。
