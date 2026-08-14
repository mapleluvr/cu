import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureRun } from "../src/run.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-status-"));
}

function runCli(workspace: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8"
  });
}

test("status --json reports an uninitialized workspace without creating state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = runCli(workspace, "status", "--json");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.status.result/v1",
    workspace: { initialized: false },
    runs: []
  });
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("human status distinguishes uninitialized and absent-run state without mutation", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const uninitialized = runCli(workspace, "status");
  assert.equal(uninitialized.status, 0);
  assert.equal(uninitialized.stderr, "");
  assert.equal(uninitialized.stdout, "workspace: uninitialized\nruns: 0\n");
  assert.equal(existsSync(join(workspace, ".cu")), false);

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  const workspaceRecordPath = join(workspace, ".cu", "workspace.json");
  const workspaceRecord = readFileSync(workspaceRecordPath);
  const absent = runCli(workspace, "status", "work-a");
  assert.equal(absent.status, 0);
  assert.equal(absent.stderr, "");
  assert.equal(absent.stdout, "workspace: initialized\nrun: work-a\nstate: unavailable\n");
  assert.deepEqual(readFileSync(workspaceRecordPath), workspaceRecord);
  assert.deepEqual(readdirSync(join(workspace, ".cu")), ["workspace.json"]);
});

test("status --json reports an initialized workspace without changing its record", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const recordText = readFileSync(recordPath, "utf8");

  const result = runCli(workspace, "status", "--json");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.status.result/v1",
    workspace: { initialized: true },
    runs: []
  });
  assert.equal(readFileSync(recordPath, "utf8"), recordText);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("status --json rejects a malformed workspace record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const originalRecord = "{malformed";
  mkdirSync(stateDirectory);
  writeFileSync(recordPath, originalRecord, "utf8");

  const result = runCli(workspace, "status", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("status --json rejects a record copied from another workspace without repair", (t) => {
  const sourceWorkspace = createWorkspace();
  const targetWorkspace = createWorkspace();
  t.after(() => rmSync(sourceWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(targetWorkspace, { recursive: true, force: true }));

  const initialized = runCli(sourceWorkspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const originalRecord = readFileSync(join(sourceWorkspace, ".cu", "workspace.json"), "utf8");

  const stateDirectory = join(targetWorkspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  mkdirSync(stateDirectory);
  writeFileSync(recordPath, originalRecord, "utf8");

  const result = runCli(targetWorkspace, "status", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be inspected safely.",
    retryable: false
  });
  assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("status --json reports a requested absent run without creating it", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0);
  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const recordText = readFileSync(recordPath, "utf8");

  const result = runCli(workspace, "status", "work-a", "--json");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.status.result/v1",
    workspace: { initialized: true },
    run: { id: "work-a", exists: false }
  });
  assert.equal(readFileSync(recordPath, "utf8"), recordText);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("status --json projects P01 safe summaries without mutation", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const initialized = runCli(workspace, "init", "--json");
  assert.equal(initialized.status, 0, initialized.stderr);
  ensureRun(workspace, "work-a");
  const stateDirectory = join(workspace, ".cu");
  const runDirectory = join(stateDirectory, "work-a");
  const runRecord = readFileSync(join(runDirectory, "run.json"));
  const runEntries = readdirSync(runDirectory).sort();

  const workspaceStatus = runCli(workspace, "status", "--json");
  assert.equal(workspaceStatus.status, 0, workspaceStatus.stderr);
  assert.deepEqual(JSON.parse(workspaceStatus.stdout), {
    kind: "cu.status.result/v1",
    workspace: { initialized: true },
    runs: [{ id: "work-a", lifecycle: "ready", profile: "autonomous" }]
  });

  const runStatus = runCli(workspace, "status", "work-a", "--json");
  assert.equal(runStatus.status, 0, runStatus.stderr);
  assert.deepEqual(JSON.parse(runStatus.stdout), {
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
  assert.deepEqual(readFileSync(join(runDirectory, "run.json")), runRecord);
  assert.deepEqual(readdirSync(runDirectory).sort(), runEntries);
});

test("human status renders existing workspace and safe run summaries without mutation", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.equal(runCli(workspace, "init", "--json").status, 0);
  ensureRun(workspace, "work-a");
  const runDirectory = join(workspace, ".cu", "work-a");
  const runRecord = readFileSync(join(runDirectory, "run.json"));
  const runEntries = readdirSync(runDirectory).sort();

  const workspaceStatus = runCli(workspace, "status");
  assert.equal(workspaceStatus.status, 0);
  assert.equal(workspaceStatus.stderr, "");
  assert.equal(
    workspaceStatus.stdout,
    "workspace: initialized\nruns: 1\nwork-a: ready (autonomous)\n"
  );

  const runStatus = runCli(workspace, "status", "work-a");
  assert.equal(runStatus.status, 0);
  assert.equal(runStatus.stderr, "");
  assert.equal(
    runStatus.stdout,
    [
      "workspace: initialized",
      "run: work-a",
      "lifecycle: ready",
      "profile: autonomous",
      "busy: no",
      "archive: ready",
      "retained bundles: 0",
      "committed bytes: 0 / 536870912",
      "historical bundle limit: 128",
      "current observation: unavailable",
      "effect: none",
      "unavailable history events: 0",
      ""
    ].join("\n")
  );
  assert.deepEqual(readFileSync(join(runDirectory, "run.json")), runRecord);
  assert.deepEqual(readdirSync(runDirectory).sort(), runEntries);
});

test("status --json rejects invalid run IDs before touching workspace state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const runId of ["../escape", "Work-A", ".", "..", ""]) {
    const result = runCli(workspace, "status", runId, "--json");

    assert.equal(result.status, 2, runId);
    assert.equal(result.stderr, "", runId);
    assert.deepEqual(
      JSON.parse(result.stdout),
      {
        kind: "cu.error/v1",
        code: "usage_invalid",
        message: "Invalid command invocation.",
        retryable: false
      },
      runId
    );
    assert.equal(existsSync(join(workspace, ".cu")), false, runId);
  }
});
