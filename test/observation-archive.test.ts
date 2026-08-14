import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { publishPreparedArchiveTransaction } from "../src/archive-store.js";
import type { ValidatedCaptureBundle } from "../src/capture-bundle.js";
import {
  parseArchiveTransactionBytes,
  type ArchiveBundle,
  type ArchiveHistoryEvent
} from "../src/archive-transaction.js";
import { parseHistoryEventBytes } from "../src/history-event.js";
import { parseLiveObservationBytes } from "../src/observation-record.js";
import {
  ObservationArchiveError,
  ObservationArchivePublicationUncertainError,
  ObservationArchiveQuotaError,
  planObservationRetention,
  publishCaptureObservation,
  recoverObservationArchive
} from "../src/observation-archive.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";

const mutableFs = createRequire(import.meta.url)("node:fs") as {
  fsyncSync: typeof import("node:fs").fsyncSync;
  mkdirSync: typeof import("node:fs").mkdirSync;
  renameSync: typeof import("node:fs").renameSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
};

const runId = "work-a";
const observationId = "obs_0123456789abcdef0123456789abcdef";
const secondObservationId = "obs_1123456789abcdef0123456789abcdef";
const transactionId = "txn_0123456789abcdef0123456789abcdef";
const secondTransactionId = "txn_1123456789abcdef0123456789abcdef";
const historyEventId = "hist_0123456789abcdef0123456789abcdef_1";
const secondHistoryEventId = "hist_1123456789abcdef0123456789abcdef_1";
const capturedAt = "2026-07-25T10:00:00.000Z";
const secondCapturedAt = "2026-07-25T10:02:00.000Z";

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
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 255, 0]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureMetadata(workspace: string, image: Buffer, id = observationId, at = capturedAt): Buffer {
  return Buffer.from(`${JSON.stringify({
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace),
    observationId: id,
    capturedAt: at,
    expiresAt: new Date(new Date(at).getTime() + 60_000).toISOString(),
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
}

async function prepareBundle(workspace: string, id = observationId, at = capturedAt) {
  const image = pngBytes();
  const metadata = captureMetadata(workspace, image, id, at);
  const bundle = await validateCaptureBundleBytes(metadata, image, {
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace)
  });
  return { image, metadata, bundle };
}

async function observationArchiveError(
  operation: () => unknown | Promise<unknown>
): Promise<ObservationArchiveError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ObservationArchiveError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected ObservationArchiveError");
}

function descriptorFor(bundle: ValidatedCaptureBundle): ArchiveBundle {
  return {
    observationId: bundle.capture.observationId,
    captureMetadataSha256: bundle.captureMetadataSha256,
    imageSha256: bundle.capture.image.sha256,
    imageByteLength: bundle.capture.image.byteLength
  };
}

function publishTransactionBytes(
  workspace: string,
  bundle: ValidatedCaptureBundle,
  options: {
    transactionId?: string;
    state?: "prepared" | "assets_staged" | "cutover_committed";
    liveRecordSha256?: string;
    priorLive?: null | { observationId: string; liveRecordSha256: string };
    movedBundles?: ArchiveBundle[];
    historyEvents?: ArchiveHistoryEvent[];
    replacesObservationId?: string | null;
  } = {}
): Buffer {
  return Buffer.from(`${JSON.stringify({
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace),
    transactionId: options.transactionId ?? transactionId,
    operation: "publish",
    state: options.state ?? "prepared",
    createdAt: "2026-07-25T10:00:05.000Z",
    updatedAt: "2026-07-25T10:00:05.000Z",
    priorLive: options.priorLive ?? null,
    movedBundles: options.movedBundles ?? [],
    historyEvents: options.historyEvents ?? [{
      eventId: historyEventId,
      at: "2026-07-25T10:00:05.000Z",
      eventType: "capture_retained",
      observationId: bundle.capture.observationId,
      capturedAt: bundle.capture.capturedAt
    }],
    payload: {
      newBundle: descriptorFor(bundle),
      newLiveRecordSha256: options.liveRecordSha256 ?? "d".repeat(64),
      replacesObservationId: options.replacesObservationId ?? null,
      resolvesEffect: null
    }
  })}\n`, "utf8");
}

function historyLineBytes(
  workspace: string,
  activeTransactionId: string,
  event: ArchiveHistoryEvent
): Buffer {
  return Buffer.from(`${JSON.stringify({
    kind: "cu.history.event/v1",
    schemaVersion: 1,
    ...event,
    transactionId: activeTransactionId,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace)
  })}\n`, "utf8");
}

function activePreparedBytes(
  workspace: string,
  bundle: ValidatedCaptureBundle,
  state: "prepared" | "assets_staged" = "prepared",
  liveRecordSha256 = "d".repeat(64)
): Buffer {
  return publishTransactionBytes(workspace, bundle, { state, liveRecordSha256 });
}

test("quota planner evicts oldest eligible history and protects current evidence", () => {
  const entries = [
    {
      observationId: "obs_00000000000000000000000000000001",
      capturedAt: "2026-07-25T09:00:00.000Z",
      committedBytes: 300
    },
    {
      observationId: "obs_00000000000000000000000000000002",
      capturedAt: "2026-07-25T09:00:00.000Z",
      committedBytes: 200
    },
    {
      observationId: "obs_00000000000000000000000000000003",
      capturedAt: "2026-07-25T11:00:00.000Z",
      committedBytes: 536_869_800
    }
  ];

  const plan = planObservationRetention(entries, entries[2]!.observationId, 1_000, {
    maxHistoricalBundles: 2,
    maxCommittedBytes: 536_870_912
  });

  assert.deepEqual(plan.evictedObservationIds, [entries[0]!.observationId, entries[1]!.observationId]);
  assert.equal(plan.evictedHistoryCount, 2);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.evictedObservationIds), true);
});

test("quota planner fails when only protected current evidence could make room", () => {
  assert.throws(
    () => planObservationRetention([
      {
        observationId,
        capturedAt,
        committedBytes: 536_870_000
      }
    ], observationId, 1_000, {
      maxHistoricalBundles: 128,
      maxCommittedBytes: 536_870_912
    }),
    (error: unknown) => error instanceof ObservationArchiveQuotaError && error.message === ""
  );
});

test("retained archive inspection rejects digest-matching non-PNG bytes before publication", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-invalid-retained-png-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const runDirectory = join(workspace, ".cu", runId);
    const capturesDirectory = join(runDirectory, "captures");
    mkdirSync(capturesDirectory);
    const invalidImage = Buffer.from("not a PNG", "utf8");
    const invalidMetadata = captureMetadata(workspace, invalidImage);
    const invalidMetadataPath = join(capturesDirectory, `${observationId}.json`);
    const invalidImagePath = join(capturesDirectory, `${observationId}.png`);
    writeFileSync(invalidMetadataPath, invalidMetadata);
    writeFileSync(invalidImagePath, invalidImage);
    const next = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      const error = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        next.bundle
      ));
      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(invalidMetadataPath), invalidMetadata);
      assert.deepEqual(readFileSync(invalidImagePath), invalidImage);
      assert.deepEqual(readdirSync(capturesDirectory).sort(), [
        `${observationId}.json`,
        `${observationId}.png`
      ]);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
      assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("retained sidecar mutation during PNG admission fails the terminal witness sweep", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-retained-change-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const retained = await prepareBundle(workspace);
    const next = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const runDirectory = join(workspace, ".cu", runId);
    const capturesDirectory = join(runDirectory, "captures");
    mkdirSync(capturesDirectory);
    const metadataPath = join(capturesDirectory, `${observationId}.json`);
    const imagePath = join(capturesDirectory, `${observationId}.png`);
    writeFileSync(metadataPath, retained.metadata);
    writeFileSync(imagePath, retained.image);
    const alteredRecord = JSON.parse(retained.metadata.toString("utf8")) as Record<string, unknown>;
    alteredRecord.environmentFingerprint = "d".repeat(64);
    const alteredMetadata = Buffer.from(`${JSON.stringify(alteredRecord)}\n`, "utf8");
    assert.equal(alteredMetadata.length, retained.metadata.length);
    const lock = acquireRunLock(workspace, runId);
    let injected = false;
    try {
      setImmediate(() => {
        injected = true;
        writeFileSync(metadataPath, alteredMetadata);
      });
      const error = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        next.bundle
      ));
      assert.equal(error.message, "");
      assert.equal(injected, true);
      assert.deepEqual(readFileSync(metadataPath), alteredMetadata);
      assert.deepEqual(readFileSync(imagePath), retained.image);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
      assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("publishes one capture bundle into immutable captures, live, and history", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    try {
      const { image, metadata, bundle } = await prepareBundle(workspace);
      const result = await publishCaptureObservation(lock, workspace, runId, bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });

      const runDirectory = join(workspace, ".cu", runId);
      const capturesDirectory = join(runDirectory, "captures");
      const capturePng = join(capturesDirectory, `${observationId}.png`);
      const captureJson = join(capturesDirectory, `${observationId}.json`);
      const livePath = join(runDirectory, "live-observation.json");
      const historyPath = join(runDirectory, "history.ndjson");

      assert.equal(result.observationId, observationId);
      assert.equal(result.transactionId, transactionId);
      assert.deepEqual(readdirSync(capturesDirectory).sort(), [
        `${observationId}.json`,
        `${observationId}.png`
      ]);
      assert.deepEqual(readFileSync(capturePng), image);
      assert.deepEqual(readFileSync(captureJson), metadata);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "@archive", transactionId)), false);

      const liveBytes = readFileSync(livePath);
      const live = parseLiveObservationBytes(liveBytes, {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(live.kind, "cu.live-observation/v1");
      if (live.kind !== "cu.live-observation/v1") assert.fail("expected live observation");
      assert.equal(live.observationId, observationId);
      assert.equal(live.publishedByTransactionId, transactionId);
      assert.equal(live.captureMetadataSha256, sha256(metadata));
      assert.equal(live.state, "actionable");
      assert.equal(live.stateChangedAt, capturedAt);

      const historyLines = readFileSync(historyPath, "utf8").trimEnd().split("\n");
      assert.equal(historyLines.length, 1);
      const history = parseHistoryEventBytes(Buffer.from(`${historyLines[0]}\n`, "utf8"), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(history.eventId, historyEventId);
      assert.equal(history.transactionId, transactionId);
      assert.equal(history.eventType, "capture_retained");
      assert.equal(history.observationId, observationId);
      assert.equal(history.capturedAt, capturedAt);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a second publish retains prior capture history and replaces only live authority", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-second-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    try {
      const first = await prepareBundle(workspace);
      await publishCaptureObservation(lock, workspace, runId, first.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });

      const second = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
      await publishCaptureObservation(lock, workspace, runId, second.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: () => secondHistoryEventId,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });

      const runDirectory = join(workspace, ".cu", runId);
      const capturesDirectory = join(runDirectory, "captures");
      assert.deepEqual(readdirSync(capturesDirectory).sort(), [
        `${observationId}.json`,
        `${observationId}.png`,
        `${secondObservationId}.json`,
        `${secondObservationId}.png`
      ]);
      assert.deepEqual(readFileSync(join(capturesDirectory, `${observationId}.png`)), first.image);
      assert.deepEqual(readFileSync(join(capturesDirectory, `${secondObservationId}.png`)), second.image);

      const live = parseLiveObservationBytes(readFileSync(join(runDirectory, "live-observation.json")), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(live.kind, "cu.live-observation/v1");
      if (live.kind !== "cu.live-observation/v1") assert.fail("expected live observation");
      assert.equal(live.observationId, secondObservationId);
      assert.equal(live.publishedByTransactionId, secondTransactionId);
      assert.equal(live.captureMetadataSha256, sha256(second.metadata));
      assert.equal(live.state, "actionable");

      const historyLines = readFileSync(join(runDirectory, "history.ndjson"), "utf8").trimEnd().split("\n");
      assert.equal(historyLines.length, 2);
      const firstHistory = parseHistoryEventBytes(Buffer.from(`${historyLines[0]}\n`, "utf8"), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      const secondHistory = parseHistoryEventBytes(Buffer.from(`${historyLines[1]}\n`, "utf8"), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(firstHistory.eventType, "capture_retained");
      assert.equal(secondHistory.eventType, "capture_retained");
      if (firstHistory.eventType !== "capture_retained" || secondHistory.eventType !== "capture_retained") {
        assert.fail("expected capture history events");
      }
      assert.equal(firstHistory.observationId, observationId);
      assert.equal(secondHistory.observationId, secondObservationId);
      assert.equal(secondHistory.transactionId, secondTransactionId);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "@archive", secondTransactionId)), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("publish evicts exactly the oldest eligible history at the 128-bundle boundary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-quota-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const runDirectory = join(workspace, ".cu", runId);
    const capturesDirectory = join(runDirectory, "captures");
    mkdirSync(capturesDirectory);
    const image = pngBytes();
    let currentId = "";
    let currentMetadata: Buffer = Buffer.alloc(0);
    let currentRecord: Record<string, unknown> = {};
    for (let index = 1; index <= 129; index += 1) {
      const id = `obs_${index.toString(16).padStart(32, "0")}`;
      const at = new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString();
      const metadata = captureMetadata(workspace, image, id, at);
      writeFileSync(join(capturesDirectory, `${id}.json`), metadata);
      writeFileSync(join(capturesDirectory, `${id}.png`), image);
      if (index === 129) {
        currentId = id;
        currentMetadata = metadata;
        currentRecord = JSON.parse(metadata.toString("utf8")) as Record<string, unknown>;
      }
    }
    writeFileSync(join(runDirectory, "live-observation.json"), Buffer.from(`${JSON.stringify({
      ...currentRecord,
      kind: "cu.live-observation/v1",
      publishedByTransactionId: "txn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      captureMetadataSha256: sha256(currentMetadata),
      state: "actionable",
      stateChangedAt: currentRecord.capturedAt
    })}\n`, "utf8"));

    const next = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      const result = await publishCaptureObservation(lock, workspace, runId, next.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: (index) => `hist_22222222222222222222222222222222_${index + 1}`,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });

      const oldestId = "obs_00000000000000000000000000000001";
      assert.equal(result.evictedHistoryCount, 1);
      assert.equal(existsSync(join(capturesDirectory, `${oldestId}.json`)), false);
      assert.equal(existsSync(join(capturesDirectory, `${oldestId}.png`)), false);
      assert.equal(existsSync(join(capturesDirectory, `${currentId}.json`)), true);
      assert.equal(existsSync(join(capturesDirectory, `${currentId}.png`)), true);
      assert.equal(existsSync(join(capturesDirectory, `${secondObservationId}.json`)), true);
      assert.equal(existsSync(join(capturesDirectory, `${secondObservationId}.png`)), true);
      assert.equal(readdirSync(capturesDirectory).length, 258);
      const historyLines = readFileSync(join(runDirectory, "history.ndjson"), "utf8").trimEnd().split("\n");
      assert.equal(historyLines.length, 2);
      assert.equal(parseHistoryEventBytes(Buffer.from(`${historyLines[0]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      }).eventType, "capture_evicted");
      assert.equal(parseHistoryEventBytes(Buffer.from(`${historyLines[1]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      }).eventType, "capture_retained");
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "@archive", secondTransactionId)), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a full unavailable history compacts to the newest 512 before publish", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-history-full-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const first = await prepareBundle(workspace);
    const next = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, first.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const livePath = join(runDirectory, "live-observation.json");
      const activePath = join(runDirectory, "archive-transaction.json");
      const capturesDirectory = join(runDirectory, "captures");
      const historyPath = join(runDirectory, "history.ndjson");
      const historyLines: Buffer[] = [];
      for (let index = 1; index <= 4_096; index += 1) {
        const suffix = index.toString(16).padStart(32, "0");
        historyLines.push(Buffer.from(`${JSON.stringify({
          kind: "cu.history.event/v1",
          schemaVersion: 1,
          eventId: `hist_${suffix}_1`,
          transactionId: `txn_${suffix}`,
          at: "2026-07-25T10:00:05.000Z",
          eventType: index === 1 ? "capture_retained" : "capture_evicted",
          runId,
          workspaceFingerprint: workspaceFingerprint(workspace),
          observationId: index === 1 ? observationId : `obs_${suffix}`,
          capturedAt: index === 1 ? capturedAt : "2026-07-25T10:00:00.000Z"
        })}\n`, "utf8"));
      }
      writeFileSync(historyPath, Buffer.concat(historyLines));

      const result = await publishCaptureObservation(
        lock,
        workspace,
        runId,
        next.bundle,
        {
          createTransactionId: () => secondTransactionId,
          createHistoryEventId: () => secondHistoryEventId,
          now: () => new Date("2026-07-25T10:02:05.000Z")
        }
      );
      assert.equal(result.observationId, secondObservationId);
      const compactedLive = parseLiveObservationBytes(readFileSync(livePath), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(compactedLive.observationId, secondObservationId);
      assert.deepEqual(readdirSync(capturesDirectory).sort(), [
        `${observationId}.json`,
        `${observationId}.png`,
        `${secondObservationId}.json`,
        `${secondObservationId}.png`
      ]);
      const compactedLines = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
      assert.equal(compactedLines.length, 514);
      const retainedTerminal = parseHistoryEventBytes(Buffer.from(`${compactedLines[0]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(retainedTerminal.eventId, "hist_00000000000000000000000000000001_1");
      assert.equal(retainedTerminal.eventType, "capture_retained");
      const firstUnavailable = parseHistoryEventBytes(Buffer.from(`${compactedLines[1]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(firstUnavailable.eventId, "hist_00000000000000000000000000000e01_1");
      assert.equal(firstUnavailable.eventType, "capture_evicted");
      const appended = parseHistoryEventBytes(Buffer.from(`${compactedLines.at(-1)}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(appended.eventId, secondHistoryEventId);
      assert.equal(appended.eventType, "capture_retained");
      assert.equal(existsSync(activePath), false);
      assert.equal(existsSync(join(runDirectory, "@archive", secondTransactionId)), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a compactable full history keeps the latest terminal event before publish", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-history-compact-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const first = await prepareBundle(workspace);
    const next = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, first.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const historyPath = join(runDirectory, "history.ndjson");
      const historyLines: Buffer[] = [];
      for (let index = 1; index <= 4_096; index += 1) {
        const suffix = index.toString(16).padStart(32, "0");
        historyLines.push(Buffer.from(`${JSON.stringify({
          kind: "cu.history.event/v1",
          schemaVersion: 1,
          eventId: `hist_${suffix}_1`,
          transactionId: `txn_${suffix}`,
          at: "2026-07-25T10:00:05.000Z",
          eventType: index === 4_096 ? "capture_retained" : "capture_evicted",
          runId,
          workspaceFingerprint: workspaceFingerprint(workspace),
          observationId,
          capturedAt
        })}\n`, "utf8"));
      }
      const latestTerminalLine = historyLines.at(-1)!;
      writeFileSync(historyPath, Buffer.concat(historyLines));

      const result = await publishCaptureObservation(lock, workspace, runId, next.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: () => secondHistoryEventId,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });
      assert.equal(result.observationId, secondObservationId);
      const compactedLines = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
      assert.equal(compactedLines.length, 2);
      assert.equal(`${compactedLines[0]}\n`, latestTerminalLine.toString("utf8"));
      const appended = parseHistoryEventBytes(Buffer.from(`${compactedLines[1]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(appended.eventId, secondHistoryEventId);
      assert.equal(appended.eventType, "capture_retained");
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(readdirSync(runDirectory).some((name) => name.startsWith("@history-compact-")), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("forged and released authority fail content-free before run mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-authority-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const runDirectory = join(workspace, ".cu", runId);
    const beforeEntries = readdirSync(runDirectory).sort();
    const forged = Object.freeze({}) as unknown as Parameters<typeof publishCaptureObservation>[0];

    const forgedError = await observationArchiveError(() => publishCaptureObservation(
      forged,
      workspace,
      runId,
      prepared.bundle
    ));
    assert.equal(forgedError.message, "");
    assert.deepEqual(readdirSync(runDirectory).sort(), beforeEntries);

    const released = acquireRunLock(workspace, runId);
    released.release();
    const releasedError = await observationArchiveError(() => publishCaptureObservation(
      released,
      workspace,
      runId,
      prepared.bundle
    ));
    assert.equal(releasedError.message, "");
    assert.deepEqual(readdirSync(runDirectory).sort(), beforeEntries);

    const lock = acquireRunLock(workspace, runId);
    try {
      const forgedBundle = Object.freeze({
        capture: prepared.bundle.capture,
        captureMetadataSha256: prepared.bundle.captureMetadataSha256
      }) as unknown as ValidatedCaptureBundle;
      const bundleError = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        forgedBundle
      ));
      assert.equal(bundleError.message, "");
      assert.deepEqual(readdirSync(runDirectory).sort(), beforeEntries);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failure after durable prepared publication is classified as uncertainty", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-prepared-uncertain-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const runDirectory = join(workspace, ".cu", runId);
    const activePath = join(runDirectory, "archive-transaction.json");
    const lock = acquireRunLock(workspace, runId);
    const originalMkdir = mutableFs.mkdirSync;
    let injected = false;
    mutableFs.mkdirSync = ((path: import("node:fs").PathLike, options?: unknown) => {
      const normalizedPath = String(path).replaceAll("/", "\\").toLowerCase();
      if (!injected && normalizedPath.endsWith("\\@archive")) {
        injected = true;
        throw Object.assign(new Error("sensitive layout failure"), { code: "EACCES" });
      }
      return originalMkdir(path, options as never);
    }) as typeof import("node:fs").mkdirSync;
    syncBuiltinESMExports();
    try {
      const error = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        prepared.bundle,
        {
          createTransactionId: () => transactionId,
          createHistoryEventId: () => historyEventId,
          now: () => new Date("2026-07-25T10:00:05.000Z")
        }
      ));
      assert.equal(error instanceof ObservationArchivePublicationUncertainError, true);
      assert.equal(error.message, "");
      assert.equal(injected, true);
      assert.equal(existsSync(activePath), true);
      assert.equal(existsSync(join(runDirectory, "captures")), false);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
      assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
    } finally {
      mutableFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an untouched prepared transaction rolls back before a new publish", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-prepared-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      publishPreparedArchiveTransaction(lock, workspace, runId, activePreparedBytes(workspace, prepared.bundle));
      const result = await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: () => secondHistoryEventId,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      assert.equal(result.transactionId, secondTransactionId);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "captures", `${observationId}.json`)), true);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), true);
      assert.equal(readFileSync(join(runDirectory, "history.ndjson"), "utf8").trimEnd().split("\n").length, 1);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("prepared publication snapshots an exact tombstone predecessor", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-publish-tombstone-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const runDirectory = join(workspace, ".cu", runId);
    const tombstoneBytes = Buffer.from(`${JSON.stringify({
      kind: "cu.live-observation-tombstone/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: workspaceFingerprint(workspace),
      observationId,
      previousLiveRecordSha256: "e".repeat(64),
      invalidatedReason: "cleared",
      invalidatedAt: "2026-07-25T09:59:00.000Z",
      invalidatedByTransactionId: "txn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })}\n`, "utf8");
    const livePath = join(runDirectory, "live-observation.json");
    writeFileSync(livePath, tombstoneBytes);
    const lock = acquireRunLock(workspace, runId);
    const originalMkdir = mutableFs.mkdirSync;
    let injected = false;
    mutableFs.mkdirSync = ((path: import("node:fs").PathLike, options?: unknown) => {
      if (!injected && String(path).replaceAll("/", "\\").toLowerCase().endsWith("\\@archive")) {
        injected = true;
        throw Object.assign(new Error("sensitive layout failure"), { code: "EACCES" });
      }
      return originalMkdir(path, options as never);
    }) as typeof import("node:fs").mkdirSync;
    syncBuiltinESMExports();
    try {
      const error = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        prepared.bundle,
        {
          createTransactionId: () => transactionId,
          createHistoryEventId: () => historyEventId,
          now: () => new Date("2026-07-25T10:00:05.000Z")
        }
      ));
      assert.equal(error instanceof ObservationArchivePublicationUncertainError, true);
      const active = parseArchiveTransactionBytes(
        readFileSync(join(runDirectory, "archive-transaction.json")),
        { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
      );
      assert.equal(active.operation, "publish");
      if (active.operation !== "publish") assert.fail("expected publish transaction");
      assert.deepEqual(active.priorLive, {
        observationId,
        liveRecordSha256: sha256(tombstoneBytes)
      });
      assert.equal(active.payload.replacesObservationId, observationId);
      assert.deepEqual(readFileSync(livePath), tombstoneBytes);
      assert.equal(injected, true);
    } finally {
      mutableFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("untouched prepared recovery restores an exact tombstone predecessor", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-tombstone-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace, secondObservationId, secondCapturedAt);
    const runDirectory = join(workspace, ".cu", runId);
    const tombstoneBytes = Buffer.from(`${JSON.stringify({
      kind: "cu.live-observation-tombstone/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: workspaceFingerprint(workspace),
      observationId,
      previousLiveRecordSha256: "e".repeat(64),
      invalidatedReason: "cleared",
      invalidatedAt: "2026-07-25T09:59:00.000Z",
      invalidatedByTransactionId: "txn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })}\n`, "utf8");
    const livePath = join(runDirectory, "live-observation.json");
    writeFileSync(livePath, tombstoneBytes);
    const activeBytes = publishTransactionBytes(workspace, prepared.bundle, {
      priorLive: {
        observationId,
        liveRecordSha256: sha256(tombstoneBytes)
      },
      replacesObservationId: observationId
    });
    const lock = acquireRunLock(workspace, runId);
    try {
      publishPreparedArchiveTransaction(lock, workspace, runId, activeBytes);
      assert.equal(await recoverObservationArchive(lock, workspace, runId), true);
      assert.deepEqual(readFileSync(livePath), tombstoneBytes);
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(existsSync(join(runDirectory, "captures")), false);
      assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive live recovery appends missing fixed history once and removes the transaction last", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-live-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const activePath = join(runDirectory, "archive-transaction.json");
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const transactionDirectory = join(runDirectory, "@archive", transactionId);
      const stagingDirectory = join(transactionDirectory, "staging");
      mkdirSync(stagingDirectory, { recursive: true });
      mkdirSync(join(transactionDirectory, "trash"));
      linkSync(
        join(runDirectory, "captures", `${observationId}.json`),
        join(stagingDirectory, `${observationId}.json`)
      );
      linkSync(
        join(runDirectory, "captures", `${observationId}.png`),
        join(stagingDirectory, `${observationId}.png`)
      );
      const historyPath = join(runDirectory, "history.ndjson");
      const expectedHistoryBytes = readFileSync(historyPath);
      const activeBytes = activePreparedBytes(
        workspace,
        prepared.bundle,
        "assets_staged",
        sha256(liveBytes)
      );
      const activeRecord = JSON.parse(activeBytes.toString("utf8")) as {
        historyEvents: Array<Record<string, unknown>>;
      };
      const expectedRecoveryLine = Buffer.from(`${JSON.stringify({
        kind: "cu.history.event/v1",
        schemaVersion: 1,
        ...activeRecord.historyEvents[0],
        transactionId,
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      })}\n`);
      assert.equal(expectedRecoveryLine.toString("utf8"), expectedHistoryBytes.toString("utf8"));
      writeFileSync(historyPath, expectedHistoryBytes.subarray(0, Math.floor(expectedHistoryBytes.length / 2)));
      writeFileSync(activePath, activeBytes);

      assert.equal(await recoverObservationArchive(lock, workspace, runId), true);
      assert.equal(existsSync(activePath), false);
      assert.equal(existsSync(transactionDirectory), false);
      assert.deepEqual(readFileSync(historyPath), expectedHistoryBytes);
      const historyLines = readFileSync(historyPath, "utf8").trimEnd().split("\n");
      assert.equal(historyLines.length, 1);
      const history = parseHistoryEventBytes(Buffer.from(`${historyLines[0]}\n`), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(history.eventId, historyEventId);
      assert.equal(history.transactionId, transactionId);
      assert.equal(history.eventType, "capture_retained");
      assert.equal(await recoverObservationArchive(lock, workspace, runId), false);
      assert.equal(readFileSync(historyPath, "utf8").trimEnd().split("\n").length, 1);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive live recovery rejects a publish transaction with incomplete eviction history semantics", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-semantics-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const first = await prepareBundle(workspace);
    const second = await prepareBundle(workspace, secondObservationId, "2026-07-25T10:02:00.000Z");
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, first.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const priorLiveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      await publishCaptureObservation(lock, workspace, runId, second.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: () => secondHistoryEventId,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });
      rmSync(join(runDirectory, "captures", `${observationId}.json`));
      rmSync(join(runDirectory, "captures", `${observationId}.png`));
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activePath = join(runDirectory, "archive-transaction.json");
      const activeBytes = publishTransactionBytes(workspace, second.bundle, {
        transactionId: secondTransactionId,
        state: "assets_staged",
        liveRecordSha256: sha256(liveBytes),
        priorLive: { observationId, liveRecordSha256: sha256(priorLiveBytes) },
        movedBundles: [descriptorFor(first.bundle)],
        historyEvents: [],
        replacesObservationId: observationId
      });
      writeFileSync(activePath, activeBytes);
      const historyPath = join(runDirectory, "history.ndjson");
      const historyBefore = readFileSync(historyPath);

      const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.deepEqual(readFileSync(historyPath), historyBefore);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive live recovery rejects non-prefix transaction history ordering", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-order-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const first = await prepareBundle(workspace);
    const second = await prepareBundle(workspace, secondObservationId, "2026-07-25T10:02:00.000Z");
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, first.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const priorLiveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      await publishCaptureObservation(lock, workspace, runId, second.bundle, {
        createTransactionId: () => secondTransactionId,
        createHistoryEventId: () => secondHistoryEventId,
        now: () => new Date("2026-07-25T10:02:05.000Z")
      });
      rmSync(join(runDirectory, "captures", `${observationId}.json`));
      rmSync(join(runDirectory, "captures", `${observationId}.png`));
      const events: ArchiveHistoryEvent[] = [
        {
          eventId: "hist_33333333333333333333333333333333_1",
          at: "2026-07-25T10:02:05.000Z",
          eventType: "capture_evicted",
          observationId,
          capturedAt: first.bundle.capture.capturedAt
        },
        {
          eventId: "hist_33333333333333333333333333333333_2",
          at: "2026-07-25T10:02:05.000Z",
          eventType: "capture_retained",
          observationId: secondObservationId,
          capturedAt: second.bundle.capture.capturedAt
        }
      ];
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activePath = join(runDirectory, "archive-transaction.json");
      const activeBytes = publishTransactionBytes(workspace, second.bundle, {
        transactionId: secondTransactionId,
        state: "assets_staged",
        liveRecordSha256: sha256(liveBytes),
        priorLive: { observationId, liveRecordSha256: sha256(priorLiveBytes) },
        movedBundles: [descriptorFor(first.bundle)],
        historyEvents: events,
        replacesObservationId: observationId
      });
      writeFileSync(activePath, activeBytes);
      const historyPath = join(runDirectory, "history.ndjson");
      const outOfOrder = historyLineBytes(workspace, secondTransactionId, events[1]!);
      writeFileSync(historyPath, outOfOrder);

      const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.deepEqual(readFileSync(historyPath), outOfOrder);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive live with an unrelated malformed history suffix blocks without repair", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-recover-history-blocked-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const activePath = join(runDirectory, "archive-transaction.json");
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activeBytes = activePreparedBytes(
        workspace,
        prepared.bundle,
        "assets_staged",
        sha256(liveBytes)
      );
      writeFileSync(activePath, activeBytes);
      const malformedHistory = Buffer.from('{"secret":"unrelated typed text', "utf8");
      const historyPath = join(runDirectory, "history.ndjson");
      writeFileSync(historyPath, malformedHistory);

      const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.deepEqual(readFileSync(historyPath), malformedHistory);
      assert.equal(existsSync(join(runDirectory, "captures", `${observationId}.png`)), true);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive-live private ambiguity is proved before any history mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-positive-private-blocked-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activePath = join(runDirectory, "archive-transaction.json");
      const activeBytes = activePreparedBytes(
        workspace,
        prepared.bundle,
        "assets_staged",
        sha256(liveBytes)
      );
      writeFileSync(activePath, activeBytes);
      const historyPath = join(runDirectory, "history.ndjson");
      rmSync(historyPath);
      const transactionDirectory = join(runDirectory, "@archive", transactionId);
      mkdirSync(transactionDirectory, { recursive: true });
      const markerPath = join(transactionDirectory, "unknown");
      writeFileSync(markerPath, "private evidence");

      const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.equal(readFileSync(markerPath, "utf8"), "private evidence");
      assert.equal(existsSync(historyPath), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive recovery never adopts a byte-identical staged replacement for cleanup", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-private-replacement-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activePath = join(runDirectory, "archive-transaction.json");
      const activeBytes = activePreparedBytes(
        workspace,
        prepared.bundle,
        "assets_staged",
        sha256(liveBytes)
      );
      writeFileSync(activePath, activeBytes);
      const transactionDirectory = join(runDirectory, "@archive", transactionId);
      const stagingDirectory = join(transactionDirectory, "staging");
      mkdirSync(stagingDirectory, { recursive: true });
      mkdirSync(join(transactionDirectory, "trash"));
      const stagedMetadataPath = join(stagingDirectory, `${observationId}.json`);
      const stagedImagePath = join(stagingDirectory, `${observationId}.png`);
      linkSync(join(runDirectory, "captures", `${observationId}.json`), stagedMetadataPath);
      linkSync(join(runDirectory, "captures", `${observationId}.png`), stagedImagePath);
      const displacedPath = join(stagingDirectory, "displaced.json");
      const historyPath = join(runDirectory, "history.ndjson");
      rmSync(historyPath);

      const originalFsync = mutableFs.fsyncSync;
      let injected = false;
      mutableFs.fsyncSync = (descriptor) => {
        originalFsync(descriptor);
        if (!injected) {
          injected = true;
          mutableFs.renameSync(stagedMetadataPath, displacedPath);
          mutableFs.writeFileSync(stagedMetadataPath, prepared.metadata);
        }
      };
      syncBuiltinESMExports();
      try {
        const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
        assert.equal(error.message, "");
      } finally {
        mutableFs.fsyncSync = originalFsync;
        syncBuiltinESMExports();
      }

      assert.equal(injected, true);
      assert.deepEqual(readFileSync(stagedMetadataPath), prepared.metadata);
      assert.deepEqual(readFileSync(displacedPath), prepared.metadata);
      assert.equal(existsSync(stagedImagePath), true);
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.equal(existsSync(historyPath), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("positive recovery does not delete a changed same-id active transaction", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-active-replacement-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      await publishCaptureObservation(lock, workspace, runId, prepared.bundle, {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      });
      const runDirectory = join(workspace, ".cu", runId);
      const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
      const activePath = join(runDirectory, "archive-transaction.json");
      const activeBytes = activePreparedBytes(
        workspace,
        prepared.bundle,
        "assets_staged",
        sha256(liveBytes)
      );
      const alteredRecord = JSON.parse(activeBytes.toString("utf8")) as Record<string, unknown>;
      alteredRecord.updatedAt = "2026-07-25T10:00:06.000Z";
      const alteredBytes = Buffer.from(`${JSON.stringify(alteredRecord)}\n`, "utf8");
      writeFileSync(activePath, activeBytes);
      const historyPath = join(runDirectory, "history.ndjson");
      rmSync(historyPath);

      const originalFsync = mutableFs.fsyncSync;
      let injected = false;
      mutableFs.fsyncSync = (descriptor) => {
        originalFsync(descriptor);
        if (!injected) {
          injected = true;
          mutableFs.writeFileSync(activePath, alteredBytes);
        }
      };
      syncBuiltinESMExports();
      try {
        const error = await observationArchiveError(() => recoverObservationArchive(lock, workspace, runId));
        assert.equal(error.message, "");
      } finally {
        mutableFs.fsyncSync = originalFsync;
        syncBuiltinESMExports();
      }

      assert.equal(injected, true);
      assert.deepEqual(readFileSync(activePath), alteredBytes);
      assert.equal(existsSync(historyPath), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ambiguous private evidence blocks active recovery without mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observation-archive-active-blocked-"));
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const prepared = await prepareBundle(workspace);
    const lock = acquireRunLock(workspace, runId);
    try {
      publishPreparedArchiveTransaction(lock, workspace, runId, activePreparedBytes(workspace, prepared.bundle));
      const runDirectory = join(workspace, ".cu", runId);
      const activePath = join(runDirectory, "archive-transaction.json");
      const privateDirectory = join(runDirectory, "@archive", transactionId);
      mkdirSync(privateDirectory, { recursive: true });
      const markerPath = join(privateDirectory, "unknown");
      writeFileSync(markerPath, "evidence");
      const activeBytes = readFileSync(activePath);
      const beforeEntries = readdirSync(runDirectory).sort();

      const error = await observationArchiveError(() => publishCaptureObservation(
        lock,
        workspace,
        runId,
        prepared.bundle,
        {
          createTransactionId: () => secondTransactionId,
          createHistoryEventId: () => secondHistoryEventId,
          now: () => new Date("2026-07-25T10:02:05.000Z")
        }
      ));

      assert.equal(error.message, "");
      assert.deepEqual(readFileSync(activePath), activeBytes);
      assert.equal(readFileSync(markerPath, "utf8"), "evidence");
      assert.deepEqual(readdirSync(runDirectory).sort(), beforeEntries);
      assert.equal(existsSync(join(runDirectory, "captures")), false);
      assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
      assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
