<p align="center">
  <img src="assets/cc-plugin-codex-logo.svg" height="128" alt="cc-plugin-codex" />
</p>

<h3 align="center">Claude Code Plugin for Codex</h3>

<p align="center">
  Let Codex plan, supervise, steer, verify, and accept Claude Code work.
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

This public fork is based on Sendbird's Apache-2.0 `cc-plugin-codex` and keeps the same core command surface, with local changes focused on supervised execution:

- `$cc:rescue` preserves user authorization as `diagnose`, `implement`, `publish`, or explicit `autonomous` mode.
- Codex owns the todo list and delegates one bounded checkpoint at a time.
- Foreground jobs stream compact tool/command/file events and accept live steering from Codex.
- Successful supervised runs stop at `awaiting_review`; Codex independently checks the real diff and verification before accepting them.
- Claude cannot commit in supervised implementation/publish mode. Codex owns the final accepted commit, and remote writes still require explicit authorization.
- Git snapshots detect real file, index, and HEAD changes even when shell commands bypass Claude's edit tools.

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
| `$cc:rescue` | Run a diagnosis or implementation with Codex monitoring, steering, and acceptance |
| `$cc:status` | List running and recent Claude Code jobs, or inspect one job |
| `$cc:result` | Open the output of a finished tracked job |
| `$cc:log` | Show the recent execution log for a tracked job |
| `$cc:cancel` | Cancel an active tracked job |
| `$cc:setup` | Verify Claude Code, Codex plugin hooks, auth, and review gate state |

Quick routing rule:

- Use `$cc:review` for normal correctness review of a local diff.
- Use `$cc:adversarial-review` when you want Claude to pressure-test the approach.
- Use `$cc:rescue` when Claude should investigate or implement while Codex stays responsible for scope and correctness.
- Use `$cc:log` only for historical detail; supervised rescue streams live events automatically.

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
$cc:rescue --mode diagnose explain the citation numbering bug
$cc:rescue --mode implement --fresh implement the missing validation
$cc:rescue --resume continue the previous Claude Code run
$cc:rescue --autonomous --background run this without active supervision
```

Foreground supervision is the default. Codex classifies read-only questions such as "why" or "investigate" as `diagnose`; explicit change requests such as "fix" or "implement" use `implement`. Repository instructions constrain authorized work but never grant permission by themselves.

Flags: `--mode <diagnose|implement|publish|autonomous>`, `--autonomous`, `--background`, `--resume`, `--resume-last`, `--fresh`, `--write` (legacy autonomous compatibility), `--model <model>`, `--effort <low|medium|high|xhigh|max>`, `--prompt-file <path>`, `--contract-file <path>`, `--todo-id <id>`, `--acceptance <text>`, `--allowed-paths <paths>`, `--verify <command>`.

Supervised modes are foreground-only. Background mode requires explicit `--autonomous` because a detached Codex turn cannot perform semantic acceptance in real time.

## Supervision Lifecycle

```text
User intent
  -> Codex selects diagnose / implement / publish
  -> Codex defines one todo and acceptance evidence
  -> Claude executes while tool events stream to Codex
  -> Codex steers or cancels on drift
  -> Claude stops at awaiting_review
  -> Codex inspects the real diff and reruns verification
  -> Codex accepts or rejects the checkpoint
  -> Codex alone commits accepted implementation work
```

Contracts follow [`schemas/supervision-contract.schema.json`](schemas/supervision-contract.schema.json). Multi-todo contracts must select one `activeTodoId`; this prevents Claude from silently skipping ahead or marking the whole plan complete.

The companion also exposes internal supervisor controls used by `$cc:rescue`:

```text
node scripts/claude-companion.mjs steer <job-id> "correction"
node scripts/claude-companion.mjs accept <job-id> "verification evidence"
node scripts/claude-companion.mjs reject <job-id> "reason"
```

Users normally do not need to call these directly.

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

Use this for historical execution detail. Do not poll it repeatedly for supervised foreground work; Codex receives compact `[cc:event]` records automatically.

## Tool Logs

The tracked job runtime captures Claude Code stream events, renders relevant tool inputs into the job log, and sends compact structured events to the supervising Codex turn.

Captured examples include:

- `Bash` command text and description
- `PowerShell` command text and description
- `Write` file path and written content
- `Edit` file path, `old_string`, `new_string`, and `replace_all`
- `MultiEdit` file path and edit count/details

Sensitive-looking keys and inline assignments such as `token=...`, `password=...`, `secret=...`, and `api_key=...` are redacted before they are stored in the rendered log.

The JSON result also includes:

- `toolUses`: tool name, sanitized input, command, file, and whether the tool mutates files
- `changedFiles`: net file changes found by before/after Git snapshots
- `touchedFiles`: all file paths detected in tool use

Tool metadata is advisory. Acceptance uses before/after Git snapshots as the source of truth, including working-tree content, index state, and HEAD. This catches shell-driven changes that do not use Claude's `Edit` or `Write` tools.

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

The check suite includes supervision contract, workspace policy, shell-mutation classification, accept/reject, and steer-queue coverage.

Run a local Codex install smoke test:

```bash
node scripts/install-personal.mjs
codex plugin list
```

`plugin-creator`'s scaffold validator is not used as the release gate for this fork because it rejects the `hooks` manifest field. This plugin intentionally uses Codex native hooks for session cleanup, unread-result reminders, and the optional review gate.

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
