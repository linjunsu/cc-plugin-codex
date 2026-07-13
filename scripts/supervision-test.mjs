#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildArgs, formatStreamUserMessage, StreamParser } from "./lib/claude-cli.mjs";
import {
  buildSupervisedPrompt,
  buildTaskContract,
  captureWorkspaceSnapshot,
  evaluateToolPolicy,
  evaluateWorkspaceChanges,
  normalizeTaskMode,
  SUPERVISED_GIT_WRITE_TOOLS,
} from "./lib/supervision.mjs";
import {
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
  assert.ok(readJobFile(tempRoot, "task-hook-test").notifiedAt);

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
