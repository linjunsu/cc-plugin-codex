<p align="center">
  <img src="assets/cc-plugin-codex-logo.svg" height="128" alt="cc-plugin-codex" />
</p>

<h3 align="center">Claude Code Plugin for Codex</h3>

<p align="center">
  Run Claude Code reviews, rescue tasks, tracked jobs, and tool-log inspection from inside Codex.
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#commands"><strong>Commands</strong></a> ·
  <a href="#tool-logs"><strong>Tool Logs</strong></a> ·
  <a href="#development"><strong>Development</strong></a> ·
  <a href="https://github.com/linjunsu/cc-plugin-codex/issues"><strong>Issues</strong></a>
</p>

---

## What Is This?

`cc-plugin-codex` lets Codex delegate work to Claude Code while Codex stays in charge of the user-facing thread.

This public fork is based on Sendbird's Apache-2.0 `cc-plugin-codex` and keeps the same core command surface, with local changes focused on observability:

- `$cc:rescue` runs from the main Codex thread by default and foreground jobs are polled until completion.
- `$cc:log` shows tracked job logs, including captured tool inputs.
- Job results include structured `toolUses`, `changedFiles`, and `touchedFiles` data when Claude Code emits tool calls.
- Tool input capture summarizes shell commands, write/edit file paths, and edit old/new strings while redacting sensitive-looking values.

It follows the shape of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), but runs in the opposite direction: Codex hosts the plugin and Claude Code performs delegated work.

## Quick Start

### Prerequisites

- Node.js 18+
- Codex with plugin support
- Claude Code CLI installed and authenticated

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Install From This Repository

This fork is distributed as a source plugin through Codex's personal marketplace. It is not currently published as a remote Codex marketplace.

Windows PowerShell:

```powershell
git clone https://github.com/linjunsu/cc-plugin-codex.git "$HOME\plugins\cc"
node "$HOME\plugins\cc\scripts\install-personal.mjs"
```

macOS/Linux:

```bash
git clone https://github.com/linjunsu/cc-plugin-codex.git "$HOME/plugins/cc"
node "$HOME/plugins/cc/scripts/install-personal.mjs"
```

POSIX one-line install:

```bash
curl -fsSL "https://raw.githubusercontent.com/linjunsu/cc-plugin-codex/main/scripts/install.sh" | bash
```

The installer creates or updates `~/.agents/plugins/marketplace.json`, installs `cc@personal`, and enables Codex native plugin hook feature gates.

After installing, restart Codex and run:

```text
$cc:setup
```

### Update

From the checkout:

```bash
git pull --ff-only
node scripts/install-personal.mjs
```

Restart Codex after reinstalling so new skills and hook hashes are picked up.

### Uninstall

```bash
node scripts/uninstall-personal.mjs
```

This removes `cc@personal` from Codex and removes the personal marketplace entry. It does not delete your source checkout.

## Commands

| Command | What It Does |
| --- | --- |
| `$cc:review` | Read-only Claude Code review of your changes |
| `$cc:adversarial-review` | Stronger review that challenges design, assumptions, and tradeoffs |
| `$cc:rescue` | Delegate a diagnosis, fix, implementation, or follow-up task to Claude Code |
| `$cc:status` | List running and recent Claude Code jobs, or inspect one job |
| `$cc:result` | Open the output of a finished tracked job |
| `$cc:log` | Show the recent execution log for a tracked job |
| `$cc:cancel` | Cancel an active tracked job |
| `$cc:setup` | Verify Claude Code, Codex plugin hooks, auth, and review gate state |

Quick routing rule:

- Use `$cc:review` for normal correctness review of a local diff.
- Use `$cc:adversarial-review` when you want Claude to pressure-test the approach.
- Use `$cc:rescue` when Claude should investigate, run commands, edit files, or own follow-through work.
- Use `$cc:log` when you need to inspect what Claude Code is doing or did.

### `$cc:review`

```text
$cc:review
$cc:review --background
$cc:review --base main
$cc:review --scope working-tree
$cc:review --model sonnet --effort high
```

Flags: `--base <ref>`, `--scope <auto|working-tree|branch>`, `--wait`, `--background`, `--model <model>`, `--effort <low|medium|high|xhigh|max>`.

### `$cc:adversarial-review`

```text
$cc:adversarial-review
$cc:adversarial-review --background challenge the retry and rollback strategy
$cc:adversarial-review --base main question the caching design
```

Accepts the same flags as `$cc:review`, plus free-text focus after flags.

### `$cc:rescue`

```text
$cc:rescue investigate why the tests started failing
$cc:rescue fix the failing test with the smallest safe patch
$cc:rescue --fresh --write implement the missing validation
$cc:rescue --resume continue the previous Claude Code run
$cc:rescue --background investigate the regression
```

Foreground rescue is the default. This fork runs the companion command from the main Codex thread and keeps polling until Claude Code exits, so Codex can see live progress such as tool usage lines.

Flags: `--background`, `--wait`, `--resume`, `--resume-last`, `--fresh`, `--write`, `--model <model>`, `--effort <low|medium|high|xhigh|max>`, `--prompt-file <path>`.

### `$cc:status`

```text
$cc:status
$cc:status task-abc123
$cc:status --all
$cc:status --wait task-abc123
```

By default, status shows jobs owned by the current Codex session. Use `--all` for the wider workspace history.

### `$cc:result`

```text
$cc:result
$cc:result task-abc123
```

Use this for the finished answer or report from Claude Code.

### `$cc:log`

```text
$cc:log
$cc:log task-abc123 --tail 120
$cc:log task-abc123 --all
$cc:log task-abc123 --json
```

Use this when you need execution details rather than just the final result.

## Tool Logs

The tracked job runtime captures Claude Code stream events and renders relevant tool inputs into the job log.

Captured examples include:

- `Bash` command text and description
- `PowerShell` command text and description
- `Write` file path and written content
- `Edit` file path, `old_string`, `new_string`, and `replace_all`
- `MultiEdit` file path and edit count/details

Sensitive-looking keys and inline assignments such as `token=...`, `password=...`, `secret=...`, and `api_key=...` are redacted before they are stored in the rendered log.

The JSON result also includes:

- `toolUses`: tool name, sanitized input, command, file, and whether the tool mutates files
- `changedFiles`: file paths from mutating tools
- `touchedFiles`: all file paths detected in tool use

This is meant to let Codex supervise Claude Code work with enough evidence to catch off-scope commands or unexpected file edits.

## Review Gate

The review gate is an optional stop-time hook. When enabled, pressing Ctrl+C in Codex triggers a Claude Code review of the last Codex response before the stop is accepted.

```text
$cc:setup --enable-review-gate
$cc:setup --disable-review-gate
```

Leave it disabled unless you are actively monitoring the session. It invokes Claude Code on stop events and can spend tokens quickly.

## Development

Run the lightweight public-source checks:

```bash
npm run check
```

Validate the Codex plugin manifest:

```bash
python /path/to/plugin-creator/scripts/validate_plugin.py .
```

Useful direct checks:

```bash
node --check scripts/claude-companion.mjs
node --check scripts/lib/claude-cli.mjs
node --check scripts/install-personal.mjs
node --check scripts/uninstall-personal.mjs
```

## Attribution

This fork is based on Sendbird's `cc-plugin-codex`, which includes material adapted from OpenAI's `codex-plugin-cc`.

The original NOTICE is preserved in [NOTICE](NOTICE). The project is licensed under [Apache-2.0](LICENSE).
