---
name: events
description: 'Show structured events for a tracked Claude Code job, including tool use, visible-terminal launch, steering, cancellation, and accept/reject decisions. Args: [job-id], --tail LINES, --all, --json. Use when the user wants a machine-readable or concise timeline of what Claude Code is doing or why a checkpoint was accepted/rejected.'
---

# Claude Code Events

Use this skill when the user wants the structured event timeline for a tracked Claude Code job.

Resolve `<plugin-root>` as two directories above this `SKILL.md` file. Always run the companion from that active plugin root:
`node "<plugin-root>/scripts/claude-companion.mjs" events $ARGUMENTS`

Supported arguments: `[job-id]`, `--tail <lines>`, `--all`, `--json`

Output:
- Present the companion stdout exactly as returned.
- Do not poll this repeatedly for live supervision; `$cc:rescue` already streams foreground events to Codex.
- Prefer `$cc:events` over `$cc:log` when the user wants accept/reject reasons, visible-terminal status, or a compact tool timeline.
