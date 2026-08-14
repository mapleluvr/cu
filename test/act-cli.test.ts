import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitActionBytes } from "../src/action-file.js";
import { ActionInputError } from "../src/action-input.js";
import {
  ActBlockedError,
  ActIndeterminateError,
  ActInternalError,
  ActPartialError
} from "../src/act.js";
import { classifyPublicActFailure, createPublicActReceipt } from "../src/cli.js";
import { acquireRunLock } from "../src/run-lock.js";
import { ensureRun } from "../src/run.js";
import { initializeWorkspace } from "../src/workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");
const runId = "work-a";

function actionBytes(observationId = "obs_example", actions: unknown[] = [
  { kind: "click", at: { x: 500, y: 500 } }
]): Buffer {
  return Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions
  }), "utf8");
}

function admittedPlan(actions: unknown[]) {
  const admitted = admitActionBytes(actionBytes("obs_example", actions));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted action plan");
  return admitted.plan;
}

function runCli(workspace: string, args: readonly string[], input?: Buffer) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    input
  });
}

function parseOnlyJson(stdout: string): Record<string, unknown> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("projects exact completed and checkpoint public receipts from proven act results", () => {
  const completedPlan = admittedPlan([
    { kind: "click", at: { x: 500, y: 500 } },
    { kind: "type_text", text: "private-tail" }
  ]);
  const completed = createPublicActReceipt(runId, completedPlan, {
    outcome: "completed",
    emittedActionCount: 2,
    emittedLeafActionCount: 2
  });
  assert.deepEqual(completed, {
    kind: "cu.act.result/v1",
    runId,
    outcome: "completed",
    emittedActionCount: 2,
    emittedLeafActionCount: 2,
    unexecutedActionCount: 0
  });
  assert.doesNotMatch(JSON.stringify(completed), /private-tail/);

  const checkpoint = Object.freeze({
    observationId: "obs_1123456789abcdef0123456789abcdef",
    imagePath: `.cu/${runId}/captures/obs_1123456789abcdef0123456789abcdef.png`,
    coordinateSpace: "normalized_999_top_left" as const,
    capturedAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:01:00.000Z",
    actionable: true as const,
    evictedHistoryCount: 3
  });
  const checkpointReceipt = createPublicActReceipt(runId, completedPlan, {
    outcome: "checkpoint",
    emittedActionCount: 1,
    emittedLeafActionCount: 1,
    checkpoint
  });
  assert.deepEqual(checkpointReceipt, {
    kind: "cu.act.result/v1",
    runId,
    outcome: "checkpoint",
    emittedActionCount: 1,
    emittedLeafActionCount: 1,
    unexecutedActionCount: 1,
    checkpoint
  });
  assert.doesNotMatch(JSON.stringify(checkpointReceipt), /private-tail|sha256|byteLength|width|height/);
});

test("maps every public act phase to a sanitized stable code and exit", () => {
  const cases: ReadonlyArray<readonly [unknown, string, number]> = [
    [new ActionInputError("action_file_invalid"), "action_file_invalid", 2],
    [new ActionInputError("action_file_too_large"), "action_file_too_large", 2],
    [new ActionInputError("action_limit_exceeded"), "action_limit_exceeded", 2],
    [new ActionInputError("action_unbalanced"), "action_unbalanced", 2],
    [new ActionInputError("action_prohibited"), "action_prohibited", 2],
    [new ActBlockedError("run_busy"), "run_busy", 3],
    [new ActBlockedError("observation_unavailable"), "observation_unavailable", 3],
    [new ActBlockedError("observation_expired"), "observation_expired", 3],
    [new ActBlockedError("observation_environment_changed"), "observation_environment_changed", 3],
    [new ActBlockedError("archive_recovery_required"), "archive_recovery_required", 3],
    [new ActBlockedError("effect_journal_unresolved"), "effect_journal_unresolved", 3],
    [new ActBlockedError("input_unavailable"), "input_unavailable", 3],
    [new ActPartialError("input_unproven"), "input_unproven", 4],
    [new ActPartialError("checkpoint_capture_failed"), "checkpoint_capture_failed", 4],
    [new ActPartialError("checkpoint_publish_failed"), "checkpoint_publish_failed", 4],
    [new ActIndeterminateError("helper_lost"), "helper_lost", 5],
    [new ActIndeterminateError("cleanup_unproven"), "cleanup_unproven", 5],
    [new ActInternalError("workspace_invalid"), "workspace_invalid", 1],
    [new ActInternalError("observation_invalid"), "observation_invalid", 1],
    [new ActInternalError("effect_journal_invalid"), "effect_journal_invalid", 1],
    [new Error("private-internal-detail"), "internal_error", 1]
  ];
  for (const [error, code, exitCode] of cases) {
    const failure = classifyPublicActFailure(error);
    assert.equal(failure.code, code);
    assert.equal(failure.exitCode, exitCode);
    assert.equal(typeof failure.message, "string");
    assert.notEqual(failure.message.length, 0);
    assert.doesNotMatch(JSON.stringify(failure), /private-internal-detail|type_text|PID|HWND/);
  }
});

test("rejects malformed act argv and action bytes before workspace effects", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-act-cli-invalid-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const actionPath = join(workspace, "action.json");
  writeFileSync(actionPath, actionBytes());
  const invalidInvocations = [
    ["act", "--json"],
    ["act", runId, "--json"],
    ["act", runId, "--action-file", "--json"],
    ["act", runId, "--action-file", actionPath, "--action-file", actionPath, "--json"],
    ["act", runId, "--action-file", actionPath, "--json", "--json"],
    ["act", runId, "--action-file", actionPath, "--unexpected", "--json"],
    ["act", "../bad", "--action-file", actionPath, "--json"]
  ];
  for (const args of invalidInvocations) {
    const result = runCli(workspace, args);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.deepEqual(parseOnlyJson(result.stdout), {
      kind: "cu.error/v1",
      code: "usage_invalid",
      message: "Invalid command invocation.",
      retryable: false
    });
    assert.equal(existsSync(join(workspace, ".cu")), false);
  }

  writeFileSync(actionPath, Buffer.from("{private-action-detail", "utf8"));
  const malformed = runCli(workspace, ["act", runId, "--action-file", actionPath, "--json"]);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stderr, "");
  assert.deepEqual(parseOnlyJson(malformed.stdout), {
    kind: "cu.error/v1",
    code: "action_file_invalid",
    message: "Action file is invalid.",
    retryable: false
  });
  assert.doesNotMatch(malformed.stdout, /private-action-detail/);
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("admits regular-file and stdin transport before mapping an unavailable workspace", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-act-cli-transport-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const actionPath = join(workspace, "action.json");
  const bytes = actionBytes();
  writeFileSync(actionPath, bytes);

  for (const invocation of [
    { args: ["act", runId, "--action-file", actionPath, "--json"], input: undefined },
    { args: ["act", runId, "--action-file", "-", "--json"], input: bytes }
  ]) {
    const result = runCli(workspace, invocation.args, invocation.input);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(parseOnlyJson(result.stdout), {
      kind: "cu.error/v1",
      code: "workspace_invalid",
      message: "Workspace state cannot be used safely.",
      retryable: false
    });
    assert.equal(existsSync(join(workspace, ".cu")), false);
  }
});

test("maps an exact held run lock to blocked run_busy before helper input", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-act-cli-busy-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const actionPath = join(workspace, "action.json");
  writeFileSync(actionPath, actionBytes());
  const lock = acquireRunLock(workspace, runId);
  try {
    const result = runCli(workspace, ["act", runId, "--action-file", actionPath, "--json"]);
    assert.equal(result.status, 3);
    assert.equal(result.stderr, "");
    assert.deepEqual(parseOnlyJson(result.stdout), {
      kind: "cu.error/v1",
      code: "run_busy",
      message: "Run is busy.",
      retryable: false
    });
  } finally {
    lock.release();
  }
});
