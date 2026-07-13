#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readHookInput } from "./lib/hook-input.mjs";
import { cleanupAfterOfficialUninstall } from "./lib/plugin-install-guard.mjs";
import { getConfig, listJobs, patchJob, writeTurnBaseline } from "../scripts/lib/state.mjs";
import { getWorkingTreeFingerprint } from "../scripts/lib/git.mjs";
import { nowIso, SESSION_ID_ENV } from "../scripts/lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";

const MAX_LISTED_JOBS = 3;
const NOTIFIABLE_JOB_STATUSES = new Set([
  "completed",
  "awaiting_review",
  "rejected",
  "policy_failed",
  "failed",
  "cancelled",
  "cancel_failed",
  "unknown",
]);
const SKIP_INTERACTIVE_HOOKS_ENV = "CLAUDE_COMPANION_SKIP_INTERACTIVE_HOOKS";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isExplicitClaudeStatusRequest(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  return text.includes("$cc:status") || text.includes("$cc:result") || text.includes("$cc:log");
}

function summarizeJob(job) {
  const parts = [job.id, job.status];
  if (job.kindLabel) parts.push(job.kindLabel);
  if (job.summary) parts.push(job.summary);
  return parts.join(" | ");
}

function buildAdditionalContext(jobs) {
  const listed = jobs.slice(0, MAX_LISTED_JOBS).map((job) => `- ${summarizeJob(job)}`);
  const remaining = jobs.length - listed.length;
  const intro = jobs.length === 1
    ? "A Claude Code job from this session reached a terminal checkpoint and has not been surfaced yet."
    : `${jobs.length} Claude Code jobs from this session reached terminal checkpoints and have not been surfaced yet.`;
  const awaitingReview = jobs.filter((job) => job.status === "awaiting_review");
  const failed = jobs.filter((job) => ["failed", "policy_failed", "cancel_failed", "unknown"].includes(job.status));
  const guidance = [
    awaitingReview.length > 0
      ? "Before continuing, Codex must inspect each awaiting-review result, the real workspace diff, and required verification. Accept or reject the todo; do not treat Claude's report as proof."
      : null,
    failed.length > 0
      ? "Surface the failed job status and error before continuing. Do not silently ignore or describe it as completed."
      : null,
    "Use `$cc:result <job-id>` for the stored result and `$cc:log <job-id>` only when more execution detail is needed. Do not repeat this notification automatically after this turn.",
  ].filter(Boolean).join(" ");

  return [
    intro,
    "",
    "Finished jobs:",
    ...listed,
    ...(remaining > 0 ? [`- and ${remaining} more finished Claude Code job(s)`] : []),
    "",
    guidance,
  ].join("\n");
}

function selectUnreadTerminalJobs(workspaceRoot, sessionId) {
  if (!sessionId) {
    return [];
  }

  return listJobs(workspaceRoot)
    .filter((job) => job.sessionId === sessionId)
    .filter((job) => NOTIFIABLE_JOB_STATUSES.has(job.status))
    .filter((job) => !job.resultViewedAt)
    .filter((job) => !job.notifiedAt)
    .sort((left, right) =>
      String(right.updatedAt ?? right.completedAt ?? "").localeCompare(
        String(left.updatedAt ?? left.completedAt ?? "")
      )
    );
}

function markJobsNotified(workspaceRoot, jobs) {
  const timestamp = nowIso();
  for (const job of jobs) {
    patchJob(workspaceRoot, job.id, {
      notifiedAt: timestamp,
    });
  }
}

function captureTurnBaseline(workspaceRoot, sessionId, cwd) {
  if (!sessionId) {
    return;
  }
  try {
    const fingerprint = getWorkingTreeFingerprint(cwd);
    writeTurnBaseline(workspaceRoot, sessionId, {
      cwd,
      workspaceRoot,
      capturedAt: nowIso(),
      fingerprint,
    });
  } catch {
    // Baseline capture is best-effort. If it fails, Stop falls back to running review.
  }
}

async function main() {
  const input = readHookInput();
  if (cleanupAfterOfficialUninstall(ROOT_DIR)) {
    return;
  }
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  const prompt = String(input.prompt ?? "");

  if (
    process.env[SKIP_INTERACTIVE_HOOKS_ENV] === "1" ||
    !sessionId
  ) {
    return;
  }

  const config = getConfig(workspaceRoot);
  if (config.stopReviewGate) {
    captureTurnBaseline(workspaceRoot, sessionId, cwd);
  }

  if (isExplicitClaudeStatusRequest(prompt)) {
    return;
  }

  const jobs = selectUnreadTerminalJobs(workspaceRoot, sessionId);
  if (jobs.length === 0) {
    return;
  }

  markJobsNotified(workspaceRoot, jobs);
  process.stdout.write(`${buildAdditionalContext(jobs)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
