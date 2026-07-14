---
name: rescue
description: 'Run a Claude Code diagnosis or implementation under active Codex supervision. Codex owns intent classification, todo boundaries, live monitoring, steering, independent verification, acceptance, and any final Git commit. Args include --mode, --background, --resume, --resume-job, --fresh, --model, --effort, and task text.'
---

# Claude Code Rescue Under Codex Supervision

Run this skill from the main Codex thread. Do not spawn a forwarding subagent. Codex is the planner and acceptance authority; Claude Code is an execution worker.

Resolve `<plugin-root>` as two directories above this `SKILL.md`. Run the companion from that active plugin root:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" ...
```

Raw slash-command arguments:
`$ARGUMENTS`

## 1. Preserve User Authorization

Classify the request before delegating:

- `diagnose`: why, investigate, inspect, explain, reproduce, research, or check without an explicit request to change code.
- `implement`: fix, modify, implement, build, or otherwise make local changes.
- `publish`: the user explicitly authorized push, PR creation, release, or another remote write.
- `autonomous`: only when the user explicitly asks for unsupervised/background delegation or passes `--autonomous`.

Hard rules:

- Words such as "why", "check", "investigate", and "use cc to look" are read-only diagnosis. Do not silently upgrade them to implementation.
- Repository instructions such as `AGENTS.md` constrain how an authorized action is performed; they never grant permission to edit, commit, push, or publish.
- `implement` allows Claude to edit and test. Claude must not stage, commit, push, reset, restore, stash, or rewrite history.
- After all implementation todos pass Codex acceptance, Codex may create the local commit unless the user explicitly said not to commit. Claude never creates that commit.
- Push, PR, release, deployment, and other external writes require explicit user authorization.
- User flags override inference. Reject contradictory combinations such as `--mode diagnose --write`.

## 2. Keep the Plan in Codex

For a multi-step request, Codex must maintain the todo list using its plan facility when available. Each todo needs:

- a stable ID such as `T1`;
- one bounded task;
- observable acceptance criteria;
- allowed files or directories when they are known;
- focused verification commands when they are known.

Delegate exactly one todo per Claude run. Do not give Claude the whole plan and let it mark its own work complete. If the request is a single bounded task, synthesize one todo.

When a structured plan already exists, stage a JSON contract outside the repository and pass `--contract-file`. Contract shape:

```json
{
  "mode": "implement",
  "activeTodoId": "T1",
  "todos": [
    {
      "id": "T1",
      "task": "Reproduce the sparse citation numbering bug",
      "acceptance": ["A focused reproduction demonstrates 1,2,4,5"]
    }
  ],
  "allowedPaths": ["server.js", "scripts/inline-citation-test.mjs"],
  "verification": ["node scripts/inline-citation-test.mjs"]
}
```

For a simple todo, the equivalent CLI flags are sufficient:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" task \
  --mode implement \
  --todo-id T1 \
  --acceptance "focused regression passes" \
  --allowed-paths "server.js,scripts/inline-citation-test.mjs" \
  --verify "node scripts/inline-citation-test.mjs" \
  --prompt-file "<absolute-prompt-file>"
```

## 3. Reserve and Route the Job

Before every task run:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" background-routing-context --kind task --json
```

Use non-empty `ownerSessionId` and `jobId` values as `--owner-session-id` and `--job-id`. Add `--view-state on-success` for supervised foreground work.

If the task text is multi-line, long, contains quotes/backticks, or contains XML-style blocks, stage it in a temporary prompt file outside the repository and preserve it exactly.

Use `--resume-job <job-id>` for every rejected checkpoint, scope correction, or other continuation of a known task. It resumes that exact Claude session and preserves the task-chain workspace baseline. Bare `--resume`/`--resume-last` may be used only when `task-resume-candidate --json` proves the newest candidate belongs to the current Codex session and is genuinely the same user task. `--fresh` starts a new session. Never resume unrelated work merely because the repository has an older completed task.

## 4. Monitor and Intervene

Supervised work is foreground-only. Run the companion directly with `exec_command`; if it yields a session ID, poll that same session with `write_stdin` until exit. If the shell session cannot be retained, use one blocking `status <job-id> --wait --json` call as the fallback. Do not implement polling with `Start-Sleep` plus repeated `$cc:status`, `$cc:result`, or `$cc:log` calls.

The foreground stream emits compact `[cc:event]` JSON lines containing tool, command, file, mutation likelihood, and mutating-tool detail. Evaluate these events against the active todo while Claude runs.

Silence is not drift. Never steer, cancel, or pressure Claude merely because execution is taking a long time, thinking is lengthy, many relevant files are being read, no new event has arrived, or no file change is visible yet. Analysis time and work pace are Claude's responsibility; Codex supervises scope, authorization, safety, and acceptance quality.

When no new event is available, report only the timestamped observation, for example: "As of 14:32:10, the last observed event was a Read; Claude is still running and no newer observable event is available." Do not claim that Claude is idle, stuck, refusing to work, or has made no changes beyond that observation window.

Intervene only when concrete event evidence shows at least one of these conditions:

- work outside the active todo or allowed paths;
- an unauthorized Git, destructive, external-write, or otherwise unsafe action;
- a repeated command/error loop with no meaningful adaptation;
- a material misunderstanding that contradicts the task contract;
- an attempted completion that skips an acceptance criterion or required verification.

When Claude returns `scope_change_requested`, inspect its `scopeChangeRequest` evidence. If the additional path is required by the todo or a required verification, revise the contract and continue with `--resume-job <job-id>`. If it is not justified, keep the original scope and give a bounded correction. A request made before editing is not a scope violation.

Before intervening, identify the specific event and the violated contract condition. Do not send repeated steering instructions merely because Claude has not responded quickly; wait for a subsequent event or explicit evidence that the first correction was ignored.

If the supervising Codex turn is approaching an execution limit, request a bounded checkpoint or stop the job cleanly. Do not convert the deadline into an instruction to hurry, stop analysis, or begin editing prematurely.

Intervene with a specific correction when the evidence threshold is met:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" steer <job-id> "<specific correction>"
```

Use `steer` for correctable drift. Use `cancel <job-id>` for destructive, unauthorized, or unsafe behavior that should not continue. Codex should call these commands itself; do not make the user manually monitor `$cc:log`.

A `steer` queue/delivery event proves only that the instruction was written to Claude's input stream. It does not prove that Claude understood, acknowledged, or acted on the correction. Describe it as "sent" until a later Claude event provides evidence of a response.

`$cc:log` remains a diagnostic fallback for historical detail. It is not the primary supervision mechanism.

## 5. Independently Verify Every Checkpoint

Successful supervised Claude runs stop in `awaiting_review`, not `completed`.

After the process exits:

1. Read the canonical structured result:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" result <job-id> --json
```

2. Inspect the actual workspace. At minimum check `git status --short --branch`, the relevant diff, changed-file scope, and whether Git HEAD or the index changed unexpectedly.
3. Run the contract verification commands independently. Do not rely on Claude's statement that tests or builds passed.
4. Compare the result with every acceptance criterion and the original user authorization.
5. Accept only with concrete evidence:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" accept <job-id> "diff inspected; focused test passed"
```

6. If verification fails, reject it:

```bash
node "<plugin-root>/scripts/claude-companion.mjs" reject <job-id> "missing browser build verification"
```

Then resume the same Claude session with a bounded correction for the same todo using `--resume-job <rejected-job-id>`. Do not mark the Codex plan item complete until `accept` succeeds.

For `diagnose`, verify that the workspace is unchanged and evaluate the evidence behind the root-cause claim before accepting.

## 6. Complete the User Workflow

After every todo is accepted:

- Run one final cross-todo diff and verification audit.
- For `diagnose`, report the verified cause and proposed fix; do not edit or commit.
- For `implement`, Codex may create the local commit after acceptance unless the user explicitly prohibited commits. Stage only accepted task files and obey repository identity/checklist rules.
- For `publish`, Codex performs the authorized commit/push/PR workflow and verifies remote state afterward.
- Never describe an `awaiting_review`, `rejected`, `policy_failed`, `failed`, or cancelled job as complete.

## 7. Autonomous Compatibility Mode

`--autonomous` preserves one-shot delegation. It may be combined with explicit `--background`. State clearly that active semantic supervision and per-todo acceptance are disabled in this mode.

Do not use autonomous mode merely for convenience or token savings when the user asked Codex to supervise.
