#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildArgs,
  cancelClaudeProcess,
  formatStreamUserMessage,
  StreamParser,
} from "./lib/claude-cli.mjs";
import { getProcessIdentity, terminateProcessTree } from "./lib/process.mjs";
import {
  buildSupervisedPrompt,
  buildTaskContract,
  captureWorkspaceSnapshot,
  evaluateToolPolicy,
  evaluateWorkspaceChanges,
  normalizeTaskMode,
  parseScopeChangeRequest,
  SUPERVISED_GIT_WRITE_TOOLS,
} from "./lib/supervision.mjs";
import {
  buildTaskChainContext,
  resolveTaskResumeCandidate,
  sortJobsNewestFirst,
} from "./lib/job-control.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobSteerFile,
  writeJobFile,
} from "./lib/state.mjs";

const rescueSkill = fs.readFileSync(path.resolve("skills", "rescue", "SKILL.md"), "utf8");
assert.match(rescueSkill, /Silence is not drift\./);
assert.match(rescueSkill, /Never steer, cancel, or pressure Claude merely because/i);
assert.match(rescueSkill, /does not prove that Claude understood, acknowledged, or acted/i);
assert.match(rescueSkill, /Do not send repeated steering instructions merely because Claude has not responded quickly/i);

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

assert.equal(normalizeTaskMode(null, { write: false }), "diagnose");
assert.equal(normalizeTaskMode(null, { write: true }), "implement");
assert.equal(normalizeTaskMode("publish"), "publish");
assert.throws(() => normalizeTaskMode("unsafe"), /Unsupported task mode/);

let windowsIdentityCommand;
const windowsIdentity = getProcessIdentity(1234, {
  platform: "win32",
  runCommandCheckedImpl(command, args) {
    windowsIdentityCommand = { command, args };
    return { stdout: "638880000000000000|claude.exe\n" };
  },
});
assert.equal(windowsIdentity, "638880000000000000|claude.exe");
assert.equal(windowsIdentityCommand.command, "powershell.exe");
assert.match(windowsIdentityCommand.args.join(" "), /ProcessId = 1234/);
assert.throws(() => getProcessIdentity(0), /Invalid process ID/);

let taskkillInvocation;
const treeTermination = terminateProcessTree(1234, {
  platform: "win32",
  runCommandImpl(command, args) {
    taskkillInvocation = { command, args };
    return { status: 0, stdout: "SUCCESS", stderr: "", error: null };
  },
});
assert.equal(treeTermination.delivered, true);
assert.deepEqual(taskkillInvocation, {
  command: "taskkill",
  args: ["/PID", "1234", "/T", "/F"],
});

let cancelledPid;
const windowsCancellation = await cancelClaudeProcess(1234, "expected-identity", {
  platform: "win32",
  validateProcessIdentityImpl: () => true,
  terminateProcessTreeImpl(pid, options) {
    cancelledPid = { pid, options };
    return { attempted: true, delivered: true, method: "taskkill" };
  },
  waitForProcessExitImpl: async () => true,
});
assert.deepEqual(windowsCancellation, { cancelled: true });
assert.deepEqual(cancelledPid, { pid: 1234, options: { platform: "win32" } });

let recycledPidTerminated = false;
const recycledCancellation = await cancelClaudeProcess(1234, "old-identity", {
  platform: "win32",
  validateProcessIdentityImpl: () => false,
  terminateProcessTreeImpl() {
    recycledPidTerminated = true;
  },
});
assert.equal(recycledCancellation.cancelled, true);
assert.match(recycledCancellation.note, /PID recycled/);
assert.equal(recycledPidTerminated, false);

const diagnoseContract = buildTaskContract({
  mode: "diagnose",
  prompt: "Explain why the build fails",
  acceptance: "root cause is supported by file and line evidence",
});
assert.equal(diagnoseContract.capabilities.write, false);
assert.deepEqual(diagnoseContract.forbiddenActions, ["write", "commit", "push"]);
assert.match(buildSupervisedPrompt("Explain why", diagnoseContract), /read-only diagnosis/i);

const implementContract = buildTaskContract({
  mode: "implement",
  prompt: "Fix the parser",
  allowedPaths: "src/parser.js,test/parser.test.js",
  verification: "node test/parser.test.js",
});
assert.equal(implementContract.capabilities.write, true);
assert.equal(implementContract.capabilities.mayCommit, false);
assert.match(buildSupervisedPrompt("Fix the parser", implementContract), /Do not stage files/i);
assert.match(buildSupervisedPrompt("Fix the parser", implementContract), /CC_SCOPE_CHANGE_REQUEST/);
assert.deepEqual(
  parseScopeChangeRequest(
    'Need one more regression file.\nCC_SCOPE_CHANGE_REQUEST: {"paths":["scripts/smoke-test.mjs"],"reason":"npm test proves the old assertion must change"}'
  ),
  {
    paths: ["scripts/smoke-test.mjs"],
    reason: "npm test proves the old assertion must change",
  }
);
assert.equal(parseScopeChangeRequest("No scope request"), null);

const resumeJobs = [
  {
    id: "task-old",
    jobClass: "task",
    status: "completed",
    sessionId: "owner-a",
    threadId: "claude-old",
    createdAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:10:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  },
  {
    id: "task-current",
    jobClass: "task",
    status: "rejected",
    sessionId: "owner-a",
    threadId: "claude-current",
    chainRootId: "task-root",
    chainBaseline: { head: "baseline-head" },
    createdAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:10:00.000Z",
    updatedAt: "2026-07-14T10:10:00.000Z",
  },
  {
    id: "task-other-owner",
    jobClass: "task",
    status: "scope_change_requested",
    sessionId: "owner-b",
    threadId: "claude-other",
    createdAt: "2026-07-14T11:00:00.000Z",
    completedAt: "2026-07-14T11:10:00.000Z",
  },
  {
    id: "task-no-claude-session",
    jobClass: "task",
    status: "completed",
    sessionId: "owner-a",
    createdAt: "2026-07-14T12:00:00.000Z",
    completedAt: "2026-07-14T12:10:00.000Z",
  },
];
assert.equal(
  resolveTaskResumeCandidate(resumeJobs, { ownerSessionId: "owner-a" }).id,
  "task-current"
);
assert.equal(
  resolveTaskResumeCandidate(resumeJobs, {
    ownerSessionId: "owner-a",
    reference: "task-current",
  }).threadId,
  "claude-current"
);
assert.equal(
  resolveTaskResumeCandidate(resumeJobs, {
    ownerSessionId: "owner-a",
    reference: "task-other-owner",
  }).threadId,
  "claude-other"
);
assert.equal(sortJobsNewestFirst(resumeJobs)[0].id, "task-no-claude-session");
const resumedChain = buildTaskChainContext(
  "task-correction",
  resumeJobs[1],
  { head: "new-head" }
);
assert.deepEqual(resumedChain, {
  parentJobId: "task-current",
  chainRootId: "task-root",
  chainBaseline: { head: "baseline-head" },
});
for (const operation of ["add", "commit", "push", "tag", "switch", "rm", "mv", "apply"]) {
  assert.ok(
    SUPERVISED_GIT_WRITE_TOOLS.some((pattern) => pattern.startsWith(`Bash(git ${operation}`)),
    `missing Git write guard for ${operation}`
  );
}
assert.match(
  evaluateToolPolicy(
    [{ tool: "Bash", command: "git tag release-test", mutates: true }],
    implementContract
  ).join("\n"),
  /forbidden Git write/i
);
assert.equal(
  evaluateToolPolicy(
    [{ tool: "Bash", command: "git diff --stat", mutates: false }],
    implementContract
  ).length,
  0
);

assert.throws(
  () => buildTaskContract({
    mode: "implement",
    prompt: "Do the plan",
    contract: { todos: [{ id: "T1", task: "one" }, { id: "T2", task: "two" }] },
  }),
  /one todo at a time/i
);

const streamArgs = buildArgs("initial prompt", {
  outputFormat: "stream-json",
  inputFormat: "stream-json",
  disallowedTools: ["Bash(git commit:*)"],
});
assert.ok(streamArgs.includes("--input-format"));
assert.ok(streamArgs.includes("--disallowedTools"));
assert.ok(!streamArgs.includes("initial prompt"));
assert.deepEqual(JSON.parse(formatStreamUserMessage("correct course")), {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: "correct course" }],
  },
});

const parser = new StreamParser();
const bashEvents = [
  {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "Bash", input: {} },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"git commit -m test"}' },
    },
  },
  {
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  },
];
const parsedEvents = parser.feed(`${bashEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
const bashToolUse = parsedEvents.find((event) => event?.kind === "tool_use");
assert.equal(bashToolUse?.command, "git commit -m test");
assert.equal(bashToolUse?.mutates, true);

const switchParser = new StreamParser();
const switchEvents = bashEvents.map((event) => JSON.parse(JSON.stringify(event)));
switchEvents[1].event.delta.partial_json = '{"command":"git switch main"}';
const switchToolUse = switchParser
  .feed(`${switchEvents.map((event) => JSON.stringify(event)).join("\n")}\n`)
  .find((event) => event?.kind === "tool_use");
assert.equal(switchToolUse?.mutates, true);

const companionPath = path.resolve("scripts", "claude-companion.mjs");
const contradictory = spawnSync(
  process.execPath,
  [companionPath, "task", "--mode", "diagnose", "--write", "explain why"],
  { cwd: path.resolve("."), encoding: "utf8" }
);
assert.notEqual(contradictory.status, 0);
assert.match(contradictory.stderr, /conflicts with --mode diagnose/);

const detachedSupervision = spawnSync(
  process.execPath,
  [companionPath, "task", "--mode", "implement", "--background", "fix it"],
  { cwd: path.resolve("."), encoding: "utf8" }
);
assert.notEqual(detachedSupervision.status, 0);
assert.match(detachedSupervision.stderr, /must run in the foreground/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-supervision-test-"));
try {
  git(tempRoot, "init");
  git(tempRoot, "config", "user.name", "Test User");
  git(tempRoot, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(tempRoot, "allowed.txt"), "one\n", "utf8");
  fs.writeFileSync(path.join(tempRoot, "outside.txt"), "base\n", "utf8");
  git(tempRoot, "add", ".");
  git(tempRoot, "commit", "-m", "initial");

  const clean = captureWorkspaceSnapshot(tempRoot);
  fs.writeFileSync(path.join(tempRoot, "allowed.txt"), "two\n", "utf8");
  const changed = captureWorkspaceSnapshot(tempRoot);

  const diagnoseCheck = evaluateWorkspaceChanges(clean, changed, diagnoseContract);
  assert.deepEqual(diagnoseCheck.changedFiles, ["allowed.txt"]);
  assert.match(diagnoseCheck.violations.join("\n"), /Read-only diagnosis changed/);

  const workspaceContract = buildTaskContract({
    mode: "implement",
    prompt: "Edit allowed file",
    allowedPaths: "allowed.txt",
  });
  const allowedCheck = evaluateWorkspaceChanges(clean, changed, workspaceContract);
  assert.deepEqual(allowedCheck.changedFiles, ["allowed.txt"]);
  assert.equal(allowedCheck.violations.length, 0);

  fs.writeFileSync(path.join(tempRoot, "outside.txt"), "changed\n", "utf8");
  const outside = captureWorkspaceSnapshot(tempRoot);
  const outsideCheck = evaluateWorkspaceChanges(clean, outside, workspaceContract);
  assert.deepEqual(outsideCheck.outsideAllowedPaths, ["outside.txt"]);

  git(tempRoot, "add", "allowed.txt");
  const staged = captureWorkspaceSnapshot(tempRoot);
  const stagedCheck = evaluateWorkspaceChanges(clean, staged, workspaceContract);
  assert.match(stagedCheck.violations.join("\n"), /changed the Git index/i);

  const previousCodexHome = process.env.CODEX_HOME;
  const testCodexHome = path.join(tempRoot, "codex-home");
  process.env.CODEX_HOME = testCodexHome;
  const helpResult = spawnSync(process.execPath, [companionPath, "task", "--help"], {
    cwd: tempRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: testCodexHome },
  });
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /Usage:/);
  assert.equal(listJobs(tempRoot).length, 0);
  writeJobFile(tempRoot, "task-chronology-old", {
    id: "task-chronology-old",
    kind: "task",
    jobClass: "task",
    status: "completed",
    phase: "done",
    createdAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:10:00.000Z",
    updatedAt: "2026-07-13T10:10:00.000Z",
    result: { status: "completed" },
  });
  writeJobFile(tempRoot, "task-chronology-new", {
    id: "task-chronology-new",
    kind: "task",
    jobClass: "task",
    status: "completed",
    phase: "done",
    createdAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:10:00.000Z",
    updatedAt: "2026-07-14T10:10:00.000Z",
    result: { status: "completed" },
  });
  const viewOldResult = spawnSync(
    process.execPath,
    [companionPath, "result", "task-chronology-old", "--json"],
    { cwd: tempRoot, encoding: "utf8", env: { ...process.env, CODEX_HOME: testCodexHome } }
  );
  assert.equal(viewOldResult.status, 0, viewOldResult.stderr);
  const chronologyStatus = spawnSync(
    process.execPath,
    [companionPath, "status", "--all", "--json"],
    { cwd: tempRoot, encoding: "utf8", env: { ...process.env, CODEX_HOME: testCodexHome } }
  );
  assert.equal(chronologyStatus.status, 0, chronologyStatus.stderr);
  assert.equal(JSON.parse(chronologyStatus.stdout).latestFinished.id, "task-chronology-new");

  writeJobFile(tempRoot, "task-resume-cli", {
    id: "task-resume-cli",
    kind: "task",
    jobClass: "task",
    status: "rejected",
    phase: "rejected",
    sessionId: "owner-resume-cli",
    threadId: "claude-resume-cli",
    createdAt: "2026-07-15T10:00:00.000Z",
    completedAt: "2026-07-15T10:10:00.000Z",
    updatedAt: "2026-07-15T10:10:00.000Z",
    result: { status: "completed", sessionId: "claude-resume-cli" },
  });
  const resumeCandidateResult = spawnSync(
    process.execPath,
    [companionPath, "task-resume-candidate", "--json"],
    {
      cwd: tempRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: testCodexHome,
        CLAUDE_COMPANION_SESSION_ID: "owner-resume-cli",
      },
    }
  );
  assert.equal(resumeCandidateResult.status, 0, resumeCandidateResult.stderr);
  const resumeCandidatePayload = JSON.parse(resumeCandidateResult.stdout);
  assert.equal(resumeCandidatePayload.candidate.id, "task-resume-cli");
  assert.equal(resumeCandidatePayload.candidate.claudeSessionId, "claude-resume-cli");
  const baseJob = {
    kind: "task",
    jobClass: "task",
    title: "Supervision test",
    workspaceRoot: tempRoot.replace(/\\/g, "/"),
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result: { supervision: { acceptanceState: "pending" } },
    rendered: "checkpoint",
  };

  writeJobFile(tempRoot, "task-accept-test", {
    ...baseJob,
    id: "task-accept-test",
    status: "awaiting_review",
    phase: "awaiting_review",
  });
  const accepted = spawnSync(
    process.execPath,
    [companionPath, "accept", "task-accept-test", "verified"],
    { cwd: tempRoot, encoding: "utf8", env: { ...process.env, CODEX_HOME: testCodexHome } }
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readJobFile(tempRoot, "task-accept-test").status, "completed");
  assert.equal(
    readJobFile(tempRoot, "task-accept-test").result.supervision.acceptanceState,
    "accepted"
  );

  writeJobFile(tempRoot, "task-reject-test", {
    ...baseJob,
    id: "task-reject-test",
    status: "awaiting_review",
    phase: "awaiting_review",
  });
  const rejected = spawnSync(
    process.execPath,
    [companionPath, "reject", "task-reject-test", "verification failed"],
    { cwd: tempRoot, encoding: "utf8", env: { ...process.env, CODEX_HOME: testCodexHome } }
  );
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(readJobFile(tempRoot, "task-reject-test").status, "rejected");

  writeJobFile(tempRoot, "task-steer-test", {
    ...baseJob,
    id: "task-steer-test",
    status: "running",
    phase: "tool",
  });
  const steered = spawnSync(
    process.execPath,
    [companionPath, "steer", "task-steer-test", "stop editing outside scope"],
    { cwd: tempRoot, encoding: "utf8", env: { ...process.env, CODEX_HOME: testCodexHome } }
  );
  assert.equal(steered.status, 0, steered.stderr);
  const steerRecord = JSON.parse(
    fs.readFileSync(resolveJobSteerFile(tempRoot, "task-steer-test"), "utf8").trim()
  );
  assert.equal(steerRecord.instruction, "stop editing outside scope");

  writeJobFile(tempRoot, "task-hook-test", {
    ...baseJob,
    id: "task-hook-test",
    sessionId: "session-hook-test",
    status: "awaiting_review",
    phase: "awaiting_review",
  });
  writeJobFile(tempRoot, "task-scope-hook-test", {
    ...baseJob,
    id: "task-scope-hook-test",
    sessionId: "session-hook-test",
    status: "scope_change_requested",
    phase: "scope_change_requested",
    result: {
      supervision: {
        acceptanceState: "scope_change_requested",
        scopeChangeRequest: {
          paths: ["scripts/smoke-test.mjs"],
          reason: "required verification fails",
        },
      },
    },
  });
  const unreadHookPath = path.resolve("hooks", "unread-result-hook.mjs");
  const hookEnv = {
    ...process.env,
    CODEX_HOME: testCodexHome,
    CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS: "0",
  };
  const hookInput = JSON.stringify({
    cwd: tempRoot,
    session_id: "session-hook-test",
    prompt: "continue",
  });
  const firstNotification = spawnSync(process.execPath, [unreadHookPath], {
    cwd: tempRoot,
    encoding: "utf8",
    env: hookEnv,
    input: hookInput,
  });
  assert.equal(firstNotification.status, 0, firstNotification.stderr);
  assert.match(firstNotification.stdout, /awaiting-review result/i);
  assert.match(firstNotification.stdout, /accept or reject the todo/i);
  assert.match(firstNotification.stdout, /requested additional allowed paths/i);
  assert.ok(readJobFile(tempRoot, "task-hook-test").notifiedAt);
  assert.ok(readJobFile(tempRoot, "task-scope-hook-test").notifiedAt);

  const repeatedNotification = spawnSync(process.execPath, [unreadHookPath], {
    cwd: tempRoot,
    encoding: "utf8",
    env: hookEnv,
    input: hookInput,
  });
  assert.equal(repeatedNotification.status, 0, repeatedNotification.stderr);
  assert.equal(repeatedNotification.stdout, "");
  if (previousCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("supervision tests passed");
