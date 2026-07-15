---
name: group
description: 'Show Claude Code task jobs that share a task group id, including status, todo id, dependency ids, and declared locks. Args: [group-id], --all, --json. Use when the user wants to inspect a larger Codex plan split across multiple Claude Code workers.'
---

# Claude Code Task Group

Use this skill when the user wants to inspect a grouped set of Claude Code task jobs.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" group $ARGUMENTS`

Supported arguments: `[group-id]`, `--all`, `--json`

Output:
- Present the companion stdout exactly as returned.
- Use this only for inspection. Codex still owns planning, conflict handling, acceptance, and any final commit/push workflow.
