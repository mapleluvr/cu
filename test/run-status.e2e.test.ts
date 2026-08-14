import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_CONTROL_RECORD_BYTES } from "../src/regular-file.js";
import { inspectRun, RunStateError } from "../src/run.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-run-status-"));
}

function runCli(workspace: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8"
  });
}

test("status --json reports a valid existing run without modifying its control record", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecordPath = join(runDirectory, "run.json");
  const runRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(runDirectory);
  writeFileSync(runRecordPath, runRecord, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.status.result/v1",
    workspace: { initialized: true },
    run: {
      id: "work-a",
      exists: true,
      lifecycle: "ready",
      profile: "autonomous",
      busy: false,
      archive: {
        state: "ready",
        retainedBundleCount: 0,
        committedBytes: 0,
        maxHistoricalBundles: 128,
        maxCommittedBytes: 536870912
      },
      currentObservation: { state: "unavailable" },
      effect: { state: "none" },
      history: { unavailableEventCount: 0 }
    }
  });
  assert.equal(readFileSync(runRecordPath, "utf8"), runRecord);
});

test("status --json rejects an oversized workspace record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecordPath = join(workspace, ".cu", "workspace.json");
  const workspaceRecord = JSON.parse(readFileSync(workspaceRecordPath, "utf8")) as object;
  const oversizedRecord = `${JSON.stringify({
    ...workspaceRecord,
    padding: "x".repeat(MAX_CONTROL_RECORD_BYTES)
  })}\n`;
  assert.ok(Buffer.byteLength(oversizedRecord, "utf8") > MAX_CONTROL_RECORD_BYTES);
  writeFileSync(workspaceRecordPath, oversizedRecord, "utf8");

  const result = runCli(workspace, "status", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(workspaceRecordPath, "utf8"), oversizedRecord);
});

test("status --json rejects an oversized run record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecordPath = join(runDirectory, "run.json");
  const oversizedRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}${" ".repeat(MAX_CONTROL_RECORD_BYTES)}\n`;
  assert.ok(Buffer.byteLength(oversizedRecord, "utf8") > MAX_CONTROL_RECORD_BYTES);
  mkdirSync(runDirectory);
  writeFileSync(runRecordPath, oversizedRecord, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(runRecordPath, "utf8"), oversizedRecord);
});

test("status --json rejects a malformed run record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecordPath = join(runDirectory, "run.json");
  const originalRecord = "{malformed";
  mkdirSync(runDirectory);
  writeFileSync(runRecordPath, originalRecord, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(runRecordPath, "utf8"), originalRecord);
});

test("status --json rejects an unknown run record property without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecordPath = join(runDirectory, "run.json");
  const originalRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z",
    unexpected: true
  })}\n`;
  mkdirSync(runDirectory);
  writeFileSync(runRecordPath, originalRecord, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(runRecordPath, "utf8"), originalRecord);
});

test("status --json rejects a run record copied from another workspace without repair", (t) => {
  const sourceWorkspace = createWorkspace();
  const targetWorkspace = createWorkspace();
  t.after(() => rmSync(sourceWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(targetWorkspace, { recursive: true, force: true }));

  assert.equal(runCli(sourceWorkspace, "init", "--json").status, 0);
  assert.equal(runCli(targetWorkspace, "init", "--json").status, 0);
  const sourceWorkspaceRecord = JSON.parse(
    readFileSync(join(sourceWorkspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const sourceRunRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: sourceWorkspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  const targetRunDirectory = join(targetWorkspace, ".cu", "work-a");
  const targetRunRecordPath = join(targetRunDirectory, "run.json");
  mkdirSync(targetRunDirectory);
  writeFileSync(targetRunRecordPath, sourceRunRecord, "utf8");

  const result = runCli(targetWorkspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(targetRunRecordPath, "utf8"), sourceRunRecord);
});

test("status --json rejects a run record whose identity mismatches its directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecordPath = join(runDirectory, "run.json");
  const originalRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-b",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(runDirectory);
  writeFileSync(runRecordPath, originalRecord, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(runRecordPath, "utf8"), originalRecord);
});

test("status --json rejects invalid required run record values without repair", (t) => {
  for (const [property, value] of [
    ["kind", "cu.run/v2"],
    ["schemaVersion", 2],
    ["profile", "cautious"],
    ["lifecycle", "unknown"],
    ["createdAt", "not-a-timestamp"]
  ] as const) {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));

    assert.equal(runCli(workspace, "init", "--json").status, 0, property);
    const workspaceRecord = JSON.parse(
      readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
    ) as { rootFingerprint: string };
    const runDirectory = join(workspace, ".cu", "work-a");
    const runRecordPath = join(runDirectory, "run.json");
    const record = {
      kind: "cu.run/v1",
      schemaVersion: 1,
      runId: "work-a",
      workspaceFingerprint: workspaceRecord.rootFingerprint,
      profile: "autonomous",
      lifecycle: "ready",
      createdAt: "2026-07-24T00:00:00.000Z",
      [property]: value
    };
    const originalRecord = `${JSON.stringify(record)}\n`;
    mkdirSync(runDirectory);
    writeFileSync(runRecordPath, originalRecord, "utf8");

    const result = runCli(workspace, "status", "work-a", "--json");

    assert.equal(result.status, 1, property);
    assert.equal(result.stderr, "", property);
    assert.deepEqual(
      JSON.parse(result.stdout),
      {
        kind: "cu.error/v1",
        code: "run_invalid",
        message: "Run state cannot be inspected safely.",
        retryable: false
      },
      property
    );
    assert.equal(readFileSync(runRecordPath, "utf8"), originalRecord, property);
  }
});

test("status --json rejects a junctioned run directory without following it", (t) => {
  const workspace = createWorkspace();
  const outsideRoot = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const outsideRunDirectory = join(outsideRoot, "outside-run");
  const outsideRunRecordPath = join(outsideRunDirectory, "run.json");
  const outsideRunRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(outsideRunDirectory);
  writeFileSync(outsideRunRecordPath, outsideRunRecord, "utf8");
  symlinkSync(outsideRunDirectory, join(workspace, ".cu", "work-a"), "junction");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(outsideRunRecordPath, "utf8"), outsideRunRecord);
});

test("status --json rejects a file-symlinked run record without following it", (t) => {
  const workspace = createWorkspace();
  const outsideRoot = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const outsideRunRecordPath = join(outsideRoot, "outside-run.json");
  const outsideRunRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  const runDirectory = join(workspace, ".cu", "work-a");
  const linkedRecordPath = join(runDirectory, "run.json");
  mkdirSync(runDirectory);
  writeFileSync(outsideRunRecordPath, outsideRunRecord, "utf8");
  try {
    symlinkSync(outsideRunRecordPath, linkedRecordPath, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Current Windows policy does not permit unprivileged file symlinks.");
      return;
    }
    throw error;
  }

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(outsideRunRecordPath, "utf8"), outsideRunRecord);
});

test("status --json rejects an incomplete run directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const runDirectory = join(workspace, ".cu", "work-a");
  mkdirSync(runDirectory);

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
  assert.deepEqual(readdirSync(runDirectory), []);
});

test("inspectRun rejects a path-like run ID before lookup", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecord = JSON.parse(
    readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
  ) as { rootFingerprint: string };
  const escapedDirectory = join(workspace, "escape");
  const escapedRecordPath = join(escapedDirectory, "run.json");
  const escapedRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "../escape",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(escapedDirectory);
  writeFileSync(escapedRecordPath, escapedRecord, "utf8");

  assert.throws(() => inspectRun(workspace, "../escape"), RunStateError);
  assert.equal(readFileSync(escapedRecordPath, "utf8"), escapedRecord);
});

test("status --json rejects a broken run-directory junction", (t) => {
  const workspace = createWorkspace();
  const outsideRoot = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  symlinkSync(join(outsideRoot, "missing-target"), join(workspace, ".cu", "work-a"), "junction");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "run_invalid",
    message: "Run state cannot be inspected safely.",
    retryable: false
  });
});

test("status --json rejects workspace state redirected through a junction", (t) => {
  const workspace = createWorkspace();
  const outsideRoot = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceStateDirectory = join(workspace, ".cu");
  const workspaceRecordPath = join(workspaceStateDirectory, "workspace.json");
  const workspaceRecordText = readFileSync(workspaceRecordPath, "utf8");
  const workspaceRecord = JSON.parse(workspaceRecordText) as { rootFingerprint: string; };
  const outsideStateDirectory = join(outsideRoot, "outside-state");
  const outsideWorkspaceRecordPath = join(outsideStateDirectory, "workspace.json");
  const outsideRunDirectory = join(outsideStateDirectory, "work-a");
  const outsideRunRecordPath = join(outsideRunDirectory, "run.json");
  const outsideRunRecord = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId: "work-a",
    workspaceFingerprint: workspaceRecord.rootFingerprint,
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(outsideStateDirectory);
  mkdirSync(outsideRunDirectory);
  copyFileSync(workspaceRecordPath, outsideWorkspaceRecordPath);
  writeFileSync(outsideRunRecordPath, outsideRunRecord, "utf8");
  rmSync(workspaceStateDirectory, { recursive: true, force: true });
  symlinkSync(outsideStateDirectory, workspaceStateDirectory, "junction");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(outsideWorkspaceRecordPath, "utf8"), workspaceRecordText);
  assert.equal(readFileSync(outsideRunRecordPath, "utf8"), outsideRunRecord);
});

test("init --json rejects workspace state redirected through a junction", (t) => {
  const workspace = createWorkspace();
  const outsideRoot = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceStateDirectory = join(workspace, ".cu");
  const workspaceRecordPath = join(workspaceStateDirectory, "workspace.json");
  const workspaceRecordText = readFileSync(workspaceRecordPath, "utf8");
  const outsideStateDirectory = join(outsideRoot, "outside-state");
  const outsideWorkspaceRecordPath = join(outsideStateDirectory, "workspace.json");
  mkdirSync(outsideStateDirectory);
  copyFileSync(workspaceRecordPath, outsideWorkspaceRecordPath);
  rmSync(workspaceStateDirectory, { recursive: true, force: true });
  symlinkSync(outsideStateDirectory, workspaceStateDirectory, "junction");

  const result = runCli(workspace, "init", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be initialized safely.",
    retryable: false
  });
  assert.equal(readFileSync(outsideWorkspaceRecordPath, "utf8"), workspaceRecordText);
});
