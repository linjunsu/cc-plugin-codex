---
name: log
description: 'Show the recent execution log for a tracked Claude Code job, including tool inputs such as shell commands and file edit/write details when captured. Args: [job-id], --tail LINES, --all, --json. Use when the user wants to see what Claude Code is doing or did during a rescue/review job.'
---

# Claude Code Log

Use this skill when the user wants to inspect what Claude Code is doing or did for a tracked job.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" log $ARGUMENTS`

Supported arguments: `[job-id]`, `--tail <lines>`, `--all`, `--json`

Output:
- Present the companion stdout exactly as returned.
- Do not summarize or condense it.
- If the user wants live monitoring, rerun this skill periodically with the same job id.
