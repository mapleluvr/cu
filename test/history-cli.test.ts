import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureRun } from "../src/run.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");
const runId = "work-a";
const absentObservation = "obs_0123456789abcdef0123456789abcdef";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-history-cli-"));
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
}

function onlyJson(stdout: string): Record<string, unknown> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function usageFailure(result: ReturnType<typeof runCli>): void {
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "usage_invalid",
    message: "Invalid command invocation.",
    retryable: false
  });
}

test("history rejects malformed argv before workspace effects", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalid = [
    ["history", "--json"],
    ["history", "../escape", "--json"],
    ["history", runId, "list", "list", "--json"],
    ["history", runId, "show", "--json"],
    ["history", runId, "show", "obs_bad", "--json"],
    ["history", runId, "show", absentObservation, "extra", "--json"],
    ["history", runId, "--json", "--json"]
  ];
  for (const args of invalid) {
    usageFailure(runCli(root, ...args));
    assert.equal(existsSync(join(root, ".cu")), false, args.join(" "));
  }
});

test("history lists an admitted empty run and gives uniform unavailable show receipts", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  const runDirectory = join(root, ".cu", runId);
  const before = readdirSync(runDirectory).sort();

  for (const args of [
    ["history", runId, "--json"],
    ["history", runId, "list", "--json"]
  ]) {
    const listed = runCli(root, ...args);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stderr, "");
    assert.deepEqual(onlyJson(listed.stdout), {
      kind: "cu.history.result/v1",
      runId,
      items: []
    });
  }

  const first = runCli(root, "history", runId, "show", absentObservation, "--json");
  const secondObservation = "obs_1123456789abcdef0123456789abcdef";
  const second = runCli(root, "history", runId, "show", secondObservation, "--json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstReceipt = onlyJson(first.stdout);
  const secondReceipt = onlyJson(second.stdout);
  assert.deepEqual(firstReceipt, {
    kind: "cu.history.result/v1",
    runId,
    observationId: absentObservation,
    availability: "unavailable",
    diagnosticOnly: true
  });
  assert.equal(
    JSON.stringify(firstReceipt).replace(absentObservation, "OBS"),
    JSON.stringify(secondReceipt).replace(secondObservation, "OBS")
  );
  assert.deepEqual(readdirSync(runDirectory).sort(), before);
});

test("history maps an active transaction to a read-only archive block", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
  const bytes = Buffer.from(`${JSON.stringify({
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    operation: "clear_range",
    state: "prepared",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T10:00:00.000Z",
    priorLive: null,
    movedBundles: [],
    historyEvents: [],
    payload: { invalidatesLive: false, selectedObservationIds: [] }
  })}\n`, "utf8");
  writeFileSync(transactionPath, bytes);

  const result = runCli(root, "history", runId, "--json");
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "archive_recovery_required",
    message: "Observation archive requires recovery.",
    retryable: false
  });
  assert.deepEqual(readFileSync(transactionPath), bytes);
});
