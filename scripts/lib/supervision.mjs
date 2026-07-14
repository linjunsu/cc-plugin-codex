/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

export const TASK_MODES = new Set([
  "diagnose",
  "implement",
  "publish",
  "autonomous",
]);

export const SUPERVISED_GIT_WRITE_TOOLS = [
  "Bash(git add:*)",
  "Bash(git am:*)",
  "Bash(git apply:*)",
  "Bash(git checkout:*)",
  "Bash(git cherry-pick:*)",
  "Bash(git clean:*)",
  "Bash(git commit:*)",
  "Bash(git merge:*)",
  "Bash(git mv:*)",
  "Bash(git push:*)",
  "Bash(git rebase:*)",
  "Bash(git reset:*)",
  "Bash(git restore:*)",
  "Bash(git rm:*)",
  "Bash(git stash:*)",
  "Bash(git switch:*)",
  "Bash(git tag:*)",
];

const GIT_WRITE_COMMAND_RE = /(?:^|[;&|]\s*|\b)git\s+(?:add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|rm|stash|switch|tag)\b/i;

const MODE_CAPABILITIES = {
  diagnose: {
    write: false,
    mayCommit: false,
    mayPush: false,
  },
  implement: {
    write: true,
    mayCommit: false,
    mayPush: false,
  },
  publish: {
    write: true,
    mayCommit: false,
    mayPush: false,
  },
  autonomous: {
    write: true,
    mayCommit: true,
    mayPush: false,
  },
};

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function splitList(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  return uniqueStrings(String(value ?? "").split(/[\r\n,]/));
}

function normalizeTodo(todo, index, fallbackTask) {
  if (typeof todo === "string") {
    return {
      id: `T${index + 1}`,
      task: todo.trim(),
      acceptance: [],
    };
  }
  if (!todo || typeof todo !== "object" || Array.isArray(todo)) {
    throw new Error(`Contract todo ${index + 1} must be a string or object.`);
  }
  const task = String(todo.task ?? todo.title ?? fallbackTask ?? "").trim();
  if (!task) throw new Error(`Contract todo ${index + 1} is missing task text.`);
  return {
    id: String(todo.id ?? `T${index + 1}`).trim() || `T${index + 1}`,
    task,
    acceptance: splitList(todo.acceptance ?? todo.acceptanceCriteria),
  };
}

export function normalizeTaskMode(value, options = {}) {
  const requested = String(value ?? "").trim().toLowerCase();
  if (requested) {
    if (!TASK_MODES.has(requested)) {
      throw new Error(
        `Unsupported task mode "${value}". Use diagnose, implement, publish, or autonomous.`
      );
    }
    return requested;
  }
  return options.write ? "implement" : "diagnose";
}

export function taskModeCapabilities(mode) {
  const normalized = normalizeTaskMode(mode);
  return { ...MODE_CAPABILITIES[normalized] };
}

export function readTaskContract(cwd, contractFile) {
  if (!contractFile) return null;
  const absolutePath = path.resolve(cwd, contractFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read supervision contract ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Supervision contract must be a JSON object.");
  }
  return parsed;
}

export function buildTaskContract({
  mode,
  write = false,
  prompt,
  contract = null,
  todoId = null,
  acceptance = null,
  allowedPaths = null,
  verification = null,
}) {
  const normalizedMode = normalizeTaskMode(mode);
  if (contract?.mode && normalizeTaskMode(contract.mode) !== normalizedMode) {
    throw new Error(
      `Contract mode ${contract.mode} does not match requested mode ${normalizedMode}.`
    );
  }

  const fallbackTask = String(prompt ?? "").trim();
  const rawTodos = Array.isArray(contract?.todos) && contract.todos.length > 0
    ? contract.todos
    : [{ id: todoId || "T1", task: fallbackTask, acceptance: splitList(acceptance) }];
  const todos = rawTodos.map((todo, index) => normalizeTodo(todo, index, fallbackTask));
  const selectedId = String(todoId ?? contract?.activeTodoId ?? "").trim();
  if (todos.length > 1 && !selectedId && normalizedMode !== "autonomous") {
    throw new Error(
      "Supervised contracts execute one todo at a time. Pass --todo-id for the active todo."
    );
  }
  const activeTodo = selectedId
    ? todos.find((todo) => todo.id === selectedId)
    : todos[0];
  if (!activeTodo) {
    throw new Error(`Todo ${selectedId} was not found in the supervision contract.`);
  }

  const inlineAcceptance = splitList(acceptance);
  if (inlineAcceptance.length > 0) {
    activeTodo.acceptance = uniqueStrings([...activeTodo.acceptance, ...inlineAcceptance]);
  }

  const capabilities = taskModeCapabilities(normalizedMode);
  if (normalizedMode === "autonomous") {
    capabilities.write = Boolean(write);
    capabilities.mayCommit = Boolean(write);
  }
  return {
    version: 1,
    mode: normalizedMode,
    capabilities,
    activeTodo,
    todos,
    allowedPaths: splitList(allowedPaths ?? contract?.allowedPaths),
    verification: splitList(verification ?? contract?.verification),
    forbiddenActions: normalizedMode === "diagnose"
      ? ["write", "commit", "push"]
      : normalizedMode === "implement"
        ? ["commit", "push"]
        : normalizedMode === "autonomous"
          ? ["push"]
          : ["commit", "push"],
  };
}

export function buildSupervisedPrompt(prompt, contract) {
  if (contract.mode === "autonomous") return String(prompt ?? "");
  const acceptance = contract.activeTodo.acceptance.length > 0
    ? contract.activeTodo.acceptance.map((item) => `- ${item}`).join("\n")
    : "- Provide concrete evidence that the todo is complete.";
  const allowedPaths = contract.allowedPaths.length > 0
    ? contract.allowedPaths.map((item) => `- ${item}`).join("\n")
    : "- No explicit path allowlist. Stay within the minimum task scope.";
  const verification = contract.verification.length > 0
    ? contract.verification.map((item) => `- ${item}`).join("\n")
    : "- Report the focused checks that should be run by Codex during acceptance.";
  const modeRules = contract.mode === "diagnose"
    ? [
        "- This is a read-only diagnosis. Do not edit, create, delete, rename, stage, or commit files.",
        "- Stop after reporting the root cause, evidence, and a proposed minimal fix.",
      ]
    : contract.mode === "implement"
      ? [
          "- You may edit and test only for this todo.",
          "- Do not stage files, change refs or branches, commit, push, or run other Git write commands.",
          "- Codex owns acceptance and the final commit after inspecting the real diff and tests.",
        ]
      : [
          "- You may edit and test only for this todo.",
          "- Do not stage, commit, push, reset, restore, stash, or rewrite Git history.",
          "- Codex owns acceptance and performs the separately authorized publish workflow afterward.",
        ];

  return [
    "[CC SUPERVISION CONTRACT]",
    `Mode: ${contract.mode}`,
    `Active todo: ${contract.activeTodo.id}`,
    `Todo task: ${contract.activeTodo.task}`,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "Allowed paths:",
    allowedPaths,
    "",
    "Required verification:",
    verification,
    "",
    "Execution rules:",
    "- Execute only the active todo. Do not silently broaden or rewrite the plan.",
    "- If a required change falls outside Allowed paths, do not edit that path. Stop and emit exactly one line in this form: CC_SCOPE_CHANGE_REQUEST: {\"paths\":[\"relative/path\"],\"reason\":\"why it is required\"}",
    "- If information is otherwise missing or the task conflicts with the contract, stop and report the blocker.",
    "- End with changed files, commands/tests run, results, remaining risks, and any unmet criterion.",
    ...modeRules,
    "[END CC SUPERVISION CONTRACT]",
    "",
    "[USER TASK]",
    String(prompt ?? contract.activeTodo.task),
    "[END USER TASK]",
  ].join("\n");
}

export function parseScopeChangeRequest(rawOutput) {
  const line = String(rawOutput ?? "")
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith("CC_SCOPE_CHANGE_REQUEST:"));
  if (!line) return null;

  const payloadText = line.slice(line.indexOf(":") + 1).trim();
  try {
    const payload = JSON.parse(payloadText);
    const paths = uniqueStrings(Array.isArray(payload?.paths) ? payload.paths : []);
    const reason = String(payload?.reason ?? "").trim();
    if (paths.length === 0 || !reason) return null;
    return { paths, reason };
  } catch {
    return null;
  }
}

function git(cwd, args) {
  return runCommand("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function nulPaths(output) {
  return String(output ?? "").split("\0").map((item) => item.trim()).filter(Boolean);
}

function fileFingerprint(repoRoot, relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) return `directory:${Math.trunc(stat.mtimeMs)}`;
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(absolutePath)}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
  const result = git(repoRoot, ["hash-object", "--no-filters", "--", relativePath]);
  return result.status === 0 ? `blob:${result.stdout.trim()}` : "unhashable";
}

export function captureWorkspaceSnapshot(cwd) {
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) return null;
  const repoRoot = rootResult.stdout.trim();
  const headResult = git(repoRoot, ["rev-parse", "HEAD"]);
  const branchResult = git(repoRoot, ["branch", "--show-current"]);
  const staged = new Set(nulPaths(git(repoRoot, ["diff", "--cached", "--name-only", "-z"]).stdout));
  const unstaged = new Set(nulPaths(git(repoRoot, ["diff", "--name-only", "-z"]).stdout));
  const untracked = new Set(nulPaths(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout));
  const paths = [...new Set([...staged, ...unstaged, ...untracked])].sort();
  const files = {};
  for (const relativePath of paths) {
    const indexResult = git(repoRoot, ["ls-files", "-s", "--", relativePath]);
    files[relativePath.replace(/\\/g, "/")] = {
      staged: staged.has(relativePath),
      unstaged: unstaged.has(relativePath),
      untracked: untracked.has(relativePath),
      index: indexResult.status === 0 ? indexResult.stdout.trim() : "",
      worktree: fileFingerprint(repoRoot, relativePath),
    };
  }
  return {
    repoRoot: repoRoot.replace(/\\/g, "/"),
    head: headResult.status === 0 ? headResult.stdout.trim() : null,
    branch: branchResult.status === 0 ? branchResult.stdout.trim() : null,
    files,
  };
}

function pathAllowed(relativePath, allowedPaths) {
  if (allowedPaths.length === 0) return true;
  const candidate = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return allowedPaths.some((allowedPath) => {
    const allowed = allowedPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (allowed === ".") return true;
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
  });
}

export function evaluateToolPolicy(toolUses, contract) {
  const uses = Array.isArray(toolUses) ? toolUses : [];
  const violations = [];
  const mutatingUses = uses.filter((toolUse) => toolUse?.mutates);
  if (contract.mode === "diagnose" && mutatingUses.length > 0) {
    violations.push(
      `Read-only diagnosis attempted ${mutatingUses.length} potentially mutating tool call(s).`
    );
  }
  if (contract.mode !== "autonomous") {
    const gitWrites = uses
      .map((toolUse) => String(toolUse?.command ?? "").trim())
      .filter((command) => command && GIT_WRITE_COMMAND_RE.test(command));
    if (gitWrites.length > 0) {
      violations.push(
        `Claude attempted forbidden Git write command(s): ${gitWrites.join(" | ")}`
      );
    }
  }
  return violations;
}

export function evaluateWorkspaceChanges(before, after, contract) {
  if (!before || !after) {
    return {
      gitRepository: false,
      headChanged: false,
      changedFiles: [],
      outsideAllowedPaths: [],
      violations: [],
    };
  }
  const paths = [...new Set([
    ...Object.keys(before.files ?? {}),
    ...Object.keys(after.files ?? {}),
  ])].sort();
  const changedFiles = paths.filter(
    (relativePath) => JSON.stringify(before.files?.[relativePath] ?? null) !== JSON.stringify(after.files?.[relativePath] ?? null)
  );
  const stagingChangedFiles = paths.filter((relativePath) => {
    const previous = before.files?.[relativePath] ?? {};
    const current = after.files?.[relativePath] ?? {};
    if (Boolean(previous.staged) !== Boolean(current.staged)) return true;
    return Boolean(previous.staged) && previous.index !== current.index;
  });
  const headChanged = before.head !== after.head;
  const outsideAllowedPaths = changedFiles.filter(
    (relativePath) => !pathAllowed(relativePath, contract.allowedPaths)
  );
  const violations = [];
  if (contract.mode === "diagnose" && changedFiles.length > 0) {
    violations.push(`Read-only diagnosis changed ${changedFiles.length} file(s).`);
  }
  if (!contract.capabilities.mayCommit && headChanged) {
    violations.push("Claude changed Git HEAD even though commits were not authorized.");
  }
  if (["implement", "publish"].includes(contract.mode) && stagingChangedFiles.length > 0) {
    violations.push(`Claude changed the Git index before Codex acceptance: ${stagingChangedFiles.join(", ")}`);
  }
  if (outsideAllowedPaths.length > 0) {
    violations.push(`Changed files outside the allowed scope: ${outsideAllowedPaths.join(", ")}`);
  }
  return {
    gitRepository: true,
    beforeHead: before.head,
    afterHead: after.head,
    headChanged,
    changedFiles,
    stagingChangedFiles,
    outsideAllowedPaths,
    violations,
  };
}

export function renderSupervisionReport(supervision) {
  const lines = [
    "",
    "# Codex Supervision Checkpoint",
    "",
    `Mode: ${supervision.contract.mode}`,
    `Todo: ${supervision.contract.activeTodo.id}`,
    `Acceptance: ${supervision.acceptanceState}`,
  ];
  if (supervision.workspace.changedFiles.length > 0) {
    lines.push("", "Observed file changes:", ...supervision.workspace.changedFiles.map((file) => `- ${file}`));
  }
  if (supervision.workspace.violations.length > 0) {
    lines.push("", "Policy violations:", ...supervision.workspace.violations.map((item) => `- ${item}`));
  }
  if (supervision.scopeChangeRequest) {
    lines.push(
      "",
      "Requested scope expansion:",
      ...supervision.scopeChangeRequest.paths.map((item) => `- ${item}`),
      `Reason: ${supervision.scopeChangeRequest.reason}`
    );
  }
  if (supervision.contract.verification.length > 0) {
    lines.push("", "Codex must independently run:", ...supervision.contract.verification.map((item) => `- ${item}`));
  }
  if (supervision.acceptanceState === "pending") {
    lines.push(
      "",
      "Claude has stopped at the checkpoint. Codex must inspect the real diff and verification evidence, then accept or reject this todo."
    );
  } else if (supervision.acceptanceState === "scope_change_requested") {
    lines.push(
      "",
      "Claude stopped before editing the requested paths. Codex must inspect the evidence and either revise the contract or keep the original scope."
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
