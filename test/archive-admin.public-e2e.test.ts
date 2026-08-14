import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import { parseArchiveTransactionBytes } from "../src/archive-transaction.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import { beginEffectIntent, inspectActAuthority } from "../src/effect-store.js";
import { acquireRunLock } from "../src/run-lock.js";
import { workspaceFingerprint } from "../src/workspace.js";
import { startControlledWindowFixture } from "./support/controlled-window.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = "work-a";

function quoteForCmd(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function runNpm(cwd: string, args: readonly string[]) {
  if (process.platform !== "win32") {
    return spawnSync("npm", args, { cwd, encoding: "utf8", shell: false });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `npm ${args.map(quoteForCmd).join(" ")}`],
    { cwd, encoding: "utf8", windowsHide: true }
  );
}

function runInstalledCli(cliPath: string, workspace: string, args: readonly string[]) {
  if (process.platform !== "win32") {
    return spawnSync(cliPath, args, { cwd: workspace, encoding: "utf8", shell: false });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `${quoteForCmd(cliPath)} ${args.map(quoteForCmd).join(" ")}`],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true
    }
  );
}

function plusMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function assertPublicError(
  result: ReturnType<typeof runInstalledCli>,
  status: number,
  code: string,
  message: string
): void {
  assert.equal(result.status, status);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code,
    message,
    retryable: false
  });
}

function snapshotRun(workspace: string): Record<string, string> {
  const runDirectory = join(workspace, ".cu", runId);
  const snapshot: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (lstatSync(path).isDirectory()) {
        snapshot[`${relative}/`] = "";
        walk(path, relative);
      } else {
        snapshot[relative] = readFileSync(path).toString("hex");
      }
    }
  };
  walk(runDirectory, "");
  return snapshot;
}

function effectPlan(observationId: string) {
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions: [{ kind: "click", at: { x: 500, y: 500 } }]
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted action plan");
  return buildEffectSegmentPlan(admitted.plan, segmentActionPlan(admitted.plan));
}

function observe(cliPath: string, workspace: string, region: string) {
  const result = runInstalledCli(cliPath, workspace, [
    "observe", runId, "--region", region, "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as {
    kind: string;
    observationId: string;
    capturedAt: string;
    expiresAt: string;
    imagePath: string;
    actionable: boolean;
  };
}

test(
  "installed archive-admin CLI proves history, status, range, all cleanup, and unavailable uniformity",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cu-archive-admin-public-e2e-"));
    const packDirectory = join(root, "pack");
    const installDirectory = join(root, "install");
    const workspace = join(root, "workspace");
    for (const path of [packDirectory, installDirectory, workspace]) {
      mkdirSync(path, { recursive: true });
    }
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const packed = runNpm(repositoryRoot, ["pack", "--pack-destination", packDirectory]);
    assert.equal(packed.status, 0, packed.stderr);
    const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const installed = runNpm(installDirectory, [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
      join(packDirectory, tarballs[0]!)
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    const cliPath = join(installDirectory, "node_modules", ".bin", "cu.cmd");
    assert.equal(existsSync(cliPath), true);

    const initialized = runInstalledCli(cliPath, workspace, ["init", "--json"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.deepEqual(JSON.parse(initialized.stdout), {
      kind: "cu.init.result/v1",
      created: true
    });

    const fixture = await startControlledWindowFixture();
    t.after(async () => fixture.stop());
    const region = `pixel:${fixture.target.x},${fixture.target.y},${fixture.target.width},${fixture.target.height}`;
    const first = observe(cliPath, workspace, region);
    const second = observe(cliPath, workspace, region);
    const third = observe(cliPath, workspace, region);
    assert.equal(first.kind, "cu.observe.result/v1");
    assert.equal(first.actionable, true);
    assert.notEqual(first.capturedAt, second.capturedAt);
    assert.notEqual(second.capturedAt, third.capturedAt);

    const runDirectory = join(workspace, ".cu", runId);
    const fingerprint = workspaceFingerprint(workspace);
    const liveBeforeStatus = readFileSync(join(runDirectory, "live-observation.json"));
    const historyBeforeStatus = readFileSync(join(runDirectory, "history.ndjson"));
    const statusBefore = runInstalledCli(cliPath, workspace, ["status", runId, "--json"]);
    assert.equal(statusBefore.status, 0, statusBefore.stderr);
    const status = JSON.parse(statusBefore.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(status).sort(), ["kind", "run", "workspace"]);
    const statusRun = status.run as Record<string, unknown>;
    assert.deepEqual(Object.keys(statusRun).sort(), [
      "archive", "busy", "currentObservation", "effect", "exists", "history", "id", "lifecycle", "profile"
    ]);
    assert.deepEqual(statusRun.currentObservation, { state: "recorded_actionable" });
    assert.deepEqual(statusRun.effect, { state: "none" });
    assert.deepEqual(statusRun.history, { unavailableEventCount: 0 });
    const archiveStatus = statusRun.archive as Record<string, unknown>;
    assert.deepEqual(Object.keys(archiveStatus).sort(), [
      "committedBytes", "maxCommittedBytes", "maxHistoricalBundles", "retainedBundleCount", "state"
    ]);
    assert.equal(archiveStatus.state, "ready");
    assert.equal(archiveStatus.retainedBundleCount, 3);
    assert.equal(typeof archiveStatus.committedBytes, "number");
    assert.ok(Number(archiveStatus.committedBytes) > 0);
    assert.equal(archiveStatus.maxHistoricalBundles, 128);
    assert.equal(archiveStatus.maxCommittedBytes, 536870912);
    assert.deepEqual(readFileSync(join(runDirectory, "live-observation.json")), liveBeforeStatus);
    assert.deepEqual(readFileSync(join(runDirectory, "history.ndjson")), historyBeforeStatus);

    const history = runInstalledCli(cliPath, workspace, ["history", runId, "--json"]);
    assert.equal(history.status, 0, history.stderr);
    const historyReceipt = JSON.parse(history.stdout) as {
      kind: string;
      runId: string;
      items: readonly { observationId: string; availability: string; capturedAt: string; diagnosticOnly: true }[];
    };
    assert.deepEqual(Object.keys(historyReceipt).sort(), ["items", "kind", "runId"]);
    assert.equal(historyReceipt.kind, "cu.history.result/v1");
    assert.equal(historyReceipt.runId, runId);
    assert.deepEqual(
      historyReceipt.items.map((item) => item.observationId),
      [third.observationId, second.observationId, first.observationId]
    );
    assert.ok(historyReceipt.items.every((item) => item.availability === "available" && item.diagnosticOnly));
    for (const item of historyReceipt.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        "availability", "capturedAt", "diagnosticOnly", "observationId"
      ]);
    }

    const shown = runInstalledCli(cliPath, workspace, [
      "history", runId, "show", first.observationId, "--json"
    ]);
    assert.equal(shown.status, 0, shown.stderr);
    const shownReceipt = JSON.parse(shown.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(shownReceipt).sort(), [
      "availability", "capturedAt", "coordinateSpace", "diagnosticOnly", "imagePath", "kind", "observationId", "runId"
    ]);
    assert.equal(shownReceipt.availability, "available");
    assert.equal(shownReceipt.diagnosticOnly, true);
    assert.equal(shownReceipt.imagePath, `.cu/${runId}/captures/${first.observationId}.png`);
    const publicProjection = JSON.stringify({ status, historyReceipt, shownReceipt });
    for (const forbidden of ["sha256", "byteLength", "source", "effectId", "transactionId", "type_text", workspace]) {
      assert.equal(publicProjection.includes(forbidden), false, forbidden);
    }

    const transactionPath = join(runDirectory, "archive-transaction.json");
    const activeTransaction = Buffer.from(`${JSON.stringify({
      kind: "cu.archive-transaction/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: fingerprint,
      transactionId: "txn_0123456789abcdef0123456789abcdef",
      operation: "clear_all",
      state: "prepared",
      createdAt: first.capturedAt,
      updatedAt: first.capturedAt,
      priorLive: null,
      movedBundles: [],
      historyEvents: [],
      payload: { deletesLiveRecord: true, selectedObservationIds: [] }
    })}\n`, "utf8");
    assert.doesNotThrow(() => parseArchiveTransactionBytes(activeTransaction, {
      runId,
      workspaceFingerprint: fingerprint
    }));
    writeFileSync(transactionPath, activeTransaction, { flag: "wx" });
    const blockedBefore = snapshotRun(workspace);
    const blockedStatus = runInstalledCli(cliPath, workspace, ["status", runId, "--json"]);
    assert.equal(blockedStatus.status, 0, blockedStatus.stderr);
    assert.equal(blockedStatus.stderr, "");
    assert.deepEqual(JSON.parse(blockedStatus.stdout), {
      kind: "cu.status.result/v1",
      workspace: { initialized: true },
      run: {
        id: runId,
        exists: true,
        lifecycle: "ready",
        profile: "autonomous",
        busy: false,
        archive: {
          state: "recovery_required",
          retainedBundleCount: null,
          committedBytes: null,
          maxHistoricalBundles: 128,
          maxCommittedBytes: 536870912
        },
        currentObservation: { state: "unknown" },
        effect: { state: "unknown" },
        history: { unavailableEventCount: null }
      }
    });
    assert.deepEqual(snapshotRun(workspace), blockedBefore);
    assertPublicError(
      runInstalledCli(cliPath, workspace, ["history", runId, "--json"]),
      3,
      "archive_recovery_required",
      "Observation archive requires recovery."
    );
    assertPublicError(
      runInstalledCli(cliPath, workspace, ["clearall", runId, "--json"]),
      3,
      "archive_recovery_required",
      "Observation archive requires recovery."
    );
    assert.deepEqual(snapshotRun(workspace), blockedBefore);
    unlinkSync(transactionPath);

    const heldLock = acquireRunLock(workspace, runId);
    try {
      const busyBefore = snapshotRun(workspace);
      assertPublicError(
        runInstalledCli(cliPath, workspace, ["clearall", runId, "--json"]),
        3,
        "run_busy",
        "Run is busy."
      );
      assert.deepEqual(snapshotRun(workspace), busyBefore);
    } finally {
      heldLock.release();
    }

    const journalPath = join(runDirectory, "effect-journal.json");
    writeFileSync(journalPath, Buffer.from("not-json\n", "utf8"), { flag: "wx" });
    const invalidBefore = snapshotRun(workspace);
    assertPublicError(
      runInstalledCli(cliPath, workspace, ["status", runId, "--json"]),
      1,
      "effect_journal_invalid",
      "Effect journal state is invalid."
    );
    assertPublicError(
      runInstalledCli(cliPath, workspace, ["clearall", runId, "--json"]),
      1,
      "effect_journal_invalid",
      "Effect journal state is invalid."
    );
    assert.deepEqual(snapshotRun(workspace), invalidBefore);
    unlinkSync(journalPath);

    const livePath = join(runDirectory, "live-observation.json");
    const originalLive = readFileSync(livePath);
    const sidecar = JSON.parse(readFileSync(
      join(runDirectory, "captures", `${third.observationId}.json`), "utf8"
    )) as { capturedAt: string; environmentFingerprint: string; topologyFingerprint: string };
    const effectLock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(effectLock, workspace, runId, {
        observationId: third.observationId,
        now: () => new Date(new Date(sidecar.capturedAt).getTime() + 1_000),
        environmentFingerprint: sidecar.environmentFingerprint,
        topologyFingerprint: sidecar.topologyFingerprint
      });
      beginEffectIntent(effectLock, workspace, runId, authority, {
        effectId: "eff_0123456789abcdef0123456789abcdef",
        startedAt: new Date(new Date(sidecar.capturedAt).getTime() + 2_000).toISOString(),
        plan: effectPlan(third.observationId),
        now: () => new Date(new Date(sidecar.capturedAt).getTime() + 2_000),
        environmentFingerprint: sidecar.environmentFingerprint,
        topologyFingerprint: sidecar.topologyFingerprint
      });
    } finally {
      effectLock.release();
    }
    const unresolvedBefore = snapshotRun(workspace);
    assertPublicError(
      runInstalledCli(cliPath, workspace, ["clearall", runId, "--json"]),
      3,
      "effect_journal_unresolved",
      "An unresolved effect blocks this command."
    );
    assert.deepEqual(snapshotRun(workspace), unresolvedBefore);
    unlinkSync(journalPath);
    writeFileSync(livePath, originalLive);

    const clear = runInstalledCli(cliPath, workspace, [
      "clear", runId, first.capturedAt, plusMilliseconds(first.capturedAt, 1), "--json"
    ]);
    assert.equal(clear.status, 0, clear.stderr);
    assert.deepEqual(JSON.parse(clear.stdout), {
      kind: "cu.clear.result/v1",
      runId,
      clearedCount: 1,
      invalidatedCurrent: false
    });

    const cleared = runInstalledCli(cliPath, workspace, [
      "history", runId, "show", first.observationId, "--json"
    ]);
    const neverRetained = runInstalledCli(cliPath, workspace, [
      "history", runId, "show", "obs_ffffffffffffffffffffffffffffffff", "--json"
    ]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(neverRetained.status, 0, neverRetained.stderr);
    const clearedReceipt = JSON.parse(cleared.stdout) as Record<string, unknown>;
    const neverReceipt = JSON.parse(neverRetained.stdout) as Record<string, unknown>;
    assert.deepEqual(
      { ...clearedReceipt, observationId: "" },
      { ...neverReceipt, observationId: "" }
    );
    assert.equal(clearedReceipt.availability, "unavailable");

    const clearCurrent = runInstalledCli(cliPath, workspace, [
      "clear", runId, third.capturedAt, plusMilliseconds(third.capturedAt, 1), "--json"
    ]);
    assert.equal(clearCurrent.status, 0, clearCurrent.stderr);
    assert.deepEqual(JSON.parse(clearCurrent.stdout), {
      kind: "cu.clear.result/v1",
      runId,
      clearedCount: 1,
      invalidatedCurrent: true
    });

    const clearAll = runInstalledCli(cliPath, workspace, ["clearall", runId, "--json"]);
    assert.equal(clearAll.status, 0, clearAll.stderr);
    assert.deepEqual(JSON.parse(clearAll.stdout), {
      kind: "cu.clearall.result/v1",
      runId,
      clearedCount: 1
    });
    assert.deepEqual(readdirSync(runDirectory).sort(), ["run.json"]);

    const finalHistory = runInstalledCli(cliPath, workspace, ["history", runId, "--json"]);
    assert.equal(finalHistory.status, 0, finalHistory.stderr);
    assert.deepEqual(JSON.parse(finalHistory.stdout), {
      kind: "cu.history.result/v1",
      runId,
      items: []
    });

    const finalLive = join(runDirectory, "live-observation.json");
    assert.equal(existsSync(finalLive), false);
    assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
    assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
    assert.equal(fingerprint, workspaceFingerprint(workspace));
  }
);
