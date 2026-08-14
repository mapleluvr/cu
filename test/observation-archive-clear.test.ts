import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import mutableFs, { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  clearAllObservations,
  clearRangeObservations
} from "../src/archive-cleanup.js";
import {
  inspectArchiveTransaction,
  publishPreparedArchiveTransaction
} from "../src/archive-store.js";
import { listRunHistory, showRunHistory } from "../src/archive-query.js";
import {
  copyValidatedCaptureBundleBytes,
  validateCaptureBundleBytes
} from "../src/capture-bundle.js";
import { publishCaptureObservation } from "../src/observation-archive.js";
import {
  parseCaptureSidecarBytes,
  parseLiveObservationBytes
} from "../src/observation-record.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-archive-clear-"));
}

const runId = "run-a";
const observations = [
  "obs_0123456789abcdef0123456789abcdef",
  "obs_1123456789abcdef0123456789abcdef",
  "obs_2123456789abcdef0123456789abcdef"
] as const;
const injectedObservation = "obs_3123456789abcdef0123456789abcdef";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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

function pngBytes(seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, seed, 0, 0, 0, seed, 0]))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bundle(root: string, observationId: string, capturedAt: string, seed: number) {
  const image = pngBytes(seed);
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

function preparedClearBytes(root: string): Buffer {
  const runDirectory = join(root, ".cu", runId);
  const metadata = readFileSync(join(runDirectory, "captures", `${observations[0]}.json`));
  const image = readFileSync(join(runDirectory, "captures", `${observations[0]}.png`));
  const capture = parseCaptureSidecarBytes(metadata, {
    runId,
    workspaceFingerprint: workspaceFingerprint(root)
  });
  const live = parseLiveObservationBytes(
    readFileSync(join(runDirectory, "live-observation.json")),
    { runId, workspaceFingerprint: workspaceFingerprint(root) }
  );
  return Buffer.from(`${JSON.stringify({
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
    transactionId: "txn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    operation: "clear_range",
    state: "prepared",
    createdAt: "2026-07-25T11:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    priorLive: { observationId: live.observationId, liveRecordSha256: sha256(readFileSync(join(runDirectory, "live-observation.json"))) },
    movedBundles: [{ observationId: capture.observationId, captureMetadataSha256: sha256(metadata), imageSha256: sha256(image), imageByteLength: image.length }],
    historyEvents: [{ eventId: "hist_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_1", at: "2026-07-25T11:00:00.000Z", eventType: "capture_cleared", observationId: capture.observationId, capturedAt: capture.capturedAt }],
    payload: { invalidatesLive: false, selectedObservationIds: [capture.observationId] }
  })}\n`, "utf8");
}

function actionableLiveBytesFor(root: string, observationId: string): Buffer {
  const runDirectory = join(root, ".cu", runId);
  const metadataBytes = readFileSync(join(runDirectory, "captures", `${observationId}.json`));
  const capture = parseCaptureSidecarBytes(metadataBytes, {
    runId,
    workspaceFingerprint: workspaceFingerprint(root)
  });
  const retained = readFileSync(join(runDirectory, "history.ndjson"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { eventType: string; observationId?: string; transactionId: string })
    .find((event) => event.eventType === "capture_retained" && event.observationId === observationId);
  assert.notEqual(retained, undefined);
  const bytes = Buffer.from(`${JSON.stringify({
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
    observationId,
    publishedByTransactionId: retained!.transactionId,
    captureMetadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    capturedAt: capture.capturedAt,
    expiresAt: capture.expiresAt,
    state: "actionable",
    stateChangedAt: capture.capturedAt,
    coordinateSpace: capture.coordinateSpace,
    source: capture.source,
    environmentFingerprint: capture.environmentFingerprint,
    topologyFingerprint: capture.topologyFingerprint,
    image: capture.image
  })}\n`);
  parseLiveObservationBytes(bytes, {
    runId,
    workspaceFingerprint: workspaceFingerprint(root)
  });
  return bytes;
}

async function seedThree(root: string): Promise<void> {
  const lock = acquireRunLock(root, runId);
  try {
    for (let index = 0; index < observations.length; index += 1) {
      await publishCaptureObservation(
        lock,
        root,
        runId,
        await bundle(root, observations[index]!, `2026-07-25T10:0${index}:00.000Z`, 80 + index)
      );
    }
  } finally {
    lock.release();
  }
}

function snapshotRunTree(root: string): readonly string[] {
  const runDirectory = join(root, ".cu", runId);
  const result: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stat = mutableFs.lstatSync(path);
      if (stat.isDirectory()) {
        result.push(`${relative}/`);
        visit(path, relative);
      } else {
        result.push(`${relative}:${sha256(readFileSync(path))}`);
      }
    }
  };
  visit(runDirectory, "");
  return Object.freeze(result);
}

function interruptCommittedClear(root: string, operation: "range" | "clearall"): void {
  const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
  const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = root + "\\\\.cu\\\\run-a";
    const transactionPath = runDirectory + "\\\\archive-transaction.json";
    const originalLstat = fs.lstatSync.bind(fs);
    const originalRm = fs.rmSync.bind(fs);
    let injected = false;
    const committed = () => {
      try { return JSON.parse(fs.readFileSync(transactionPath, "utf8")).state === "cutover_committed"; }
      catch { return false; }
    };
    fs.lstatSync = (path, ...args) => {
      if (!injected && process.env.CU_TEST_OPERATION === "range" && committed() &&
          String(path).toLowerCase().endsWith("\\\\history.ndjson")) {
        injected = true;
        const error = new Error("range committed fault");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(path, ...args);
    };
    fs.rmSync = (path, ...args) => {
      if (!injected && process.env.CU_TEST_OPERATION === "clearall" && committed() &&
          String(path).toLowerCase().endsWith("\\\\live-observation.json")) {
        injected = true;
        const error = new Error("clearall committed fault");
        error.code = "EACCES";
        throw error;
      }
      return originalRm(path, ...args);
    };
    syncBuiltinESMExports();
    const cleanup = await import(${JSON.stringify(cleanupUrl)});
    const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
    const lock = acquireRunLock(root, "run-a");
    let errorName = null;
    try {
      if (process.env.CU_TEST_OPERATION === "range") {
        await cleanup.clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:00:00.000Z",
          timeEnd: "2026-07-25T10:01:00.000Z"
        });
      } else {
        await cleanup.clearAllObservations(lock, root, "run-a");
      }
    } catch (error) {
      errorName = error?.constructor?.name ?? "unknown";
    } finally {
      lock.release();
    }
    process.stdout.write(JSON.stringify({ injected, errorName }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: root, CU_TEST_OPERATION: operation }
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    injected: true,
    errorName: "ArchiveCleanupPublicationUncertainError"
  });
  assert.equal(inspectArchiveTransaction(root, runId)?.state, "cutover_committed");
}

async function requireLateClearAllCaptureInsertionBlocked(
  root: string,
  committedEmptyReadOrdinal: number
): Promise<void> {
  const capture = copyValidatedCaptureBundleBytes(await bundle(
    root,
    injectedObservation,
    "2026-07-25T10:03:00.000Z",
    99
  ));
  const capturesDirectory = join(root, ".cu", runId, "captures");
  const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
  const originalReaddir = mutableFs.readdirSync.bind(mutableFs);
  let committedEmptyReads = 0;
  let injected = false;
  let beforeInsertion: readonly string[] | null = null;
  try {
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = ((
      path: PathLike,
      options?: Parameters<typeof mutableFs.readdirSync>[1]
    ) => {
      const entries = originalReaddir(path, options as never);
      let committed = false;
      try {
        committed = (JSON.parse(readFileSync(transactionPath, "utf8")) as { state: string })
          .state === "cutover_committed";
      } catch {
        // The direct path has not published its transaction yet.
      }
      if (
        !injected &&
        committed &&
        String(path).toLowerCase().endsWith("\\captures") &&
        entries.length === 0
      ) {
        committedEmptyReads += 1;
        if (committedEmptyReads === committedEmptyReadOrdinal) {
          injected = true;
          beforeInsertion = snapshotRunTree(root);
          writeFileSync(join(capturesDirectory, `${injectedObservation}.json`), capture.captureMetadata);
          writeFileSync(join(capturesDirectory, `${injectedObservation}.png`), capture.image);
          return originalReaddir(path, options as never);
        }
      }
      return entries;
    }) as typeof mutableFs.readdirSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearAllObservations(lock, root, runId));
    } finally {
      lock.release();
    }
    assert.equal(injected, true);
    assert.notEqual(beforeInsertion, null);
    const metadataLine = `captures/${injectedObservation}.json:${sha256(capture.captureMetadata)}`;
    const imageLine = `captures/${injectedObservation}.png:${sha256(capture.image)}`;
    const after = snapshotRunTree(root);
    assert.equal(after.includes(metadataLine), true);
    assert.equal(after.includes(imageLine), true);
    assert.deepEqual(
      after.filter((entry) => entry !== metadataLine && entry !== imageLine),
      beforeInsertion
    );
  } finally {
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = originalReaddir;
    syncBuiltinESMExports();
  }
}

test("empty range is a held-lock no-op and clearall preserves the run skeleton", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const lock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(lock, root, runId, {
        timeEnd: "2026-07-25T10:00:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 0,
        invalidatedCurrent: false
      });
      assert.deepEqual(await clearAllObservations(lock, root, runId), {
        kind: "cu.clearall.result/v1",
        runId,
        clearedCount: 0
      });
    } finally {
      lock.release();
    }
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct clearall blocks a valid capture inserted after complete-selection proof", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    await requireLateClearAllCaptureInsertionBlocked(root, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall recovery blocks a valid capture inserted after history-present proof", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "clearall");
    await requireLateClearAllCaptureInsertionBlocked(root, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall recovery blocks a valid capture inserted after history-absent proof", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "clearall");
    rmSync(join(root, ".cu", runId, "history.ndjson"));
    await requireLateClearAllCaptureInsertionBlocked(root, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall partial forward recovery blocks a valid capture inserted after proof", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "clearall");
    const transaction = inspectArchiveTransaction(root, runId);
    assert.equal(transaction?.operation, "clear_all");
    rmSync(join(
      root,
      ".cu",
      runId,
      "@archive",
      transaction!.transactionId,
      "trash",
      `${observations[0]}.json`
    ));
    await requireLateClearAllCaptureInsertionBlocked(root, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assets-staged recovery restores exact pairs before retrying current clear", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const runDirectory = root + "\\\\.cu\\\\run-a";
      const transactionPath = runDirectory + "\\\\archive-transaction.json";
      const originalLstat = fs.lstatSync.bind(fs);
      let injected = false;
      fs.lstatSync = (path, ...args) => {
        const value = originalLstat(path, ...args);
        if (!injected && String(path).toLowerCase().endsWith("\\\\live-observation.json") && fs.existsSync(transactionPath)) {
          const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
          if (transaction.state === "assets_staged") {
            injected = true;
            const error = new Error("live admission fault");
            error.code = "EACCES";
            throw error;
          }
        }
        return value;
      };
      syncBuiltinESMExports();
      const { clearRangeObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:02:00.000Z",
          timeEnd: "2026-07-25T10:03:00.000Z"
        });
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    const transaction = JSON.parse(readFileSync(join(root, ".cu", runId, "archive-transaction.json"), "utf8")) as {
      state: string;
      transactionId: string;
    };
    assert.equal(transaction.state, "assets_staged");
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
        timeStart: "2026-07-25T10:02:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 1,
        invalidatedCurrent: true
      });
    } finally {
      retryLock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.equal((await showRunHistory(root, runId, observations[2])).availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared recovery restores moved progress before retrying", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const runDirectory = root + "\\\\.cu\\\\run-a";
      const transactionPath = runDirectory + "\\\\archive-transaction.json";
      const trash = runDirectory + "\\\\@archive";
      const originalLstat = fs.lstatSync.bind(fs);
      let injected = false;
      fs.lstatSync = (path, ...args) => {
        if (!injected && String(path).toLowerCase().endsWith("obs_1123456789abcdef0123456789abcdef.json")) {
          try {
            const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
            const trashDirectory = trash + "\\\\" + transaction.transactionId + "\\\\trash";
            if (transaction.state === "prepared" && fs.readdirSync(trashDirectory).length === 2) {
              injected = true;
              const error = new Error("prepared progress fault");
              error.code = "EACCES";
              throw error;
            }
          } catch (error) {
            if (error?.message === "prepared progress fault") throw error;
          }
        }
        return originalLstat(path, ...args);
      };
      syncBuiltinESMExports();
      const { clearRangeObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:00:00.000Z",
          timeEnd: "2026-07-25T10:02:00.000Z"
        });
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "prepared");
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:02:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 2,
        invalidatedCurrent: false
      });
    } finally {
      retryLock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assets-staged recovery preserves stable live absence", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const runDirectory = join(root, ".cu", runId);
    rmSync(join(runDirectory, "live-observation.json"));
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const transactionPath = root + "\\\\.cu\\\\run-a\\\\archive-transaction.json";
      const originalLstat = fs.lstatSync.bind(fs);
      let injected = false;
      fs.lstatSync = (path, ...args) => {
        const value = originalLstat(path, ...args);
        if (!injected && String(path).toLowerCase().endsWith("\\\\archive-transaction.json")) {
          const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
          if (transaction.state === "assets_staged") {
            injected = true;
            const error = new Error("assets state fault");
            error.code = "EACCES";
            throw error;
          }
        }
        return value;
      };
      syncBuiltinESMExports();
      const { clearRangeObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:00:00.000Z",
          timeEnd: "2026-07-25T10:01:00.000Z"
        });
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "assets_staged");
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 1,
        invalidatedCurrent: false
      });
    } finally {
      retryLock.release();
    }
    assert.throws(() => readFileSync(join(runDirectory, "live-observation.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assets-staged recovery forward-finalizes an already installed clear tombstone", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const runDirectory = root + "\\\\.cu\\\\run-a";
      const transactionPath = runDirectory + "\\\\archive-transaction.json";
      const livePath = runDirectory + "\\\\live-observation.json";
      const originalOpen = fs.openSync.bind(fs);
      let injected = false;
      fs.openSync = (path, flags, ...args) => {
        if (!injected && String(path).toLowerCase().includes("\\\\@tmp-")) {
          try {
            const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
            const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
            if (transaction.state === "assets_staged" && live.kind === "cu.live-observation-tombstone/v1") {
              injected = true;
              const error = new Error("post-tombstone state fault");
              error.code = "EACCES";
              throw error;
            }
          } catch (error) {
            if (error?.message === "post-tombstone state fault") throw error;
          }
        }
        return originalOpen(path, flags, ...args);
      };
      syncBuiltinESMExports();
      const { clearRangeObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:02:00.000Z",
          timeEnd: "2026-07-25T10:03:00.000Z"
        });
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "assets_staged");
    assert.equal(
      JSON.parse(readFileSync(join(root, ".cu", runId, "live-observation.json"), "utf8")).kind,
      "cu.live-observation-tombstone/v1"
    );
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
        timeStart: "2026-07-25T10:02:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 0,
        invalidatedCurrent: false
      });
    } finally {
      retryLock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.equal((await showRunHistory(root, runId, observations[2])).availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward recovery finalizes a clear cutover after history append fails", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const runDirectory = root + "\\\\.cu\\\\run-a";
      const historyPath = runDirectory + "\\\\history.ndjson";
      const transactionPath = runDirectory + "\\\\archive-transaction.json";
      const originalLstat = fs.lstatSync.bind(fs);
      let injected = false;
      fs.lstatSync = (path, ...args) => {
        const value = originalLstat(path, ...args);
        if (!injected && String(path).toLowerCase().endsWith("\\\\history.ndjson") && fs.existsSync(transactionPath)) {
          const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
          if (transaction.state === "cutover_committed") {
            injected = true;
            const error = new Error("history fault");
            error.code = "EACCES";
            throw error;
          }
        }
        return value;
      };
      syncBuiltinESMExports();
      const { clearRangeObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearRangeObservations(lock, root, "run-a", {
          timeStart: "2026-07-25T10:00:00.000Z",
          timeEnd: "2026-07-25T10:02:00.000Z"
        });
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    const outcome = JSON.parse(child.stdout) as { injected: boolean; errorName: string | null };
    assert.deepEqual(outcome, {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    const transaction = JSON.parse(readFileSync(join(root, ".cu", runId, "archive-transaction.json"), "utf8")) as {
      state: string;
      transactionId: string;
      runId: string;
      workspaceFingerprint: string;
      historyEvents: Array<Record<string, unknown>>;
    };
    assert.equal(transaction.state, "cutover_committed");
    assert.equal(transaction.historyEvents.length, 2);
    assert.deepEqual(readdirSync(join(root, ".cu", runId, "@archive")), [transaction.transactionId]);
    const recoveryLines = transaction.historyEvents.map((event) => Buffer.from(`${JSON.stringify({
      kind: "cu.history.event/v1",
      schemaVersion: 1,
      ...event,
      transactionId: transaction.transactionId,
      runId: transaction.runId,
      workspaceFingerprint: transaction.workspaceFingerprint
    })}\n`));
    appendFileSync(
      join(root, ".cu", runId, "history.ndjson"),
      Buffer.concat([recoveryLines[0]!, recoveryLines[1]!.subarray(0, 19)])
    );
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:02:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 0,
        invalidatedCurrent: false
      });
    } finally {
      retryLock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.equal((await showRunHistory(root, runId, observations[0])).availability, "unavailable");
    assert.equal((await showRunHistory(root, runId, observations[1])).availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward recovery resumes partial private and record cleanup for range and clearall", async () => {
  for (const operation of ["range", "clearall"] as const) {
    for (const faultMode of ["trash_file", "private_directory", "active_record"] as const) {
      const root = workspace();
      try {
        initializeWorkspace(root);
        ensureRun(root, runId);
        await seedThree(root);
        const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
        const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
        const program = `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
          const transactionPath = root + "\\\\.cu\\\\run-a\\\\archive-transaction.json";
          const mode = process.env.CU_TEST_FAULT_MODE;
          const operation = process.env.CU_TEST_OPERATION;
          const originalRm = fs.rmSync.bind(fs);
          const originalRmdir = fs.rmdirSync.bind(fs);
          let injected = false;
          const committed = () => {
            try { return JSON.parse(fs.readFileSync(transactionPath, "utf8")).state === "cutover_committed"; }
            catch { return false; }
          };
          fs.rmSync = (path, ...args) => {
            const text = String(path).toLowerCase();
            const trashFile = text.includes("\\\\@archive\\\\") && text.includes("\\\\trash\\\\");
            const activeRecord = text.endsWith("\\\\archive-transaction.json");
            if (!injected && committed() &&
                ((mode === "trash_file" && trashFile) || (mode === "active_record" && activeRecord))) {
              const result = originalRm(path, ...args);
              injected = true;
              const error = new Error(mode + " fault");
              error.code = "EACCES";
              throw error;
            }
            return originalRm(path, ...args);
          };
          fs.rmdirSync = (path, ...args) => {
            const result = originalRmdir(path, ...args);
            if (!injected && committed() && mode === "private_directory" &&
                String(path).toLowerCase().endsWith("\\\\staging")) {
              injected = true;
              const error = new Error("private directory fault");
              error.code = "EACCES";
              throw error;
            }
            return result;
          };
          syncBuiltinESMExports();
          const cleanup = await import(${JSON.stringify(cleanupUrl)});
          const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
          const lock = acquireRunLock(root, "run-a");
          let errorName = null;
          try {
            if (operation === "range") {
              await cleanup.clearRangeObservations(lock, root, "run-a", {
                timeStart: "2026-07-25T10:00:00.000Z",
                timeEnd: "2026-07-25T10:02:00.000Z"
              });
            } else {
              await cleanup.clearAllObservations(lock, root, "run-a");
            }
          } catch (error) {
            errorName = error?.constructor?.name ?? "unknown";
          } finally {
            lock.release();
          }
          process.stdout.write(JSON.stringify({ injected, errorName }));
        `;
        const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
          encoding: "utf8",
          env: {
            ...process.env,
            CU_TEST_WORKSPACE: root,
            CU_TEST_FAULT_MODE: faultMode,
            CU_TEST_OPERATION: operation
          }
        });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), {
          injected: true,
          errorName: "ArchiveCleanupPublicationUncertainError"
        });
        const retryLock = acquireRunLock(root, runId);
        try {
          if (operation === "range") {
            assert.deepEqual(await clearRangeObservations(retryLock, root, runId, {
              timeStart: "2026-07-25T10:00:00.000Z",
              timeEnd: "2026-07-25T10:02:00.000Z"
            }), {
              kind: "cu.clear.result/v1",
              runId,
              clearedCount: 0,
              invalidatedCurrent: false
            });
          } else {
            assert.deepEqual(await clearAllObservations(retryLock, root, runId), {
              kind: "cu.clearall.result/v1",
              runId,
              clearedCount: 0
            });
          }
        } finally {
          retryLock.release();
        }
        assert.equal(inspectArchiveTransaction(root, runId), undefined);
        if (operation === "range") {
          const history = readFileSync(join(root, ".cu", runId, "history.ndjson"), "utf8");
          for (const observationId of observations.slice(0, 2)) {
            assert.equal(
              history.split("\n").filter((line) => line.includes(observationId) && line.includes("capture_cleared")).length,
              1
            );
          }
        } else {
          assert.deepEqual(readdirSync(join(root, ".cu", runId)).sort(), ["run.json"]);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("clearall forward recovery finalizes after private-proof admission fails", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const runDirectory = root + "\\\\.cu\\\\run-a";
      const transactionPath = runDirectory + "\\\\archive-transaction.json";
      const originalLstat = fs.lstatSync.bind(fs);
      let injected = false;
      fs.lstatSync = (path, ...args) => {
        const value = originalLstat(path, ...args);
        if (!injected && String(path).toLowerCase().endsWith("\\\\trash") && fs.existsSync(transactionPath)) {
          const transaction = JSON.parse(fs.readFileSync(transactionPath, "utf8"));
          if (transaction.state === "cutover_committed") {
            injected = true;
            const error = new Error("private proof fault");
            error.code = "EACCES";
            throw error;
          }
        }
        return value;
      };
      syncBuiltinESMExports();
      const { clearAllObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearAllObservations(lock, root, "run-a");
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    const transaction = JSON.parse(readFileSync(join(root, ".cu", runId, "archive-transaction.json"), "utf8")) as {
      state: string;
      transactionId: string;
    };
    assert.equal(transaction.state, "cutover_committed");
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearAllObservations(retryLock, root, runId), {
        kind: "cu.clearall.result/v1",
        runId,
        clearedCount: 0
      });
    } finally {
      retryLock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall persists cutover before deleting live or history", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const cleanupUrl = pathToFileURL(join(process.cwd(), "dist", "src", "archive-cleanup.js")).href;
    const lockUrl = pathToFileURL(join(process.cwd(), "dist", "src", "run-lock.js")).href;
    const program = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const root = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
      const livePath = root + "\\\\.cu\\\\run-a\\\\live-observation.json";
      const originalRm = fs.rmSync.bind(fs);
      let injected = false;
      fs.rmSync = (path, ...args) => {
        if (!injected && String(path).toLowerCase() === livePath.toLowerCase()) {
          injected = true;
          const error = new Error("live delete fault");
          error.code = "EACCES";
          throw error;
        }
        return originalRm(path, ...args);
      };
      syncBuiltinESMExports();
      const { clearAllObservations } = await import(${JSON.stringify(cleanupUrl)});
      const { acquireRunLock } = await import(${JSON.stringify(lockUrl)});
      const lock = acquireRunLock(root, "run-a");
      let errorName = null;
      try {
        await clearAllObservations(lock, root, "run-a");
      } catch (error) {
        errorName = error?.constructor?.name ?? "unknown";
      } finally {
        lock.release();
      }
      process.stdout.write(JSON.stringify({ injected, errorName }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, CU_TEST_WORKSPACE: root }
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      injected: true,
      errorName: "ArchiveCleanupPublicationUncertainError"
    });
    const runDirectory = join(root, ".cu", runId);
    const transaction = JSON.parse(readFileSync(join(runDirectory, "archive-transaction.json"), "utf8")) as {
      state: string;
    };
    assert.equal(transaction.state, "cutover_committed");
    assert.doesNotThrow(() => readFileSync(join(runDirectory, "live-observation.json")));
    assert.doesNotThrow(() => readFileSync(join(runDirectory, "history.ndjson")));
    const retryLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearAllObservations(retryLock, root, runId), {
        kind: "cu.clearall.result/v1",
        runId,
        clearedCount: 0
      });
    } finally {
      retryLock.release();
    }
    assert.deepEqual(readdirSync(runDirectory), ["run.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared clear with unknown private evidence remains blocked and byte-preserved", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const lock = acquireRunLock(root, runId);
    try {
      publishPreparedArchiveTransaction(lock, root, runId, preparedClearBytes(root));
      const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
      const before = readFileSync(transactionPath);
      mkdirSync(join(root, ".cu", runId, "@archive", "unknown"), { recursive: true });
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }));
      assert.deepEqual(readFileSync(transactionPath), before);
      assert.equal(readdirSync(join(root, ".cu", runId, "captures")).length, 6);
      assert.deepEqual(readdirSync(join(root, ".cu", runId, "@archive")), ["unknown"]);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untouched prepared clear rolls back before a later clear proceeds", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const lock = acquireRunLock(root, runId);
    try {
      publishPreparedArchiveTransaction(lock, root, runId, preparedClearBytes(root));
      assert.equal(inspectArchiveTransaction(root, runId)?.state, "prepared");
      assert.deepEqual(await clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 1,
        invalidatedCurrent: false
      });
    } finally {
      lock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.equal((await showRunHistory(root, runId, observations[0])).availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear range requires canonical UTC half-open bounds before workspace effects", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:00:00.000Z"
      }));
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:01:00.000Z",
        timeEnd: "2026-07-25T10:00:00.000Z"
      }));
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeEnd: "2026-07-25T10:00:00Z"
      }));
    } finally {
      lock.release();
    }
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an effect journal blocks clear before archive mutation", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const runDirectory = join(root, ".cu", runId);
    const before = readdirSync(runDirectory).sort();
    const beforeCaptures = readdirSync(join(runDirectory, "captures")).sort();
    writeFileSync(join(runDirectory, "effect-journal.json"), Buffer.from('{"malformed":true}\n'));
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeEnd: "2026-07-25T10:03:00.000Z"
      }));
      await assert.rejects(clearAllObservations(lock, root, runId));
    } finally {
      lock.release();
    }
    assert.deepEqual(readdirSync(runDirectory).sort(), [...before, "effect-journal.json"].sort());
    assert.deepEqual(readdirSync(join(runDirectory, "captures")).sort(), beforeCaptures);
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    rmSync(join(runDirectory, "effect-journal.json"));
    const activeLock = acquireRunLock(root, runId);
    try {
      publishPreparedArchiveTransaction(activeLock, root, runId, preparedClearBytes(root));
      const transactionPath = join(runDirectory, "archive-transaction.json");
      const transactionBytes = readFileSync(transactionPath);
      writeFileSync(join(runDirectory, "effect-journal.json"), Buffer.from('{"malformed":true}\n'));
      await assert.rejects(clearRangeObservations(activeLock, root, runId, {
        timeEnd: "2026-07-25T10:01:00.000Z"
      }));
      assert.deepEqual(readFileSync(transactionPath), transactionBytes);
      assert.deepEqual(readdirSync(join(runDirectory, "captures")).sort(), beforeCaptures);
    } finally {
      activeLock.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall removes a final cleared tombstone and its diagnostic history", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const clearLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(clearLock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 3,
        invalidatedCurrent: true
      });
    } finally {
      clearLock.release();
    }
    const allLock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearAllObservations(allLock, root, runId), {
        kind: "cu.clearall.result/v1",
        runId,
        clearedCount: 0
      });
    } finally {
      allLock.release();
    }
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall removes every bundle, live, and history while preserving run.json", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const lock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearAllObservations(lock, root, runId), {
        kind: "cu.clearall.result/v1",
        runId,
        clearedCount: 3
      });
    } finally {
      lock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
    assert.equal(readFileSync(join(root, ".cu", runId, "run.json")).length > 0, true);
    assert.throws(() => readFileSync(join(root, ".cu", runId, "live-observation.json")));
    assert.throws(() => readFileSync(join(root, ".cu", runId, "history.ndjson")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear range removes historical bundles while stable live remains absent", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    rmSync(join(root, ".cu", runId, "live-observation.json"));
    const lock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 1,
        invalidatedCurrent: false
      });
    } finally {
      lock.release();
    }
    assert.throws(() => readFileSync(join(root, ".cu", runId, "live-observation.json")));
    assert.equal((await showRunHistory(root, runId, observations[0])).availability, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearall admits the exact committed transaction before deleting live or history", async () => {
  const root = workspace();
  const originalOpen = mutableFs.openSync.bind(mutableFs);
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const runDirectory = join(root, ".cu", runId);
    const transactionPath = join(runDirectory, "archive-transaction.json");
    const liveBefore = readFileSync(join(runDirectory, "live-observation.json"));
    const historyBefore = readFileSync(join(runDirectory, "history.ndjson"));
    let injected = false;
    (mutableFs as unknown as { openSync: typeof mutableFs.openSync }).openSync = ((
      path: PathLike,
      flags: Parameters<typeof mutableFs.openSync>[1],
      mode?: number
    ) => {
      if (!injected && String(path).toLowerCase().endsWith("\\archive-transaction.json")) {
        try {
          const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as { state: string };
          if (transaction.state === "cutover_committed") {
            injected = true;
            const replacement = `${transactionPath}.replacement`;
            writeFileSync(replacement, readFileSync(transactionPath));
            rmSync(transactionPath);
            mutableFs.renameSync(replacement, transactionPath);
          }
        } catch {
          // The transaction may not exist during earlier staging probes.
        }
      }
      return originalOpen(path, flags, mode);
    }) as typeof mutableFs.openSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearAllObservations(lock, root, runId));
    } finally {
      lock.release();
    }
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(join(runDirectory, "live-observation.json")), liveBefore);
    assert.deepEqual(readFileSync(join(runDirectory, "history.ndjson")), historyBefore);
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "cutover_committed");
  } finally {
    (mutableFs as unknown as { openSync: typeof mutableFs.openSync }).openSync = originalOpen;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct clear refuses a byte-identical committed transaction replacement before finalization", async () => {
  const root = workspace();
  const originalReaddir = mutableFs.readdirSync.bind(mutableFs);
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
    let injected = false;
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = ((
      path: PathLike,
      options?: Parameters<typeof mutableFs.readdirSync>[1]
    ) => {
      const entries = originalReaddir(path, options as never);
      if (!injected && String(path).toLowerCase().endsWith("\\trash")) {
        const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as { state: string };
        if (transaction.state === "cutover_committed") {
          injected = true;
          const bytes = readFileSync(transactionPath);
          const replacement = `${transactionPath}.replacement`;
          writeFileSync(replacement, bytes);
          rmSync(transactionPath);
          mutableFs.renameSync(replacement, transactionPath);
        }
      }
      return entries;
    }) as typeof mutableFs.readdirSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }));
    } finally {
      lock.release();
    }
    assert.equal(injected, true);
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "cutover_committed");
    assert.equal(
      readFileSync(join(root, ".cu", runId, "history.ndjson"), "utf8").includes("capture_cleared"),
      false
    );
  } finally {
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = originalReaddir;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear recovery refuses a same-inode committed transaction rewrite before finalization", async () => {
  const root = workspace();
  const originalReaddir = mutableFs.readdirSync.bind(mutableFs);
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "range");
    const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
    const before = snapshotRunTree(root);
    let injected = false;
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = ((
      path: PathLike,
      options?: Parameters<typeof mutableFs.readdirSync>[1]
    ) => {
      const entries = originalReaddir(path, options as never);
      if (!injected && String(path).toLowerCase().endsWith("\\trash")) {
        injected = true;
        writeFileSync(transactionPath, readFileSync(transactionPath));
      }
      return entries;
    }) as typeof mutableFs.readdirSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }));
    } finally {
      lock.release();
    }
    assert.equal(injected, true);
    assert.deepEqual(snapshotRunTree(root), before);
  } finally {
    (mutableFs as unknown as { readdirSync: typeof mutableFs.readdirSync }).readdirSync = originalReaddir;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery refuses a parse-valid range transaction whose event names an unselected observation", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "range");
    const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
    const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as {
      historyEvents: Array<{ observationId: string }>;
    };
    transaction.historyEvents[0]!.observationId = observations[1];
    writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
    const before = snapshotRunTree(root);
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:01:00.000Z"
      }));
    } finally {
      lock.release();
    }
    assert.deepEqual(snapshotRunTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery refuses a parse-valid clearall subset while history is already absent", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "clearall");
    const runDirectory = join(root, ".cu", runId);
    const transactionPath = join(runDirectory, "archive-transaction.json");
    const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as {
      transactionId: string;
      movedBundles: Array<{ observationId: string }>;
      payload: { selectedObservationIds: string[] };
    };
    transaction.movedBundles = transaction.movedBundles.filter((descriptor) =>
      descriptor.observationId !== observations[2]
    );
    transaction.payload.selectedObservationIds = transaction.payload.selectedObservationIds.filter((id) =>
      id !== observations[2]
    );
    const trashDirectory = join(runDirectory, "@archive", transaction.transactionId, "trash");
    const capturesDirectory = join(runDirectory, "captures");
    for (const extension of ["json", "png"] as const) {
      mutableFs.renameSync(
        join(trashDirectory, `${observations[2]}.${extension}`),
        join(capturesDirectory, `${observations[2]}.${extension}`)
      );
    }
    rmSync(join(runDirectory, "history.ndjson"));
    writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
    const admitted = inspectArchiveTransaction(root, runId);
    assert.equal(admitted?.operation, "clear_all");
    assert.equal(admitted?.state, "cutover_committed");
    if (admitted?.operation !== "clear_all") assert.fail("fixture transaction was not admitted");
    assert.deepEqual(
      admitted.movedBundles.map((descriptor) => descriptor.observationId),
      admitted.payload.selectedObservationIds
    );
    assert.equal(admitted.movedBundles.length, 2);
    const before = snapshotRunTree(root);
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearAllObservations(lock, root, runId));
    } finally {
      lock.release();
    }
    assert.deepEqual(snapshotRunTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery refuses a parse-valid clearall subset while an unlisted bundle remains", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    interruptCommittedClear(root, "clearall");
    const runDirectory = join(root, ".cu", runId);
    const transactionPath = join(runDirectory, "archive-transaction.json");
    const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as {
      transactionId: string;
      movedBundles: Array<{ observationId: string }>;
      payload: { selectedObservationIds: string[] };
    };
    transaction.movedBundles = transaction.movedBundles.filter((descriptor) =>
      descriptor.observationId !== observations[2]
    );
    transaction.payload.selectedObservationIds = transaction.payload.selectedObservationIds.filter((id) =>
      id !== observations[2]
    );
    const trashDirectory = join(runDirectory, "@archive", transaction.transactionId, "trash");
    const capturesDirectory = join(runDirectory, "captures");
    for (const extension of ["json", "png"] as const) {
      mutableFs.renameSync(
        join(trashDirectory, `${observations[2]}.${extension}`),
        join(capturesDirectory, `${observations[2]}.${extension}`)
      );
    }
    writeFileSync(transactionPath, `${JSON.stringify(transaction)}\n`);
    const admitted = inspectArchiveTransaction(root, runId);
    assert.equal(admitted?.operation, "clear_all");
    if (admitted?.operation !== "clear_all") assert.fail("fixture transaction was not admitted");
    assert.deepEqual(
      admitted.movedBundles.map((descriptor) => descriptor.observationId),
      admitted.payload.selectedObservationIds
    );
    const before = snapshotRunTree(root);
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearAllObservations(lock, root, runId));
    } finally {
      lock.release();
    }
    assert.deepEqual(snapshotRunTree(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live-selected clear refuses a different valid predecessor before tombstone cutover", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const runDirectory = join(root, ".cu", runId);
    const livePath = join(runDirectory, "live-observation.json");
    const replacementBytes = actionableLiveBytesFor(root, observations[1]);
    const historyBefore = readFileSync(join(runDirectory, "history.ndjson"));
    const fsHooks = mutableFs as unknown as { lstatSync: typeof mutableFs.lstatSync };
    const originalLstat = fsHooks.lstatSync;
    let injected = false;
    fsHooks.lstatSync = ((path: PathLike, options?: unknown) => {
      if (
        !injected &&
        String(path).toLowerCase().endsWith("\\live-observation.json") &&
        (() => {
          try {
            const transaction = JSON.parse(readFileSync(join(runDirectory, "archive-transaction.json"), "utf8")) as {
              state: string;
            };
            return transaction.state === "assets_staged";
          } catch {
            return false;
          }
        })()
      ) {
        injected = true;
        const replacementPath = join(runDirectory, "@live-replacement.json");
        writeFileSync(replacementPath, replacementBytes);
        mutableFs.renameSync(replacementPath, livePath);
      }
      return originalLstat(path, options as never);
    }) as typeof mutableFs.lstatSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:02:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }));
    } finally {
      fsHooks.lstatSync = originalLstat;
      syncBuiltinESMExports();
      lock.release();
    }
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(livePath), replacementBytes);
    assert.deepEqual(readFileSync(join(runDirectory, "history.ndjson")), historyBefore);
    assert.equal(inspectArchiveTransaction(root, runId)?.state, "assets_staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live-selected clear proves the installed tombstone before history or trash cleanup", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const runDirectory = join(root, ".cu", runId);
    const livePath = join(runDirectory, "live-observation.json");
    const historyBefore = readFileSync(join(runDirectory, "history.ndjson"));
    const fsHooks = mutableFs as unknown as { lstatSync: typeof mutableFs.lstatSync };
    const originalLstat = fsHooks.lstatSync;
    let injected = false;
    fsHooks.lstatSync = ((path: PathLike, options?: unknown) => {
      if (
        !injected &&
        String(path).toLowerCase().endsWith("\\live-observation.json") &&
        (() => {
          try {
            const transaction = JSON.parse(readFileSync(join(runDirectory, "archive-transaction.json"), "utf8")) as {
              state: string;
            };
            return transaction.state === "cutover_committed";
          } catch {
            return false;
          }
        })()
      ) {
        injected = true;
        rmSync(livePath);
      }
      return originalLstat(path, options as never);
    }) as typeof mutableFs.lstatSync;
    syncBuiltinESMExports();
    const lock = acquireRunLock(root, runId);
    try {
      await assert.rejects(clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:02:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }));
    } finally {
      fsHooks.lstatSync = originalLstat;
      syncBuiltinESMExports();
      lock.release();
    }
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(join(runDirectory, "history.ndjson")), historyBefore);
    const transaction = inspectArchiveTransaction(root, runId);
    assert.equal(transaction?.state, "cutover_committed");
    assert.deepEqual(readdirSync(join(runDirectory, "@archive")), [transaction!.transactionId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear range selecting current installs a cleared tombstone and retains non-selected bundles", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const lock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:02:00.000Z",
        timeEnd: "2026-07-25T10:03:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 1,
        invalidatedCurrent: true
      });
    } finally {
      lock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.deepEqual(readdirSync(join(root, ".cu", runId, "captures")), [
      `${observations[0]}.json`,
      `${observations[0]}.png`,
      `${observations[1]}.json`,
      `${observations[1]}.png`
    ]);
    const live = parseLiveObservationBytes(
      readFileSync(join(root, ".cu", runId, "live-observation.json")),
      { runId, workspaceFingerprint: workspaceFingerprint(root) }
    );
    assert.equal(live.kind, "cu.live-observation-tombstone/v1");
    if (live.kind !== "cu.live-observation-tombstone/v1") throw new Error("expected tombstone");
    assert.equal(live.observationId, observations[2]);
    assert.equal(live.invalidatedReason, "cleared");
    assert.match(live.invalidatedByTransactionId!, /^txn_[a-f0-9]{32}$/);
    assert.equal((await showRunHistory(root, runId, observations[2])).availability, "unavailable");
    assert.deepEqual(readdirSync(join(root, ".cu", runId, "@archive")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear range uses an exact half-open window and retains a non-selected current observation", async () => {
  const root = workspace();
  try {
    initializeWorkspace(root);
    ensureRun(root, runId);
    await seedThree(root);
    const lock = acquireRunLock(root, runId);
    try {
      assert.deepEqual(await clearRangeObservations(lock, root, runId, {
        timeStart: "2026-07-25T10:00:00.000Z",
        timeEnd: "2026-07-25T10:02:00.000Z"
      }), {
        kind: "cu.clear.result/v1",
        runId,
        clearedCount: 2,
        invalidatedCurrent: false
      });
    } finally {
      lock.release();
    }
    assert.equal(inspectArchiveTransaction(root, runId), undefined);
    assert.deepEqual(readdirSync(join(root, ".cu", runId, "captures")), [
      `${observations[2]}.json`,
      `${observations[2]}.png`
    ]);
    const history = await listRunHistory(root, runId);
    assert.deepEqual(history.items.map(({ observationId, availability }) => ({ observationId, availability })), [
      { observationId: observations[2], availability: "available" },
      { observationId: observations[1], availability: "unavailable" },
      { observationId: observations[0], availability: "unavailable" }
    ]);
    assert.deepEqual(await showRunHistory(root, runId, observations[0]), {
      kind: "cu.history.result/v1",
      runId,
      observationId: observations[0],
      availability: "unavailable",
      diagnosticOnly: true
    });
    const live = parseLiveObservationBytes(
      readFileSync(join(root, ".cu", runId, "live-observation.json")),
      { runId, workspaceFingerprint: workspaceFingerprint(root) }
    );
    assert.equal(live.kind, "cu.live-observation/v1");
    assert.equal(live.observationId, observations[2]);
    assert.deepEqual(readdirSync(join(root, ".cu", runId, "@archive")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
