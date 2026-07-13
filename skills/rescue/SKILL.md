---
name: rescue
description: 'Delegate a substantial diagnosis, implementation, or follow-up task to Claude Code through the tracked-job runtime. Args include --background, --wait, --resume, --resume-last, --fresh, --write, --model MODEL, --effort LEVEL, --prompt-file PATH, and task text. Defaults to the user Claude Code profile unless overridden. Use when Claude should investigate or change things, not when the user only wants review findings.'
---

# Claude Code Rescue

Local runtime policy: run this skill from the main Codex thread. Do not spawn a Codex forwarding subagent for normal `$cc:rescue` requests.

Use this skill when the user wants Claude Code to investigate, implement, debug, or continue substantial work. Do not use it for an ordinary "review this diff" request unless the user wants Claude Code to own follow-through work.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" task ...
```

Raw slash-command arguments:
`$ARGUMENTS`

Supported arguments: `--background`, `--wait`, `--resume`, `--resume-last`, `--fresh`, `--write`, `--model <model>`, `--effort <low|medium|high|xhigh|max>`, `--prompt-file <path>`, plus free-text task text.

## Main-Thread Rules

- If the user did not supply a task, ask what Claude Code should investigate or fix.
- Do not inspect the repository, solve the task yourself, or summarize a fabricated result. The main thread only resolves routing, builds the companion command, runs it, and reports the companion result.
- Treat `--background` and `--wait` as Codex-side execution controls only. Never forward either flag to `claude-companion.mjs task`.
- Treat `--model`, `--effort`, `--resume`, `--resume-last`, `--fresh`, and `--prompt-file` as runtime controls, not task text.
- Forward user-supplied `--model` and `--effort` unchanged to the companion command.
- Default to `--write` unless the user explicitly wants read-only behavior or only review, diagnosis, or research without edits.
- If the task text itself begins with a slash command such as `/simplify`, forward that slash command as literal Claude Code task text. Do not execute it locally or strip the slash.
- If `--resume` or `--resume-last` is present, continue the latest tracked Claude Code task. If `--fresh` is present, start a new task.
- If none of `--resume`, `--resume-last`, or `--fresh` is present, first run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, ask the user once whether to continue the current Claude Code thread or start a new one.
- Use exactly these two choices when asking:
  - `Continue current Claude Code thread`
  - `Start a new Claude Code thread`
- If the helper reports `available: false`, delegate normally.

## Command Building

Before starting the task, capture routing context:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" background-routing-context --kind task --json
```

Use the returned values as internal companion flags:

- If `ownerSessionId` is non-empty, add `--owner-session-id <ownerSessionId>`.
- If `jobId` is non-empty, add `--job-id <jobId>`.
- Add `--view-state on-success` for foreground execution.
- Add `--view-state defer` for explicit `--background` execution.
- Never emit an empty placeholder such as `--owner-session-id  --job-id`.

Prompt handling:

- Preserve the resolved task text apart from stripping routing flags.
- If the resolved task text is multi-line, long, contains single quotes/backticks, or contains XML-style blocks such as `<task>`, stage it in a temporary prompt file outside the repository and pass it with `--prompt-file <absolute-path>`.
- When staging a prompt file, preserve the exact task text byte-for-byte.

## Execution

Foreground is the default unless the user explicitly passed `--background`.

- Foreground: run the companion `task` command directly in the main thread with `exec_command`.
- If `exec_command` returns `Process running with session ID ...`, keep polling that session with `write_stdin` until the command exits. Do not return early.
- After the foreground command exits, return the companion's final result. Omit only unambiguous `[cc]` progress chatter.
- If the task command output is only progress or otherwise unclear and a reserved `jobId` is available, retrieve the canonical result with:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" result <jobId>
```

- Background: do not spawn a Codex subagent. Start the companion command from the main thread with `--view-state defer`, report the reserved job id when available, and tell the user to inspect it with `$cc:status` and `$cc:result <jobId>`.

## Output

- Foreground: return Claude Code's result without paraphrasing it into a separate Codex answer.
- Background: say `Claude Code rescue started in the background. Check $cc:status for progress, then open it with $cc:result <job-id>.`
- If setup or authentication fails, report the companion error and direct the user to `$cc:setup`.
