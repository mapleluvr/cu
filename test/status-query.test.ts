import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArchiveQueryError,
  inspectRunStatus,
  listWorkspaceRuns
} from "../src/archive-query.js";
import { parseEffectJournalBytes, validateEffectJournalLiveBinding } from "../src/effect-journal.js";
import { parseLiveObservationBytes } from "../src/observation-record.js";
import { ensureRun } from "../src/run.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const effectObservation = "obs_0123456789abcdef0123456789abcdef";
const effectId = "eff_0123456789abcdef0123456789abcdef";

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

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function line(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function seedConsumedEffect(root: string): {
  journalPath: string;
  preConsumeDigest: string;
  captureMetadataDigest: string;
  imageDigest: string;
  states: Array<"intent" | "partial" | "indeterminate">;
} {
  const runId = "run-a";
  const fingerprint = workspaceFingerprint(root);
  const runDirectory = join(root, ".cu", runId);
  const captures = join(runDirectory, "captures");
  mkdirSync(captures);
  const image = pngBytes();
  const capturedAt = "2026-07-25T10:00:00.000Z";
  const metadata = line({
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: fingerprint,
    observationId: effectObservation,
    capturedAt,
    expiresAt: "2026-07-25T10:01:00.000Z",
    coordinateSpace: "normalized_999_top_left",
    source: { captureKind: "region", mapping: "normalized_endpoint_centers/v1", leftPx: 10, topPx: 20, widthPx: 2, heightPx: 1 },
    environmentFingerprint: "d".repeat(64),
    topologyFingerprint: "e".repeat(64),
    image: { mediaType: "image/png", sha256: digest(image), byteLength: image.length, width: 2, height: 1 }
  });
  writeFileSync(join(captures, `${effectObservation}.json`), metadata);
  writeFileSync(join(captures, `${effectObservation}.png`), image);
  const transactionId = "txn_0123456789abcdef0123456789abcdef";
  writeFileSync(join(runDirectory, "history.ndjson"), line({
    kind: "cu.history.event/v1",
    schemaVersion: 1,
    eventId: "hist_0123456789abcdef0123456789abcdef_1",
    transactionId,
    at: capturedAt,
    eventType: "capture_retained",
    runId,
    workspaceFingerprint: fingerprint,
    observationId: effectObservation,
    capturedAt
  }));
  const actionable = {
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: fingerprint,
    observationId: effectObservation,
    publishedByTransactionId: transactionId,
    captureMetadataSha256: digest(metadata),
    capturedAt,
    expiresAt: "2026-07-25T10:01:00.000Z",
    coordinateSpace: "normalized_999_top_left",
    source: { captureKind: "region", mapping: "normalized_endpoint_centers/v1", leftPx: 10, topPx: 20, widthPx: 2, heightPx: 1 },
    environmentFingerprint: "d".repeat(64),
    topologyFingerprint: "e".repeat(64),
    image: { mediaType: "image/png", sha256: digest(image), byteLength: image.length, width: 2, height: 1 },
    state: "actionable",
    stateChangedAt: capturedAt
  } as const;
  const actionableBytes = line(actionable);
  const consumed = { ...actionable, state: "consumed" as const, stateChangedAt: "2026-07-25T10:00:01.000Z", consumedByEffectId: effectId };
  writeFileSync(join(runDirectory, "live-observation.json"), line(consumed));
  const journalPath = join(runDirectory, "effect-journal.json");
  return {
    journalPath,
    preConsumeDigest: digest(actionableBytes),
    captureMetadataDigest: digest(metadata),
    imageDigest: digest(image),
    states: ["intent", "partial", "indeterminate"]
  };
}

test("projects every valid unresolved effect state bound to pre-consume live bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-status-query-effect-"));
  try {
    initializeWorkspace(root);
    ensureRun(root, "run-a");
    const seeded = seedConsumedEffect(root);
    for (const state of seeded.states) {
      const journal = {
        kind: "cu.effect-journal/v1",
        schemaVersion: 1,
        runId: "run-a",
        workspaceFingerprint: workspaceFingerprint(root),
        effectId,
        createdAt: "2026-07-25T10:00:00.500Z",
        state,
        stateChangedAt: "2026-07-25T10:00:01.000Z",
        observation: {
          observationId: effectObservation,
          liveRecordSha256: "".padStart(64, "a"),
          captureMetadataSha256: seeded.captureMetadataDigest,
          imageSha256: seeded.imageDigest,
          environmentFingerprint: "d".repeat(64),
          topologyFingerprint: "e".repeat(64)
        },
        plan: {
          redactedDigest: "f".repeat(64),
          leafActionCount: 1,
          coordinateActionCount: 1,
          declaredDelayMs: 0,
          typeText: { actionCount: 0, scalarCount: 0, utf8Bytes: 0 },
          terminalDecision: "completed"
        },
        ...(state === "intent" ? {} : { reason: "input_unproven" })
      };
      const valid = {
        ...journal,
        observation: { ...journal.observation, liveRecordSha256: seeded.preConsumeDigest }
      };
      writeFileSync(seeded.journalPath, line(valid));
      const binding = { runId: "run-a", workspaceFingerprint: workspaceFingerprint(root) };
      const parsedJournal = parseEffectJournalBytes(readFileSync(seeded.journalPath), binding);
      const parsedLive = parseLiveObservationBytes(
        readFileSync(join(root, ".cu", "run-a", "live-observation.json")),
        binding
      );
      assert.equal(parsedLive.kind, "cu.live-observation/v1");
      if (parsedLive.kind === "cu.live-observation/v1") {
        validateEffectJournalLiveBinding(parsedJournal, parsedLive, seeded.preConsumeDigest);
      }
      assert.equal((await inspectRunStatus(root, "run-a")).effect?.state, state);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a valid effect journal that has no consumed live authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-status-query-journal-"));
  try {
    initializeWorkspace(root);
    ensureRun(root, "run-a");
    writeFileSync(join(root, ".cu", "run-a", "effect-journal.json"), Buffer.from(`${JSON.stringify({
      kind: "cu.effect-journal/v1",
      schemaVersion: 1,
      runId: "run-a",
      workspaceFingerprint: workspaceFingerprint(root),
      effectId: "eff_0123456789abcdef0123456789abcdef",
      createdAt: "2026-07-25T10:00:00.000Z",
      state: "partial",
      stateChangedAt: "2026-07-25T10:00:01.000Z",
      observation: {
        observationId: "obs_0123456789abcdef0123456789abcdef",
        liveRecordSha256: "a".repeat(64),
        captureMetadataSha256: "b".repeat(64),
        imageSha256: "c".repeat(64),
        environmentFingerprint: "d".repeat(64),
        topologyFingerprint: "e".repeat(64)
      },
      plan: {
        redactedDigest: "f".repeat(64),
        leafActionCount: 1,
        coordinateActionCount: 1,
        declaredDelayMs: 0,
        typeText: { actionCount: 0, scalarCount: 0, utf8Bytes: 0 },
        terminalDecision: "completed"
      },
      reason: "input_unproven"
    })}\n`));
    await assert.rejects(() => inspectRunStatus(root, "run-a"), (error: unknown) => error instanceof ArchiveQueryError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lists strict workspace run summaries without acquiring locks", () => {
  const root = mkdtempSync(join(tmpdir(), "cu-status-query-runs-"));
  try {
    initializeWorkspace(root);
    ensureRun(root, "run-b");
    ensureRun(root, "run-a");
    assert.deepEqual(listWorkspaceRuns(root), [
      { id: "run-a", lifecycle: "ready", profile: "autonomous" },
      { id: "run-b", lifecycle: "ready", profile: "autonomous" }
    ]);
    assert.deepEqual(readdirSync(join(root, ".cu", "@locks")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspects safe empty-run status without locking or changing state", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-status-query-"));
  try {
    initializeWorkspace(root);
    ensureRun(root, "run-a");
    const before = readFileSync(join(root, ".cu", "run-a", "run.json"));
    const status = await inspectRunStatus(root, "run-a");

    assert.deepEqual(status, {
      id: "run-a",
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
    });
    assert.deepEqual(readdirSync(join(root, ".cu", "run-a")), ["run.json"]);
    assert.deepEqual(readFileSync(join(root, ".cu", "run-a", "run.json")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
