import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mutableFs, {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import { inspectArchiveTransactionWithWitness } from "../src/archive-store.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import {
  beginEffectIntent,
  finalizeEffectJournalForArchiveTransaction,
  inspectActAuthority,
  proveEffectArchiveResolution,
  revalidateEffectArchiveResolutionProof
} from "../src/effect-store.js";
import { publishCaptureObservation, recoverObservationArchive } from "../src/observation-archive.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";
import type { RegionalCapture } from "../src/windows-capture.js";

const runId = "work-a";
const observationId = "obs_0123456789abcdef0123456789abcdef";
const effectId = "eff_0123456789abcdef0123456789abcdef";
const mutableFsHooks = mutableFs as unknown as {
  openSync: typeof mutableFs.openSync;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotDirectory(path: string, relative = ""): readonly string[] {
  const snapshot: string[] = [];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    const childRelative = relative === "" ? name : `${relative}/${name}`;
    const status = lstatSync(child);
    if (status.isDirectory() && !status.isSymbolicLink()) {
      snapshot.push(`d:${childRelative}`);
      snapshot.push(...snapshotDirectory(child, childRelative));
    } else if (status.isFile() && !status.isSymbolicLink()) {
      snapshot.push(`f:${childRelative}:${sha256(readFileSync(child))}`);
    } else {
      snapshot.push(`x:${childRelative}`);
    }
  }
  return Object.freeze(snapshot);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function pngBytes(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

async function regionalCapture(
  workspace: string,
  id: string,
  capturedAt: Date
): Promise<RegionalCapture> {
  const image = pngBytes();
  const fingerprint = workspaceFingerprint(workspace);
  const expiresAt = new Date(capturedAt.getTime() + 60_000).toISOString();
  const sidecar = Buffer.from(`${JSON.stringify({
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: fingerprint,
    observationId: id,
    capturedAt: capturedAt.toISOString(),
    expiresAt,
    coordinateSpace: "normalized_999_top_left",
    source: {
      captureKind: "region",
      mapping: "normalized_endpoint_centers/v1",
      leftPx: 10,
      topPx: 20,
      widthPx: 2,
      heightPx: 1
    },
    environmentFingerprint: "b".repeat(64),
    topologyFingerprint: "c".repeat(64),
    image: {
      mediaType: "image/png",
      sha256: sha256(image),
      byteLength: image.length,
      width: 2,
      height: 1
    }
  })}\n`, "utf8");
  const bundle = await validateCaptureBundleBytes(sidecar, image, {
    runId,
    workspaceFingerprint: fingerprint
  });
  return Object.freeze({
    bundle,
    observationId: id,
    capturedAt: capturedAt.toISOString(),
    expiresAt,
    captureMetadataSha256: bundle.captureMetadataSha256,
    environmentFingerprint: "b".repeat(64),
    topologyFingerprint: "c".repeat(64),
    sourceRectPx: Object.freeze({ x: 10, y: 20, width: 2, height: 1 })
  });
}

async function seedActionableObservation(workspace: string, capturedAt: Date): Promise<void> {
  const capture = await regionalCapture(workspace, observationId, capturedAt);
  const lock = acquireRunLock(workspace, runId);
  try {
    await publishCaptureObservation(lock, workspace, runId, capture.bundle, {
      now: () => new Date(capturedAt.getTime() + 1_000),
      createTransactionId: () => "txn_0123456789abcdef0123456789abcdef",
      createHistoryEventId: () => "hist_0123456789abcdef0123456789abcdef_1"
    });
  } finally {
    lock.release();
  }
}

function admittedPlan() {
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions: [{ kind: "click", at: { x: 420, y: 318 } }]
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted plan");
  return admitted.plan;
}

async function leavePostCutoverRecovery(
  workspace: string,
  capturedAt: Date
): Promise<void> {
  const originalOpen = mutableFsHooks.openSync;
  const lock = acquireRunLock(workspace, runId);
  try {
    const plan = admittedPlan();
    const effectPlan = buildEffectSegmentPlan(plan, segmentActionPlan(plan));
    const authority = await inspectActAuthority(lock, workspace, runId, {
      observationId,
      now: () => new Date(capturedAt.getTime() + 2_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64)
    });
    const intent = beginEffectIntent(lock, workspace, runId, authority, {
      effectId,
      startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
      plan: effectPlan,
      now: () => new Date(capturedAt.getTime() + 3_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64)
    });
    const recoveryCapture = await regionalCapture(
      workspace,
      "obs_4123456789abcdef0123456789abcdef",
      new Date(capturedAt.getTime() + 4_000)
    );
    mutableFsHooks.openSync = ((
      path: Parameters<typeof mutableFs.openSync>[0],
      flags: Parameters<typeof mutableFs.openSync>[1],
      mode?: Parameters<typeof mutableFs.openSync>[2]
    ) => {
      if (basename(String(path)) === "history.ndjson" && flags === "r+") {
        throw Object.assign(new Error("injected"), { code: "EACCES" });
      }
      return originalOpen(path, flags, mode);
    }) as typeof mutableFs.openSync;
    syncBuiltinESMExports();
    await assert.rejects(
      publishCaptureObservation(lock, workspace, runId, recoveryCapture.bundle, {
        resolveEffect: intent,
        now: () => new Date(capturedAt.getTime() + 5_000),
        createTransactionId: () => "txn_4123456789abcdef0123456789abcdef",
        createHistoryEventId: (index) =>
          `hist_4123456789abcdef0123456789abcdef_${index + 1}`
      })
    );
  } finally {
    mutableFsHooks.openSync = originalOpen;
    syncBuiltinESMExports();
    lock.release();
  }
}

test("effect-resolution proof rejects a same-inode byte-identical predecessor PNG rewrite", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-png-rewrite-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const capturedAt = new Date();
    await seedActionableObservation(workspace, capturedAt);
    await leavePostCutoverRecovery(workspace, capturedAt);

    const runDirectory = join(workspace, ".cu", runId);
    const lock = acquireRunLock(workspace, runId);
    try {
      const active = inspectArchiveTransactionWithWitness(workspace, runId);
      assert.notEqual(active, undefined);
      if (active === undefined) assert.fail("expected active transaction");
      const proof = await proveEffectArchiveResolution(lock, workspace, runId, active);
      const imagePath = join(runDirectory, "captures", `${observationId}.png`);
      const imageBytes = readFileSync(imagePath);
      const beforeIdentity = lstatSync(imagePath, { bigint: true });
      writeFileSync(imagePath, imageBytes);
      const changedAt = new Date(capturedAt.getTime() + 30_000);
      utimesSync(imagePath, changedAt, changedAt);
      const afterIdentity = lstatSync(imagePath, { bigint: true });
      assert.equal(afterIdentity.dev, beforeIdentity.dev);
      assert.equal(afterIdentity.ino, beforeIdentity.ino);
      assert.equal(afterIdentity.birthtimeNs, beforeIdentity.birthtimeNs);
      const afterRewrite = snapshotDirectory(runDirectory);
      assert.throws(() =>
        revalidateEffectArchiveResolutionProof(proof, lock, workspace, runId)
      );
      assert.deepEqual(snapshotDirectory(runDirectory), afterRewrite);
      assert.equal(existsSync(join(runDirectory, "effect-journal.json")), true);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), true);
      assert.equal(existsSync(join(runDirectory, "@archive")), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("effect-resolution proof rejects active transaction replacement before journal deletion", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-active-replacement-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const capturedAt = new Date();
    await seedActionableObservation(workspace, capturedAt);
    await leavePostCutoverRecovery(workspace, capturedAt);

    const runDirectory = join(workspace, ".cu", runId);
    const transactionPath = join(runDirectory, "archive-transaction.json");
    const displacedPath = `${transactionPath}.displaced`;
    const lock = acquireRunLock(workspace, runId);
    try {
      const active = inspectArchiveTransactionWithWitness(workspace, runId);
      assert.notEqual(active, undefined);
      if (active === undefined) assert.fail("expected active transaction");
      const proof = await proveEffectArchiveResolution(lock, workspace, runId, active);
      const transactionBytes = readFileSync(transactionPath);
      renameSync(transactionPath, displacedPath);
      writeFileSync(transactionPath, transactionBytes);
      assert.throws(() =>
        finalizeEffectJournalForArchiveTransaction(lock, workspace, runId, proof)
      );
      assert.equal(existsSync(join(runDirectory, "effect-journal.json")), true);
      rmSync(transactionPath);
      renameSync(displacedPath, transactionPath);
      assert.equal(await recoverObservationArchive(lock, workspace, runId), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("effect recovery requires exact journal, predecessor bundle, and latest retained history before mutation", async (t) => {
  for (const mode of [
    "captured_at_mismatch",
    "later_evicted",
    "journal_mismatch",
    "predecessor_missing",
    "predecessor_mismatch",
    "attributable_history_partial"
  ] as const) {
    await t.test(mode, async () => {
      const workspace = mkdtempSync(join(tmpdir(), `cu-effect-history-${mode}-`));
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      const capturedAt = new Date();
      await seedActionableObservation(workspace, capturedAt);
      await leavePostCutoverRecovery(workspace, capturedAt);

      const runDirectory = join(workspace, ".cu", runId);
      const historyPath = join(runDirectory, "history.ndjson");
      const historyLines = readFileSync(historyPath, "utf8").trimEnd().split("\n");
      assert.equal(historyLines.length, 1);
      const retained = JSON.parse(historyLines[0]!) as Record<string, unknown>;
      if (mode === "captured_at_mismatch") {
        retained.capturedAt = new Date(capturedAt.getTime() + 1).toISOString();
        writeFileSync(historyPath, `${JSON.stringify(retained)}\n`, "utf8");
      } else if (mode === "later_evicted") {
        writeFileSync(historyPath, `${JSON.stringify({
          ...retained,
          eventId: "hist_5123456789abcdef0123456789abcdef_1",
          transactionId: "txn_5123456789abcdef0123456789abcdef",
          at: new Date(capturedAt.getTime() + 2_000).toISOString(),
          eventType: "capture_evicted"
        })}\n`, { flag: "a" });
      } else if (mode === "journal_mismatch") {
        const journalPath = join(runDirectory, "effect-journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          observation: { environmentFingerprint: string };
        };
        journal.observation.environmentFingerprint = "d".repeat(64);
        writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
      } else if (mode === "predecessor_missing") {
        renameSync(
          join(runDirectory, "captures", `${observationId}.json`),
          join(workspace, `${observationId}.json.held`)
        );
        renameSync(
          join(runDirectory, "captures", `${observationId}.png`),
          join(workspace, `${observationId}.png.held`)
        );
      } else if (mode === "predecessor_mismatch") {
        const predecessorPath = join(runDirectory, "captures", `${observationId}.json`);
        const predecessor = JSON.parse(readFileSync(predecessorPath, "utf8")) as {
          environmentFingerprint: string;
        };
        predecessor.environmentFingerprint = "d".repeat(64);
        writeFileSync(predecessorPath, `${JSON.stringify(predecessor)}\n`, "utf8");
      } else {
        const active = inspectArchiveTransactionWithWitness(workspace, runId);
        assert.notEqual(active, undefined);
        if (active === undefined || active.transaction.operation !== "publish") {
          assert.fail("expected active publish transaction");
        }
        const event = active.transaction.historyEvents[0]!;
        const line = Buffer.from(`${JSON.stringify({
          kind: "cu.history.event/v1",
          schemaVersion: 1,
          ...event,
          transactionId: active.transaction.transactionId,
          runId: active.transaction.runId,
          workspaceFingerprint: active.transaction.workspaceFingerprint
        })}\n`, "utf8");
        writeFileSync(historyPath, line.subarray(0, Math.floor(line.length / 2)), {
          flag: "a"
        });
      }

      const beforeRecovery = snapshotDirectory(runDirectory);
      const recoveryLock = acquireRunLock(workspace, runId);
      try {
        if (mode === "attributable_history_partial") {
          assert.equal(await recoverObservationArchive(recoveryLock, workspace, runId), true);
        } else {
          await assert.rejects(recoverObservationArchive(recoveryLock, workspace, runId));
        }
      } finally {
        recoveryLock.release();
      }
      if (mode === "attributable_history_partial") {
        assert.equal(readFileSync(historyPath).includes(Buffer.from("effect_recovered", "utf8")), true);
        assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
        assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      } else {
        assert.deepEqual(snapshotDirectory(runDirectory), beforeRecovery);
        assert.equal(existsSync(join(runDirectory, "effect-journal.json")), true);
        assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), true);
        assert.equal(existsSync(join(runDirectory, "@archive")), true);
      }
    } finally {
      mutableFsHooks.openSync = mutableFs.openSync;
      syncBuiltinESMExports();
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
});
