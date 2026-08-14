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
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import {
  actRegion,
  ActBlockedError,
  ActIndeterminateError,
  ActInternalError,
  ActPartialError
} from "../src/act.js";
import { inspectArchiveTransactionWithWitness } from "../src/archive-store.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { isCaptureSelector, resolveCaptureSelector } from "../src/display.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import {
  beginEffectIntent,
  finalizeEffectJournalForArchiveTransaction,
  inspectActAuthority,
  proveEffectArchiveResolution
} from "../src/effect-store.js";
import { parseEffectJournalBytes } from "../src/effect-journal.js";
import { parseHistoryEventBytes } from "../src/history-event.js";
import { parseLiveObservationBytes } from "../src/observation-record.js";
import {
  publishCaptureObservation,
  recoverObservationArchive
} from "../src/observation-archive.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";
import type { RegionalCapture } from "../src/windows-capture.js";
import {
  WindowsInputError,
  type PreparedWindowsInputSegment,
  type WindowsInputSegment,
  type WindowsInputSession
} from "../src/windows-input.js";

const runId = "work-a";
const observationId = "obs_0123456789abcdef0123456789abcdef";
const effectId = "eff_0123456789abcdef0123456789abcdef";

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
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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

function admittedPlan(actions: readonly unknown[]) {
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted plan");
  return admitted.plan;
}

test("completed act persists intent before exact input and removes the journal only after cleanup", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-act-"));
  const capturedAt = new Date();
  const events: string[] = [];
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const runDirectory = join(workspace, ".cu", runId);
    const journalPath = join(runDirectory, "effect-journal.json");
    const livePath = join(runDirectory, "live-observation.json");
    const binding = { runId, workspaceFingerprint: workspaceFingerprint(workspace) };

    const preparedToken = Object.freeze({}) as PreparedWindowsInputSegment;
    let preparedSegment: WindowsInputSegment | undefined;
    let inputSession: WindowsInputSession;
    inputSession = Object.freeze({
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      prepareSegment(segment) {
        events.push("prepare");
        assert.equal(existsSync(journalPath), false);
        const live = parseLiveObservationBytes(readFileSync(livePath), binding);
        assert.equal(live.kind, "cu.live-observation/v1");
        if (live.kind !== "cu.live-observation/v1") assert.fail("expected live record");
        assert.equal(live.state, "actionable");
        preparedSegment = segment;
        return preparedToken;
      },
      async emitPrepared(prepared) {
        assert.equal(prepared, preparedToken);
        if (preparedSegment === undefined) assert.fail("expected prepared segment");
        return inputSession.emitSegment(preparedSegment);
      },
      async emitSegment(segment) {
        events.push("emit");
        assert.deepEqual(segment.source, {
          mapping: "normalized_endpoint_centers/v1",
          leftPx: 10,
          topPx: 20,
          widthPx: 2,
          heightPx: 1
        });
        assert.deepEqual(segment.actions, [{ kind: "click", at: { x: 420, y: 318 }, button: "left", count: 1 }]);
        const journal = parseEffectJournalBytes(readFileSync(journalPath), binding);
        const live = parseLiveObservationBytes(readFileSync(livePath), binding);
        assert.equal(journal.state, "intent");
        assert.equal(journal.effectId, effectId);
        assert.equal(live.kind, "cu.live-observation/v1");
        if (live.kind !== "cu.live-observation/v1") assert.fail("expected live record");
        assert.equal(live.state, "consumed");
        if (live.state !== "consumed") assert.fail("expected consumed live");
        assert.equal(live.consumedByEffectId, effectId);
        return Object.freeze({
          requestedNativeRecords: 3,
          acceptedNativeRecords: 3,
          emittedActionCount: 1,
          emittedLeafActionCount: 1,
          cleanup: "not_needed" as const,
          heldAfter: Object.freeze([]) as readonly []
        });
      },
      async close() {
        events.push("close");
      }
    });

    let clockCalls = 0;
    const result = await actRegion(
      workspace,
      runId,
      admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
      {
        createEffectId: () => effectId,
        now: () => new Date(capturedAt.getTime() + 2_000 + clockCalls++),
        openInputSession: async () => inputSession
      }
    );

    assert.deepEqual(result, {
      outcome: "completed",
      emittedActionCount: 1,
      emittedLeafActionCount: 1
    });
    assert.deepEqual(events, ["prepare", "emit", "close"]);
    assert.equal(clockCalls, 2);
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
    const finalLive = parseLiveObservationBytes(readFileSync(livePath), binding);
    assert.equal(finalLive.kind, "cu.live-observation/v1");
    if (finalLive.kind !== "cu.live-observation/v1") assert.fail("expected live record");
    assert.equal(finalLive.state, "consumed");
    if (finalLive.state !== "consumed") assert.fail("expected consumed live");
    assert.equal(finalLive.consumedByEffectId, effectId);
    const lock = acquireRunLock(workspace, runId);
    lock.release();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkpoint emits only the D2 prefix and resolves the effect through fresh archive cutover", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-act-checkpoint-"));
  const capturedAt = new Date();
  const checkpointAt = new Date(capturedAt.getTime() + 4_000);
  const checkpointObservationId = "obs_1123456789abcdef0123456789abcdef";
  const secretTail = "private-unexecuted-tail-text";
  const events: string[] = [];
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const runDirectory = join(workspace, ".cu", runId);
    const journalPath = join(runDirectory, "effect-journal.json");
    const livePath = join(runDirectory, "live-observation.json");
    const historyPath = join(runDirectory, "history.ndjson");
    const binding = { runId, workspaceFingerprint: workspaceFingerprint(workspace) };
    const preparedToken = Object.freeze({}) as PreparedWindowsInputSegment;
    let preparedSegment: WindowsInputSegment | undefined;
    let inputSession: WindowsInputSession;
    inputSession = Object.freeze({
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      prepareSegment(segment) {
        events.push("prepare");
        assert.equal(existsSync(journalPath), false);
        assert.deepEqual(segment.actions, [
          { kind: "click", at: { x: 420, y: 318 }, button: "left", count: 1 }
        ]);
        preparedSegment = segment;
        return preparedToken;
      },
      async emitPrepared(prepared) {
        assert.equal(prepared, preparedToken);
        if (preparedSegment === undefined) assert.fail("expected prepared segment");
        return inputSession.emitSegment(preparedSegment);
      },
      async emitSegment(segment) {
        events.push("emit");
        assert.equal(segment.actions.length, 1);
        const journalBytes = readFileSync(journalPath);
        assert.equal(journalBytes.includes(Buffer.from(secretTail, "utf8")), false);
        const journal = parseEffectJournalBytes(journalBytes, binding);
        const live = parseLiveObservationBytes(readFileSync(livePath), binding);
        assert.equal(journal.state, "intent");
        assert.equal(journal.plan.terminalDecision, "checkpoint");
        assert.equal(live.kind, "cu.live-observation/v1");
        if (live.kind !== "cu.live-observation/v1") assert.fail("expected live record");
        assert.equal(live.state, "consumed");
        return Object.freeze({
          requestedNativeRecords: 3,
          acceptedNativeRecords: 3,
          emittedActionCount: 1,
          emittedLeafActionCount: 1,
          cleanup: "not_needed" as const,
          heldAfter: Object.freeze([]) as readonly []
        });
      },
      async close() {
        events.push("close");
      }
    });
    const admittedCheckpointCapture = await regionalCapture(
      workspace,
      checkpointObservationId,
      checkpointAt
    );
    const checkpointCapture: RegionalCapture = Object.freeze({
      ...admittedCheckpointCapture,
      capturedAt: new Date(checkpointAt.getTime() + 30_000).toISOString(),
      expiresAt: new Date(checkpointAt.getTime() + 90_000).toISOString()
    });

    const result = await actRegion(
      workspace,
      runId,
      admittedPlan([
        { kind: "click", at: { x: 420, y: 318 } },
        { kind: "click", at: { x: 620, y: 318 } },
        { kind: "type_text", text: secretTail }
      ]),
      {
        createEffectId: () => effectId,
        now: () => new Date(capturedAt.getTime() + 2_000),
        openInputSession: async () => inputSession,
        captureObservation: async (request: Readonly<{ selector: unknown }>) => {
          events.push("capture");
          assert.equal(parseEffectJournalBytes(readFileSync(journalPath), binding).effectId, effectId);
          assert.deepEqual(request.selector, {
            kind: "pixel",
            left: 10,
            top: 20,
            width: 2,
            height: 1
          });
          assert.equal(isCaptureSelector(request.selector), true);
          if (!isCaptureSelector(request.selector)) assert.fail("expected capture selector");
          assert.deepEqual(
            resolveCaptureSelector(request.selector, {
              virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
              monitors: [
                { x: 0, y: 0, width: 100, height: 100, primary: true },
                { x: 0, y: 0, width: 100, height: 100, primary: false }
              ]
            }),
            { x: 10, y: 20, width: 2, height: 1 }
          );
          return checkpointCapture;
        },
        publishOptions: {
          now: () => new Date(capturedAt.getTime() + 5_000),
          createTransactionId: () => "txn_1123456789abcdef0123456789abcdef",
          createHistoryEventId: (index: number) =>
            `hist_1123456789abcdef0123456789abcdef_${index + 1}`
        }
      }
    );

    assert.deepEqual(result, {
      outcome: "checkpoint",
      emittedActionCount: 1,
      emittedLeafActionCount: 1,
      checkpoint: {
        observationId: checkpointObservationId,
        imagePath: `.cu/${runId}/captures/${checkpointObservationId}.png`,
        coordinateSpace: "normalized_999_top_left",
        capturedAt: checkpointAt.toISOString(),
        expiresAt: new Date(checkpointAt.getTime() + 60_000).toISOString(),
        actionable: true,
        evictedHistoryCount: 0
      }
    });
    assert.deepEqual(events, ["prepare", "emit", "capture", "close"]);
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
    assert.deepEqual(readdirSync(join(runDirectory, "@archive")), []);
    const live = parseLiveObservationBytes(readFileSync(livePath), binding);
    assert.equal(live.kind, "cu.live-observation/v1");
    if (live.kind !== "cu.live-observation/v1") assert.fail("expected live record");
    assert.equal(live.state, "actionable");
    assert.equal(live.observationId, checkpointObservationId);
    const history = readFileSync(historyPath)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => parseHistoryEventBytes(Buffer.from(line, "utf8"), binding));
    assert.equal(history.at(-2)?.eventType, "capture_retained");
    const retained = history.at(-2);
    if (retained?.eventType === "capture_retained") {
      assert.equal(retained.observationId, checkpointObservationId);
    } else {
      assert.fail("expected retained event");
    }
    const recovered = history.at(-1);
    assert.equal(recovered?.eventType, "effect_recovered");
    if (recovered?.eventType !== "effect_recovered") assert.fail("expected recovery event");
    assert.equal(recovered.effectId, effectId);
    assert.equal(recovered.recoveryObservationId, checkpointObservationId);
    assert.equal(readFileSync(historyPath).includes(Buffer.from(secretTail, "utf8")), false);
    assert.equal(readFileSync(livePath).includes(Buffer.from(secretTail, "utf8")), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("effect-resolving archive forward recovery proves journal, history, and transaction crash windows", async () => {
  const fsHooks = mutableFs as unknown as {
    unlinkSync: typeof mutableFs.unlinkSync;
    rmSync: typeof mutableFs.rmSync;
  };
  const originalUnlink = fsHooks.unlinkSync;
  const originalRm = fsHooks.rmSync;
  for (const mode of [
    "journal_unlink",
    "transaction_remove",
    "transaction_remove_malformed_history"
  ] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `cu-act-recovery-${mode}-`));
    const capturedAt = new Date();
    const recoveryObservationId = "obs_2123456789abcdef0123456789abcdef";
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const runDirectory = join(workspace, ".cu", runId);
      const journalPath = join(runDirectory, "effect-journal.json");
      const transactionPath = join(runDirectory, "archive-transaction.json");
      const historyPath = join(runDirectory, "history.ndjson");
      const lock = acquireRunLock(workspace, runId);
      try {
        const plan = admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]);
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
          recoveryObservationId,
          new Date(capturedAt.getTime() + 4_000)
        );
        if (mode === "journal_unlink") {
          fsHooks.unlinkSync = ((path: Parameters<typeof mutableFs.unlinkSync>[0]) => {
            if (basename(String(path)) === "effect-journal.json") {
              throw Object.assign(new Error("injected"), { code: "EACCES" });
            }
            return originalUnlink(path);
          }) as typeof mutableFs.unlinkSync;
        } else {
          fsHooks.rmSync = ((path: Parameters<typeof mutableFs.rmSync>[0], options?: Parameters<typeof mutableFs.rmSync>[1]) => {
            if (basename(String(path)) === "archive-transaction.json") {
              throw Object.assign(new Error("injected"), { code: "EACCES" });
            }
            return originalRm(path, options);
          }) as typeof mutableFs.rmSync;
        }
        syncBuiltinESMExports();
        await assert.rejects(
          publishCaptureObservation(lock, workspace, runId, recoveryCapture.bundle, {
            resolveEffect: intent,
            now: () => new Date(capturedAt.getTime() + 5_000),
            createTransactionId: () => "txn_2123456789abcdef0123456789abcdef",
            createHistoryEventId: (index) =>
              `hist_2123456789abcdef0123456789abcdef_${index + 1}`
          })
        );
      } finally {
        fsHooks.unlinkSync = originalUnlink;
        fsHooks.rmSync = originalRm;
        syncBuiltinESMExports();
        lock.release();
      }

      assert.equal(existsSync(transactionPath), true);
      assert.equal(existsSync(journalPath), mode === "journal_unlink");
      if (mode === "transaction_remove_malformed_history") {
        const history = readFileSync(historyPath);
        const priorNewline = history.lastIndexOf(0x0a, history.length - 2);
        assert.notEqual(priorNewline, -1);
        writeFileSync(
          historyPath,
          Buffer.concat([history.subarray(0, priorNewline + 1), Buffer.from("{\"unrelated\":", "utf8")])
        );
      }
      const recoveryLock = acquireRunLock(workspace, runId);
      try {
        if (mode === "journal_unlink") {
          const witnessed = inspectArchiveTransactionWithWitness(workspace, runId);
          assert.notEqual(witnessed, undefined);
          if (witnessed === undefined) assert.fail("expected active transaction");
          const resolutionProof = await proveEffectArchiveResolution(
            recoveryLock,
            workspace,
            runId,
            witnessed
          );
          const displacedPath = `${transactionPath}.displaced`;
          const transactionBytes = readFileSync(transactionPath);
          renameSync(transactionPath, displacedPath);
          writeFileSync(transactionPath, transactionBytes);
          assert.throws(() =>
            finalizeEffectJournalForArchiveTransaction(
              recoveryLock,
              workspace,
              runId,
              resolutionProof
            )
          );
          assert.equal(existsSync(journalPath), true);
          rmSync(transactionPath);
          renameSync(displacedPath, transactionPath);
        }
        if (mode === "transaction_remove_malformed_history") {
          await assert.rejects(recoverObservationArchive(recoveryLock, workspace, runId));
          assert.equal(existsSync(transactionPath), true);
        } else {
          assert.equal(await recoverObservationArchive(recoveryLock, workspace, runId), true);
          assert.equal(existsSync(transactionPath), false);
          assert.equal(existsSync(journalPath), false);
        }
      } finally {
        recoveryLock.release();
      }
    } finally {
      fsHooks.unlinkSync = originalUnlink;
      fsHooks.rmSync = originalRm;
      syncBuiltinESMExports();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("effect recovery proves the journal and displaced bundle before history or private mutation", async () => {
  const fsHooks = mutableFs as unknown as { openSync: typeof mutableFs.openSync };
  const originalOpen = fsHooks.openSync;
  for (const mode of [
    "journal_mismatch",
    "predecessor_missing",
    "predecessor_mismatch",
    "attributable_history_partial"
  ] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `cu-act-proof-${mode}-`));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const runDirectory = join(workspace, ".cu", runId);
      const journalPath = join(runDirectory, "effect-journal.json");
      const historyPath = join(runDirectory, "history.ndjson");
      const lock = acquireRunLock(workspace, runId);
      try {
        const plan = admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]);
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
        fsHooks.openSync = ((path: Parameters<typeof mutableFs.openSync>[0], flags: Parameters<typeof mutableFs.openSync>[1], mode?: Parameters<typeof mutableFs.openSync>[2]) => {
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
        fsHooks.openSync = originalOpen;
        syncBuiltinESMExports();
        lock.release();
      }

      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), true);
      assert.equal(existsSync(journalPath), true);
      assert.equal(existsSync(join(runDirectory, "@archive")), true);
      if (mode === "attributable_history_partial") {
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
      } else if (mode === "journal_mismatch") {
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
      } else {
        const predecessorPath = join(
          runDirectory,
          "captures",
          `${observationId}.json`
        );
        const predecessor = JSON.parse(readFileSync(predecessorPath, "utf8")) as {
          environmentFingerprint: string;
        };
        predecessor.environmentFingerprint = "d".repeat(64);
        writeFileSync(predecessorPath, `${JSON.stringify(predecessor)}\n`, "utf8");
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
        assert.equal(existsSync(journalPath), false);
        assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      } else {
        assert.deepEqual(snapshotDirectory(runDirectory), beforeRecovery);
        assert.equal(readFileSync(historyPath).includes(Buffer.from("effect_recovered", "utf8")), false);
        assert.equal(existsSync(journalPath), true);
        assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), true);
        assert.equal(existsSync(join(runDirectory, "@archive")), true);
      }
    } finally {
      fsHooks.openSync = originalOpen;
      syncBuiltinESMExports();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("act classifies pre-intent and native-input failures without losing no-replay evidence", async () => {
  const modes = ["input_unproven", "helper_lost", "cleanup_unproven"] as const;
  for (const mode of modes) {
    const workspace = mkdtempSync(join(tmpdir(), `cu-act-phase-${mode}-`));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const token = Object.freeze({}) as PreparedWindowsInputSegment;
      const session: WindowsInputSession = Object.freeze({
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64),
        prepareSegment: () => token,
        async emitPrepared(prepared) {
          assert.equal(prepared, token);
          throw new WindowsInputError(mode);
        },
        async emitSegment() {
          assert.fail("act must emit only the prepared capability");
        },
        async close() {}
      });
      const expectedError = mode === "input_unproven" ? ActPartialError : ActIndeterminateError;
      await assert.rejects(
        actRegion(
          workspace,
          runId,
          admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
          {
            createEffectId: () => effectId,
            now: () => new Date(capturedAt.getTime() + 2_000),
            openInputSession: async () => session
          }
        ),
        (error: unknown) =>
          error instanceof expectedError && error.message === "" && error.code === mode
      );
      const runDirectory = join(workspace, ".cu", runId);
      const binding = { runId, workspaceFingerprint: workspaceFingerprint(workspace) };
      const journal = parseEffectJournalBytes(
        readFileSync(join(runDirectory, "effect-journal.json")),
        binding
      );
      assert.equal(journal.state, mode === "input_unproven" ? "partial" : "indeterminate");
      if (!("reason" in journal)) assert.fail("expected unresolved reason");
      assert.equal(journal.reason, mode);
      const live = parseLiveObservationBytes(
        readFileSync(join(runDirectory, "live-observation.json")),
        binding
      );
      assert.equal(live.kind, "cu.live-observation/v1");
      if (live.kind !== "cu.live-observation/v1") assert.fail("expected consumed live");
      assert.equal(live.state, "consumed");
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      if (mode === "input_unproven") {
        await assert.rejects(
          actRegion(
            workspace,
            runId,
            admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
            {
              openInputSession: async () => assert.fail("unresolved effect must block before input")
            }
          ),
          (error: unknown) =>
            error instanceof ActBlockedError &&
            error.message === "" &&
            error.code === "effect_journal_unresolved"
        );
        rmSync(join(runDirectory, "live-observation.json"));
        await assert.rejects(
          actRegion(
            workspace,
            runId,
            admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
            {
              openInputSession: async () => assert.fail("corrupt journal/live binding must block before input")
            }
          ),
          (error: unknown) =>
            error instanceof ActInternalError &&
            error.message === "" &&
            error.code === "effect_journal_invalid"
        );
      }
      const lock = acquireRunLock(workspace, runId);
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  const workspace = mkdtempSync(join(tmpdir(), "cu-act-prepared-refusal-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const session: WindowsInputSession = Object.freeze({
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      prepareSegment() {
        throw new WindowsInputError("input_unproven");
      },
      async emitPrepared() {
        assert.fail("no prepared capability may emit");
      },
      async emitSegment() {
        assert.fail("no segment may emit");
      },
      async close() {}
    });
    await assert.rejects(
      actRegion(
        workspace,
        runId,
        admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
        {
          createEffectId: () => effectId,
          now: () => new Date(capturedAt.getTime() + 2_000),
          openInputSession: async () => session
        }
      ),
      (error: unknown) =>
        error instanceof ActBlockedError &&
        error.message === "" &&
        error.code === "input_unavailable"
    );
    const runDirectory = join(workspace, ".cu", runId);
    assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
    const live = parseLiveObservationBytes(
      readFileSync(join(runDirectory, "live-observation.json")),
      { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
    );
    assert.equal(live.kind, "cu.live-observation/v1");
    if (live.kind !== "cu.live-observation/v1") assert.fail("expected actionable live");
    assert.equal(live.state, "actionable");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("projects exact pre-effect observation, journal, and archive failure codes", async () => {
  const modes = [
    "unavailable",
    "expired",
    "environment_changed",
    "journal_invalid",
    "archive_recovery"
  ] as const;
  for (const mode of modes) {
    const workspace = mkdtempSync(join(tmpdir(), `cu-act-code-${mode}-`));
    const now = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      if (mode !== "unavailable") {
        const capturedAt = mode === "expired"
          ? new Date(now.getTime() - 61_000)
          : new Date(now.getTime() - 2_000);
        await seedActionableObservation(workspace, capturedAt);
      }
      const runDirectory = join(workspace, ".cu", runId);
      if (mode === "journal_invalid") {
        writeFileSync(join(runDirectory, "effect-journal.json"), Buffer.from("{private-journal"));
      }
      if (mode === "archive_recovery") {
        writeFileSync(join(runDirectory, "archive-transaction.json"), Buffer.from("{private-archive"));
      }
      let sessionOpened = false;
      const session: WindowsInputSession = Object.freeze({
        environmentFingerprint: mode === "environment_changed" ? "d".repeat(64) : "b".repeat(64),
        topologyFingerprint: "c".repeat(64),
        prepareSegment: () => assert.fail("pre-effect authority failure must not prepare input"),
        async emitPrepared() {
          assert.fail("pre-effect authority failure must not emit input");
        },
        async emitSegment() {
          assert.fail("pre-effect authority failure must not emit input");
        },
        async close() {}
      });
      const expected = mode === "unavailable"
        ? { type: ActBlockedError, code: "observation_unavailable" }
        : mode === "expired"
          ? { type: ActBlockedError, code: "observation_expired" }
          : mode === "environment_changed"
            ? { type: ActBlockedError, code: "observation_environment_changed" }
            : mode === "journal_invalid"
              ? { type: ActInternalError, code: "effect_journal_invalid" }
              : { type: ActBlockedError, code: "archive_recovery_required" };
      await assert.rejects(
        actRegion(
          workspace,
          runId,
          admittedPlan([{ kind: "click", at: { x: 420, y: 318 } }]),
          {
            now: () => new Date(now),
            openInputSession: async () => {
              sessionOpened = true;
              return session;
            }
          }
        ),
        (error: unknown) => {
          if (!(error instanceof expected.type) || error.message !== "" || !("code" in error)) {
            return false;
          }
          assert.equal(error.code, expected.code, mode);
          return true;
        }
      );
      assert.equal(
        sessionOpened,
        mode === "unavailable" || mode === "expired" || mode === "environment_changed"
      );
      assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("checkpoint capture and pre-transaction publish failures persist exact partial reasons", async () => {
  for (const mode of ["capture", "publish"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `cu-act-checkpoint-${mode}-`));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const token = Object.freeze({}) as PreparedWindowsInputSegment;
      const session: WindowsInputSession = Object.freeze({
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64),
        prepareSegment: () => token,
        async emitPrepared(prepared) {
          assert.equal(prepared, token);
          return Object.freeze({
            requestedNativeRecords: 3,
            acceptedNativeRecords: 3,
            emittedActionCount: 1,
            emittedLeafActionCount: 1,
            cleanup: "not_needed" as const,
            heldAfter: Object.freeze([]) as readonly []
          });
        },
        async emitSegment() {
          assert.fail("act must emit only the prepared capability");
        },
        async close() {}
      });
      const recoveryCapture = await regionalCapture(
        workspace,
        "obs_3123456789abcdef0123456789abcdef",
        new Date(capturedAt.getTime() + 4_000)
      );
      await assert.rejects(
        actRegion(
          workspace,
          runId,
          admittedPlan([
            { kind: "click", at: { x: 420, y: 318 } },
            { kind: "click", at: { x: 620, y: 318 } }
          ]),
          {
            createEffectId: () => effectId,
            now: () => new Date(capturedAt.getTime() + 2_000),
            openInputSession: async () => session,
            captureObservation: async () => {
              if (mode === "capture") throw new Error("private capture detail");
              return recoveryCapture;
            },
            publishOptions: mode === "publish" ? {
              createTransactionId: () => "invalid",
              now: () => new Date(capturedAt.getTime() + 5_000)
            } : undefined
          }
        ),
        (error: unknown) =>
          error instanceof ActPartialError &&
          error.message === "" &&
          error.code === (mode === "capture"
            ? "checkpoint_capture_failed"
            : "checkpoint_publish_failed")
      );
      const runDirectory = join(workspace, ".cu", runId);
      const journal = parseEffectJournalBytes(
        readFileSync(join(runDirectory, "effect-journal.json")),
        { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
      );
      assert.equal(journal.state, "partial");
      if (!("reason" in journal)) assert.fail("expected partial reason");
      assert.equal(
        journal.reason,
        mode === "capture" ? "checkpoint_capture_failed" : "checkpoint_publish_failed"
      );
      assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
      assert.equal(readdirSync(join(runDirectory, "captures")).length, 2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});
