import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArchiveQueryBlockedError,
  ArchiveQueryError,
  listRunHistory,
  showRunHistory,
  inspectRunStatus
} from "../src/archive-query.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { parseHistoryEventBytes } from "../src/history-event.js";
import { publishCaptureObservation } from "../src/observation-archive.js";
import { acquireRunLock } from "../src/run-lock.js";
import { ensureRun } from "../src/run.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const mutableFs = createRequire(import.meta.url)("node:fs") as {
  lstatSync: typeof import("node:fs").lstatSync;
};

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-archive-query-"));
}

const runId = "run-a";
const absentObservation = "obs_00000000000000000000000000000001";
const firstObservation = "obs_0123456789abcdef0123456789abcdef";
const secondObservation = "obs_1123456789abcdef0123456789abcdef";

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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
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
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evictedHistoryBytes(root: string): Buffer {
  return Buffer.from(`${JSON.stringify({
    kind: "cu.history.event/v1",
    schemaVersion: 1,
    eventId: "hist_0123456789abcdef0123456789abcdef_1",
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    at: "2026-07-25T10:00:00.000Z",
    eventType: "capture_evicted",
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
    observationId: absentObservation,
    capturedAt: "2026-07-25T10:00:00.000Z"
  })}\n`, "utf8");
}

async function requireHistoryMutationRejection(mode: "rewrite" | "replace"): Promise<void> {
  const root = workspace();
  const historyPath = join(root, ".cu", runId, "history.ndjson");
  const displacedPath = `${historyPath}.displaced`;
  let historySamples = 0;
  let injected = false;
  const mutableLstat = mutableFs as { lstatSync: (...args: any[]) => any };
  const originalLstat = mutableLstat.lstatSync;
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const bytes = evictedHistoryBytes(root);
    writeFileSync(historyPath, bytes);
    mutableLstat.lstatSync = (path: unknown, ...args: any[]) => {
      if (String(path).endsWith("history.ndjson")) {
        historySamples += 1;
        if (!injected && historySamples === 4) {
          injected = true;
          if (mode === "replace") renameSync(historyPath, displacedPath);
          writeFileSync(historyPath, bytes);
          if (mode === "rewrite") utimesSync(historyPath, new Date(0), new Date(0));
        }
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(() => listRunHistory(root, runId), (error: unknown) => error instanceof ArchiveQueryError);
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(historyPath), bytes);
    if (mode === "replace") assert.deepEqual(readFileSync(displacedPath), bytes);
  } finally {
    mutableLstat.lstatSync = originalLstat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
}

async function bundle(root: string, observationId: string, capturedAt: string) {
  const image = pngBytes();
  const metadata = Buffer.from(`${JSON.stringify({
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
    observationId,
    capturedAt,
    expiresAt: new Date(new Date(capturedAt).getTime() + 60_000).toISOString(),
    coordinateSpace: "normalized_999_top_left",
    source: { captureKind: "region", mapping: "normalized_endpoint_centers/v1", leftPx: 10, topPx: 20, widthPx: 2, heightPx: 1 },
    environmentFingerprint: "b".repeat(64),
    topologyFingerprint: "c".repeat(64),
    image: { mediaType: "image/png", sha256: sha256(image), byteLength: image.length, width: 2, height: 1 }
  })}\n`, "utf8");
  return validateCaptureBundleBytes(metadata, image, {
    runId,
    workspaceFingerprint: workspaceFingerprint(root)
  });
}

test("lists an empty admitted run without mutation and shows uniform unavailable history", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);

    assert.deepEqual(await listRunHistory(root, runId), {
      kind: "cu.history.result/v1",
      runId,
      items: []
    });
    assert.deepEqual(await showRunHistory(root, runId, absentObservation), {
      kind: "cu.history.result/v1",
      runId,
      observationId: absentObservation,
      availability: "unavailable",
      diagnosticOnly: true
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable history show does not distinguish absent causes", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const first = await showRunHistory(root, runId, absentObservation);
    const second = await showRunHistory(root, runId, "obs_00000000000000000000000000000002");
    assert.equal(JSON.stringify(first).replace(absentObservation, "OBS"), JSON.stringify(second).replace("obs_00000000000000000000000000000002", "OBS"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocked active transaction is reported by status and blocks history without repair", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
    const transaction = {
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
    };
    const bytes = Buffer.from(`${JSON.stringify(transaction)}\n`);
    writeFileSync(transactionPath, bytes);
    await assert.rejects(() => listRunHistory(root, runId), (error: unknown) => error instanceof ArchiveQueryBlockedError);
    assert.deepEqual((await inspectRunStatus(root, runId)).archive, {
      state: "recovery_required",
      retainedBundleCount: null,
      committedBytes: null,
      maxHistoricalBundles: 128,
      maxCommittedBytes: 536870912
    });
    assert.deepEqual(readFileSync(transactionPath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds history list to 641 entries with explicit ASCII ordering", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const fingerprint = workspaceFingerprint(root);
    const lines = Array.from({ length: 642 }, (_, index) => {
      const hex = index.toString(16).padStart(32, "0");
      return JSON.stringify({
        kind: "cu.history.event/v1",
        schemaVersion: 1,
        eventId: `hist_${hex}_1`,
        transactionId: `txn_${hex}`,
        at: "2026-07-25T10:00:00.000Z",
        eventType: "capture_evicted",
        runId,
        workspaceFingerprint: fingerprint,
        observationId: `obs_${hex}`,
        capturedAt: "2026-07-25T10:00:00.000Z"
      });
    });
    const historyBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    writeFileSync(join(root, ".cu", runId, "history.ndjson"), historyBytes);
    for (const lineBytes of historyBytes.toString("utf8").trimEnd().split("\n")) {
      parseHistoryEventBytes(Buffer.from(lineBytes), { runId, workspaceFingerprint: fingerprint });
    }
    const result = await listRunHistory(root, runId);
    assert.equal(result.items.length, 641);
    assert.equal(result.items[0]?.observationId, `obs_${(641).toString(16).padStart(32, "0")}`);
    assert.equal(result.items[640]?.observationId, `obs_${(1).toString(16).padStart(32, "0")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reports a transaction discovered by the closing bracket", async () => {
  const root = workspace();
  const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
  let transactionSamples = 0;
  let injected = false;
  const mutableLstat = mutableFs as { lstatSync: (...args: any[]) => any };
  const originalLstat = mutableLstat.lstatSync;
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
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
    })}\n`);
    mutableLstat.lstatSync = (path: unknown, ...args: any[]) => {
      if (String(path).endsWith("archive-transaction.json")) {
        transactionSamples += 1;
        if (!injected && transactionSamples === 2) {
          injected = true;
          writeFileSync(transactionPath, bytes);
        }
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const status = await inspectRunStatus(root, runId);
    assert.equal(injected, true);
    assert.equal(status.archive?.state, "recovery_required");
    assert.deepEqual(readFileSync(transactionPath), bytes);
  } finally {
    mutableLstat.lstatSync = originalLstat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt history fails closed without repairing its bytes", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const historyPath = join(root, ".cu", runId, "history.ndjson");
    const bytes = Buffer.from("not-history\\n", "utf8");
    writeFileSync(historyPath, bytes);
    await assert.rejects(() => listRunHistory(root, runId), (error: unknown) => error instanceof ArchiveQueryError);
    assert.deepEqual(readFileSync(historyPath), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a same-inode byte-identical history rewrite between admissions", async () => {
  await requireHistoryMutationRejection("rewrite");
});

test("rejects a byte-identical history replacement between admissions", async () => {
  await requireHistoryMutationRejection("replace");
});

test("history appearing after an absent sample is not silently omitted", async () => {
  const root = workspace();
  const historyPath = join(root, ".cu", runId, "history.ndjson");
  let injected = false;
  const mutableLstat = mutableFs as { lstatSync: (...args: any[]) => any };
  const originalLstat = mutableLstat.lstatSync;
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const replacement = Buffer.from(`${JSON.stringify({
      kind: "cu.history.event/v1",
      schemaVersion: 1,
      eventId: "hist_0123456789abcdef0123456789abcdef_1",
      transactionId: "txn_0123456789abcdef0123456789abcdef",
      at: "2026-07-25T10:00:00.000Z",
      eventType: "capture_evicted",
      runId,
      workspaceFingerprint: workspaceFingerprint(root),
      observationId: absentObservation,
      capturedAt: "2026-07-25T10:00:00.000Z"
    })}\n`, "utf8");
    mutableLstat.lstatSync = (path: unknown, ...args: any[]) => {
      try {
        return originalLstat(path, ...args);
      } catch (error) {
        if (!injected && String(path).endsWith("history.ndjson") && (error as NodeJS.ErrnoException).code === "ENOENT") {
          injected = true;
          writeFileSync(historyPath, replacement);
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    await assert.rejects(() => listRunHistory(root, runId), (error: unknown) => error instanceof ArchiveQueryError);
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(historyPath), replacement);
  } finally {
    mutableLstat.lstatSync = originalLstat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired persisted live is reported as recorded, not currently actionable authority", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const expired = await bundle(root, firstObservation, "2000-01-01T00:00:00.000Z");
    const lock = acquireRunLock(root, runId);
    try {
      await publishCaptureObservation(lock, root, runId, expired);
    } finally {
      lock.release();
    }
    assert.deepEqual((await inspectRunStatus(root, runId)).currentObservation, {
      state: "recorded_actionable"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects retained captures newest-first without private evidence", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const first = await bundle(root, firstObservation, "2026-07-25T10:00:00.000Z");
    const second = await bundle(root, secondObservation, "2026-07-25T10:02:00.000Z");
    const lock = acquireRunLock(root, runId);
    try {
      await publishCaptureObservation(lock, root, runId, first);
      await publishCaptureObservation(lock, root, runId, second);
    } finally {
      lock.release();
    }

    const listed = await listRunHistory(root, runId);
    assert.deepEqual(listed.items, [
      { observationId: secondObservation, capturedAt: "2026-07-25T10:02:00.000Z", availability: "available", diagnosticOnly: true },
      { observationId: firstObservation, capturedAt: "2026-07-25T10:00:00.000Z", availability: "available", diagnosticOnly: true }
    ]);
    const shown = await showRunHistory(root, runId, firstObservation);
    assert.deepEqual(shown, {
      kind: "cu.history.result/v1",
      runId,
      observationId: firstObservation,
      availability: "available",
      diagnosticOnly: true,
      imagePath: `.cu/${runId}/captures/${firstObservation}.png`,
      coordinateSpace: "normalized_999_top_left",
      capturedAt: "2026-07-25T10:00:00.000Z"
    });
    const status = await inspectRunStatus(root, runId);
    assert.equal(status.archive?.retainedBundleCount, 2);
    assert.equal(status.currentObservation?.state, "recorded_actionable");
    const output = JSON.stringify({ listed, shown, status });
    assert.equal(output.includes("sha256"), false);
    assert.equal(output.includes("source"), false);
    assert.equal(output.includes("@archive"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
