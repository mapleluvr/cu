import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import mutableFs, {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import {
  beginEffectIntent,
  effectResolutionDescriptor,
  EffectAuthorityEnvironmentChangedError,
  EffectAuthorityExpiredError,
  EffectAuthorityInvalidError,
  EffectAuthorityUnavailableError,
  EffectAuthorityUncertainError,
  EffectJournalUnresolvedError,
  inspectActAuthority,
  inspectUnresolvedEffect,
  transitionEffectIntent,
  type EffectIntent
} from "../src/effect-store.js";
import { parseEffectJournalBytes } from "../src/effect-journal.js";
import { parseLiveObservationBytes } from "../src/observation-record.js";
import { publishCaptureObservation } from "../src/observation-archive.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const runId = "work-a";
const observationId = "obs_0123456789abcdef0123456789abcdef";
const effectId = "eff_0123456789abcdef0123456789abcdef";

test("projects stable live-record absence as unavailable without mutation", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-live-absent-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = join(workspace, ".cu", runId);
  const before = readFileSync(join(runDirectory, "run.json"));
  const lock = acquireRunLock(workspace, runId);
  try {
    await assert.rejects(
      inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      }),
      (error: unknown) =>
        error instanceof EffectAuthorityUnavailableError && error.message === ""
    );
    assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
    assert.deepEqual(readFileSync(join(runDirectory, "run.json")), before);
  } finally {
    lock.release();
  }
});

test("does not project absence when live evidence appears after the ENOENT sample", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-live-absence-race-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const livePath = join(workspace, ".cu", runId, "live-observation.json");
  const replacement = Buffer.from("{new-live-evidence", "utf8");
  const lock = acquireRunLock(workspace, runId);
  const lstatHooks = mutableFs as unknown as { lstatSync: typeof mutableFs.lstatSync };
  const originalLstat = lstatHooks.lstatSync;
  let injected = false;
  let liveLstatCalls = 0;
  let replacementStat: ReturnType<typeof originalLstat> | undefined;
  lstatHooks.lstatSync = ((path: Parameters<typeof originalLstat>[0], options?: Parameters<typeof originalLstat>[1]) => {
    if (basename(String(path)).toLowerCase() === "live-observation.json") {
      liveLstatCalls += 1;
      if (!injected) {
        injected = true;
        writeFileSync(livePath, replacement);
        replacementStat = originalLstat(path, options as never);
        throw Object.assign(new Error("sampled missing"), { code: "ENOENT" });
      }
      if (replacementStat !== undefined) return replacementStat;
    }
    return originalLstat(path, options as never);
  }) as typeof mutableFs.lstatSync;
  syncBuiltinESMExports();
  try {
    let actualError: unknown;
    try {
      await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
    } catch (error) {
      actualError = error;
    }
    assert.equal(injected, true);
    assert.equal(liveLstatCalls >= 2, true);
    assert.ok(
      actualError instanceof EffectAuthorityUncertainError && actualError.message === "",
      `expected uncertainty after ${liveLstatCalls} live lstat calls`
    );
    assert.deepEqual(readFileSync(livePath), replacement);
  } finally {
    lstatHooks.lstatSync = originalLstat;
    syncBuiltinESMExports();
    lock.release();
  }
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

async function seedActionableObservation(workspace: string, capturedAt: Date): Promise<void> {
  const image = pngBytes();
  const fingerprint = workspaceFingerprint(workspace);
  const sidecar = Buffer.from(`${JSON.stringify({
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: fingerprint,
    observationId,
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + 60_000).toISOString(),
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
  const lock = acquireRunLock(workspace, runId);
  try {
    await publishCaptureObservation(lock, workspace, runId, bundle, {
      now: () => new Date(capturedAt.getTime() + 1_000),
      createTransactionId: () => "txn_0123456789abcdef0123456789abcdef",
      createHistoryEventId: () => "hist_0123456789abcdef0123456789abcdef_1"
    });
  } finally {
    lock.release();
  }
}

function effectPlanFor(planObservationId = observationId) {
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId: planObservationId,
    coordinateSpace: "normalized_999_top_left",
    actions: [{ kind: "click", at: { x: 420, y: 318 } }]
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted action plan");
  return buildEffectSegmentPlan(admitted.plan, segmentActionPlan(admitted.plan));
}

function effectPlan() {
  return effectPlanFor();
}

test("publishes intent before consuming live and exposes only its recovery descriptor", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);

    const lock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const intent = beginEffectIntent(lock, workspace, runId, authority, {
        effectId,
        startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
        plan: effectPlan(),
        now: () => new Date(capturedAt.getTime() + 3_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });

      const runDirectory = join(workspace, ".cu", runId);
      const journalPath = join(runDirectory, "effect-journal.json");
      const livePath = join(runDirectory, "live-observation.json");
      const binding = { runId, workspaceFingerprint: workspaceFingerprint(workspace) };
      const journal = parseEffectJournalBytes(readFileSync(journalPath), binding);
      const live = parseLiveObservationBytes(readFileSync(livePath), binding);
      assert.equal(journal.state, "intent");
      assert.equal(journal.effectId, effectId);
      assert.equal(live.kind, "cu.live-observation/v1");
      if (live.kind !== "cu.live-observation/v1") assert.fail("expected bundle-bound live record");
      assert.equal(live.state, "consumed");
      if (live.state !== "consumed") assert.fail("expected consumed live record");
      assert.equal(live.consumedByEffectId, effectId);

      assert.deepEqual(effectResolutionDescriptor(intent), {
        effectId,
        journalSha256: sha256(readFileSync(journalPath))
      });
      assert.equal(existsSync(journalPath), true);
      assert.equal(parseLiveObservationBytes(readFileSync(livePath), binding).kind, "cu.live-observation/v1");
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects byte-identical live replacement across owned journal staging", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    const runDirectory = join(workspace, ".cu", runId);
    const livePath = join(runDirectory, "live-observation.json");
    const displacedPath = `${livePath}.displaced`;
    const liveBytes = readFileSync(livePath);
    const authority = await inspectActAuthority(lock, workspace, runId, {
      observationId,
      now: () => new Date(capturedAt.getTime() + 2_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64)
    });
    const originalOpen = mutableFs.openSync;
    let injected = false;
    mutableFs.openSync = ((path, flags, mode) => {
      const descriptor = originalOpen(path, flags, mode);
      if (!injected && basename(String(path)).startsWith("@tmp-")) {
        injected = true;
        renameSync(livePath, displacedPath);
        mutableFs.writeFileSync(livePath, liveBytes);
      }
      return descriptor;
    }) as typeof mutableFs.openSync;
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => beginEffectIntent(lock, workspace, runId, authority, {
          effectId,
          startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
          plan: effectPlan(),
          now: () => new Date(capturedAt.getTime() + 3_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectAuthorityUncertainError
      );
      assert.equal(injected, true);
      assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
      assert.deepEqual(readFileSync(livePath), liveBytes);
      assert.deepEqual(readFileSync(displacedPath), liveBytes);
    } finally {
      mutableFs.openSync = originalOpen;
      syncBuiltinESMExports();
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const evidenceKind of ["sidecar", "png"] as const) {
  for (const phase of ["post_rename", "post_installed_revalidation"] as const) {
    test(`rejects byte-identical ${evidenceKind} replacement ${phase}`, async () => {
      const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
      const capturedAt = new Date();
      try {
        initializeWorkspace(workspace);
        ensureRun(workspace, runId);
        await seedActionableObservation(workspace, capturedAt);
        const lock = acquireRunLock(workspace, runId);
        const runDirectory = join(workspace, ".cu", runId);
        const livePath = join(runDirectory, "live-observation.json");
        const evidencePath = join(
          runDirectory,
          "captures",
          `${observationId}.${evidenceKind === "sidecar" ? "json" : "png"}`
        );
        const displacedPath = `${evidencePath}.${phase}.displaced`;
        const evidenceBytes = readFileSync(evidencePath);
        const authority = await inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 2_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        const originalRename = mutableFs.renameSync;
        const lstatHooks = mutableFs as unknown as { lstatSync: typeof mutableFs.lstatSync };
        const originalLstat = lstatHooks.lstatSync;
        let liveRenamed = false;
        let injected = false;
        const replaceEvidence = () => {
          injected = true;
          originalRename(evidencePath, displacedPath);
          mutableFs.writeFileSync(evidencePath, evidenceBytes);
        };
        mutableFs.renameSync = ((oldPath, newPath) => {
          originalRename(oldPath, newPath);
          if (!liveRenamed && basename(String(newPath)).toLowerCase() === "live-observation.json") {
            liveRenamed = true;
            if (phase === "post_rename") replaceEvidence();
          }
        }) as typeof mutableFs.renameSync;
        lstatHooks.lstatSync = ((path, options) => {
          try {
            return originalLstat(path, options as never);
          } catch (error) {
            if (
              phase === "post_installed_revalidation" &&
              liveRenamed &&
              !injected &&
              basename(String(path)).toLowerCase() === "archive-transaction.json"
            ) {
              replaceEvidence();
            }
            throw error;
          }
        }) as typeof lstatHooks.lstatSync;
        syncBuiltinESMExports();
        try {
          assert.throws(
            () => beginEffectIntent(lock, workspace, runId, authority, {
              effectId,
              startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
              plan: effectPlan(),
              now: () => new Date(capturedAt.getTime() + 3_000),
              environmentFingerprint: "b".repeat(64),
              topologyFingerprint: "c".repeat(64)
            }),
            (error: unknown) => error instanceof EffectAuthorityUncertainError && error.message === ""
          );
          assert.equal(liveRenamed, true);
          assert.equal(injected, true);
          assert.deepEqual(readFileSync(evidencePath), evidenceBytes);
          assert.deepEqual(readFileSync(displacedPath), evidenceBytes);
        } finally {
          mutableFs.renameSync = originalRename;
          lstatHooks.lstatSync = originalLstat;
          syncBuiltinESMExports();
          lock.release();
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}

test("requires a final joint journal, consumed-live, archive-absence, and lock proof", async () => {
  for (const mode of ["journal_removed", "archive_appeared", "lock_lost"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const lock = acquireRunLock(workspace, runId);
      const runDirectory = join(workspace, ".cu", runId);
      const livePath = join(runDirectory, "live-observation.json");
      const journalPath = join(runDirectory, "effect-journal.json");
      const archivePath = join(runDirectory, "archive-transaction.json");
      const ownerPath = join(workspace, ".cu", "@locks", runId, "owner.json");
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const originalRename = mutableFs.renameSync;
      let injected = false;
      mutableFs.renameSync = ((oldPath, newPath) => {
        originalRename(oldPath, newPath);
        if (!injected && basename(String(newPath)).toLowerCase() === "live-observation.json") {
          injected = true;
          if (mode === "journal_removed") mutableFs.unlinkSync(journalPath);
          if (mode === "archive_appeared") mutableFs.writeFileSync(archivePath, "{}\n", "utf8");
          if (mode === "lock_lost") mutableFs.writeFileSync(ownerPath, "{}\n", "utf8");
        }
      }) as typeof mutableFs.renameSync;
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => beginEffectIntent(lock, workspace, runId, authority, {
            effectId,
            startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
            plan: effectPlan(),
            now: () => new Date(capturedAt.getTime() + 3_000),
            environmentFingerprint: "b".repeat(64),
            topologyFingerprint: "c".repeat(64)
          }),
          (error: unknown) => error instanceof EffectAuthorityUncertainError && error.message === ""
        );
        assert.equal(injected, true);
        const live = parseLiveObservationBytes(readFileSync(livePath), {
          runId,
          workspaceFingerprint: workspaceFingerprint(workspace)
        });
        assert.equal(live.kind, "cu.live-observation/v1");
        assert.equal(live.kind === "cu.live-observation/v1" && live.state, "consumed");
      } finally {
        mutableFs.renameSync = originalRename;
        syncBuiltinESMExports();
        try {
          lock.release();
        } catch {
          // Persistent lock-loss evidence intentionally prevents normal release.
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("tombstones expired and environment-changed live authority before exposing a no-effect phase", async () => {
  for (const scenario of [
    {
      expected: EffectAuthorityExpiredError,
      capturedAt: new Date(Date.now() - 61_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      invalidatedReason: "expired"
    },
    {
      expected: EffectAuthorityEnvironmentChangedError,
      capturedAt: new Date(),
      environmentFingerprint: "d".repeat(64),
      topologyFingerprint: "c".repeat(64),
      invalidatedReason: "environment_changed"
    }
  ] as const) {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, scenario.capturedAt);
      const lock = acquireRunLock(workspace, runId);
      try {
        await assert.rejects(
          () => inspectActAuthority(lock, workspace, runId, {
            observationId,
            now: () => new Date(),
            environmentFingerprint: scenario.environmentFingerprint,
            topologyFingerprint: scenario.topologyFingerprint
          }),
          scenario.expected
        );
        const live = parseLiveObservationBytes(readFileSync(
          join(workspace, ".cu", runId, "live-observation.json")
        ), { runId, workspaceFingerprint: workspaceFingerprint(workspace) });
        assert.equal(live.kind, "cu.live-observation-tombstone/v1");
        if (live.kind !== "cu.live-observation-tombstone/v1") assert.fail("expected tombstone");
        assert.equal(live.invalidatedReason, scenario.invalidatedReason);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("does not tombstone when journal evidence appears during invalidation staging", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date(Date.now() - 61_000);
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    const runDirectory = join(workspace, ".cu", runId);
    const livePath = join(runDirectory, "live-observation.json");
    const journalPath = join(runDirectory, "effect-journal.json");
    const originalLive = readFileSync(livePath);
    const originalOpen = mutableFs.openSync;
    let injected = false;
    mutableFs.openSync = ((path, flags, mode) => {
      const descriptor = originalOpen(path, flags, mode);
      if (!injected && basename(String(path)).startsWith("@tmp-")) {
        injected = true;
        mutableFs.writeFileSync(journalPath, "{}\n", "utf8");
      }
      return descriptor;
    }) as typeof mutableFs.openSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectAuthorityUncertainError
      );
      assert.equal(injected, true);
      assert.deepEqual(readFileSync(livePath), originalLive);
      assert.deepEqual(readFileSync(journalPath), Buffer.from("{}\n", "utf8"));
    } finally {
      mutableFs.openSync = originalOpen;
      syncBuiltinESMExports();
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects a persistent run-directory replacement before minting act authority", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    const runDirectory = join(workspace, ".cu", runId);
    const displacedDirectory = `${runDirectory}.displaced`;
    const canonicalWorkspace = mutableFs.realpathSync.native(workspace);
    const originalRealpath = mutableFs.realpathSync;
    let rootRealpaths = 0;
    let injected = false;
    const wrappedRealpath = ((path: Parameters<typeof originalRealpath>[0], options?: unknown) =>
      originalRealpath(path, options as never)) as typeof originalRealpath;
    wrappedRealpath.native = ((path: Parameters<typeof originalRealpath.native>[0], options?: unknown) => {
      const result = originalRealpath.native(path, options as never);
      if (resolve(String(path)).toLowerCase() === canonicalWorkspace.toLowerCase()) {
        rootRealpaths += 1;
        if (!injected && rootRealpaths === 3) {
          renameSync(runDirectory, displacedDirectory);
          cpSync(displacedDirectory, runDirectory, { recursive: true });
          injected = true;
        }
      }
      return result;
    }) as typeof originalRealpath.native;
    mutableFs.realpathSync = wrappedRealpath;
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 2_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectAuthorityInvalidError
      );
      assert.equal(injected, true);
      assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
    } finally {
      mutableFs.realpathSync = originalRealpath;
      syncBuiltinESMExports();
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("binds act authority and in-process intent to the exact opaque lock", async () => {
  for (const mode of ["authority", "intent"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const firstLock = acquireRunLock(workspace, runId);
      const authority = await inspectActAuthority(firstLock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 1_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const intent = mode === "intent"
        ? beginEffectIntent(firstLock, workspace, runId, authority, {
            effectId,
            startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
            plan: effectPlan(),
            now: () => new Date(capturedAt.getTime() + 2_000),
            environmentFingerprint: "b".repeat(64),
            topologyFingerprint: "c".repeat(64)
          })
        : undefined;
      firstLock.release();
      const secondLock = acquireRunLock(workspace, runId);
      try {
        if (mode === "authority") {
          assert.throws(
            () => beginEffectIntent(secondLock, workspace, runId, authority, {
              effectId,
              startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
              plan: effectPlan(),
              now: () => new Date(capturedAt.getTime() + 2_000),
              environmentFingerprint: "b".repeat(64),
              topologyFingerprint: "c".repeat(64)
            }),
            EffectAuthorityInvalidError
          );
          assert.equal(existsSync(join(workspace, ".cu", runId, "effect-journal.json")), false);
        } else {
          assert.notEqual(intent, undefined);
          assert.throws(
            () => transitionEffectIntent(secondLock, workspace, runId, intent!, {
              state: "partial",
              reason: "input_unproven",
              stateChangedAt: new Date(capturedAt.getTime() + 3_000).toISOString()
            }),
            EffectAuthorityInvalidError
          );
          const journal = parseEffectJournalBytes(
            readFileSync(join(workspace, ".cu", runId, "effect-journal.json")),
            { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
          );
          assert.equal(journal.state, "intent");
        }
      } finally {
        secondLock.release();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("rechecks expiry and environment at begin and tombstones before journal publication", async () => {
  for (const scenario of [
    {
      expected: EffectAuthorityExpiredError,
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      beginOffsetMs: 61_000,
      invalidatedReason: "expired"
    },
    {
      expected: EffectAuthorityEnvironmentChangedError,
      environmentFingerprint: "d".repeat(64),
      topologyFingerprint: "c".repeat(64),
      beginOffsetMs: 3_000,
      invalidatedReason: "environment_changed"
    }
  ] as const) {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const lock = acquireRunLock(workspace, runId);
      try {
        const authority = await inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 2_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        assert.throws(
          () => beginEffectIntent(lock, workspace, runId, authority, {
            effectId,
            startedAt: new Date(capturedAt.getTime() + scenario.beginOffsetMs).toISOString(),
            plan: effectPlan(),
            now: () => new Date(capturedAt.getTime() + scenario.beginOffsetMs),
            environmentFingerprint: scenario.environmentFingerprint,
            topologyFingerprint: scenario.topologyFingerprint
          } as Parameters<typeof beginEffectIntent>[4]),
          scenario.expected
        );
        const runDirectory = join(workspace, ".cu", runId);
        assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
        const live = parseLiveObservationBytes(readFileSync(join(runDirectory, "live-observation.json")), {
          runId,
          workspaceFingerprint: workspaceFingerprint(workspace)
        });
        assert.equal(live.kind, "cu.live-observation-tombstone/v1");
        if (live.kind !== "cu.live-observation-tombstone/v1") assert.fail("expected tombstone");
        assert.equal(live.invalidatedReason, scenario.invalidatedReason);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("rejects an admitted segment bound to another observation before journal publication", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      assert.throws(
        () => beginEffectIntent(lock, workspace, runId, authority, {
          effectId,
          startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
          plan: effectPlanFor("obs_fedcba9876543210fedcba9876543210"),
          now: () => new Date(capturedAt.getTime() + 3_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectAuthorityInvalidError
      );
      assert.throws(
        () => beginEffectIntent(lock, workspace, runId, authority, {
          effectId,
          startedAt: new Date(capturedAt.getTime() + 4_000).toISOString(),
          plan: effectPlan(),
          now: () => new Date(capturedAt.getTime() + 4_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectAuthorityInvalidError
      );
      const runDirectory = join(workspace, ".cu", runId);
      assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
      const live = parseLiveObservationBytes(readFileSync(join(runDirectory, "live-observation.json")), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(live.kind, "cu.live-observation/v1");
      assert.equal(live.kind === "cu.live-observation/v1" && live.state, "actionable");
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses journal transition after the exact consumed live is replaced by old actionable bytes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const livePath = join(workspace, ".cu", runId, "live-observation.json");
    const actionableBytes = readFileSync(livePath);
    const lock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 1_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const intent = beginEffectIntent(lock, workspace, runId, authority, {
        effectId,
        startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
        plan: effectPlan(),
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      mutableFs.writeFileSync(livePath, actionableBytes);
      assert.throws(
        () => transitionEffectIntent(lock, workspace, runId, intent, {
          state: "partial",
          reason: "input_unproven",
          stateChangedAt: new Date(capturedAt.getTime() + 3_000).toISOString()
        }),
        EffectAuthorityUncertainError
      );
      const journal = parseEffectJournalBytes(
        readFileSync(join(workspace, ".cu", runId, "effect-journal.json")),
        { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
      );
      assert.equal(journal.state, "intent");
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const evidenceKind of ["sidecar", "png"] as const) {
  test(`refuses journal transition after byte-identical ${evidenceKind} replacement`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const lock = acquireRunLock(workspace, runId);
      try {
        const authority = await inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 1_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        const intent = beginEffectIntent(lock, workspace, runId, authority, {
          effectId,
          startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
          plan: effectPlan(),
          now: () => new Date(capturedAt.getTime() + 2_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        const runDirectory = join(workspace, ".cu", runId);
        const evidencePath = join(
          runDirectory,
          "captures",
          `${observationId}.${evidenceKind === "sidecar" ? "json" : "png"}`
        );
        const displacedPath = `${evidencePath}.transition.displaced`;
        const evidenceBytes = readFileSync(evidencePath);
        renameSync(evidencePath, displacedPath);
        mutableFs.writeFileSync(evidencePath, evidenceBytes);
        assert.throws(
          () => transitionEffectIntent(lock, workspace, runId, intent, {
            state: "partial",
            reason: "input_unproven",
            stateChangedAt: new Date(capturedAt.getTime() + 3_000).toISOString()
          }),
          (error: unknown) => error instanceof EffectAuthorityUncertainError && error.message === ""
        );
        const journal = parseEffectJournalBytes(
          readFileSync(join(runDirectory, "effect-journal.json")),
          { runId, workspaceFingerprint: workspaceFingerprint(workspace) }
        );
        assert.equal(journal.state, "intent");
        assert.deepEqual(readFileSync(evidencePath), evidenceBytes);
        assert.deepEqual(readFileSync(displacedPath), evidenceBytes);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("maps an unavailable workspace root during transition to an empty typed failure", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 1_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const intent = beginEffectIntent(lock, workspace, runId, authority, {
        effectId,
        startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
        plan: effectPlan(),
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const missingRoot = join(workspace, "missing-root");
      assert.throws(
        () => transitionEffectIntent(lock, missingRoot, runId, intent, {
          state: "partial",
          reason: "input_unproven",
          stateChangedAt: new Date(capturedAt.getTime() + 3_000).toISOString()
        }),
        (error: unknown) => error instanceof EffectAuthorityInvalidError && error.message === ""
      );
      assert.equal(existsSync(join(workspace, ".cu", runId, "effect-journal.json")), true);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const evidenceKind of ["sidecar", "png"] as const) {
  test(`restart inspection rejects byte-identical ${evidenceKind} replacement between admissions`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
    const capturedAt = new Date();
    try {
      initializeWorkspace(workspace);
      ensureRun(workspace, runId);
      await seedActionableObservation(workspace, capturedAt);
      const lock = acquireRunLock(workspace, runId);
      const runDirectory = join(workspace, ".cu", runId);
      try {
        const authority = await inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 1_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        beginEffectIntent(lock, workspace, runId, authority, {
          effectId,
          startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
          plan: effectPlan(),
          now: () => new Date(capturedAt.getTime() + 2_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        });
        const evidencePath = join(
          runDirectory,
          "captures",
          `${observationId}.${evidenceKind === "sidecar" ? "json" : "png"}`
        );
        const imagePath = join(runDirectory, "captures", `${observationId}.png`);
        const displacedPath = `${evidencePath}.restart.displaced`;
        const evidenceBytes = readFileSync(evidencePath);
        const lstatHooks = mutableFs as unknown as { lstatSync: typeof mutableFs.lstatSync };
        const originalLstat = lstatHooks.lstatSync;
        let imageLstats = 0;
        let firstBundleProofComplete = false;
        let injected = false;
        lstatHooks.lstatSync = ((path, options) => {
          try {
            const result = originalLstat(path, options as never);
            if (basename(String(path)).toLowerCase() === basename(imagePath).toLowerCase()) {
              imageLstats += 1;
              if (imageLstats === 5) firstBundleProofComplete = true;
            }
            return result;
          } catch (error) {
            if (
              firstBundleProofComplete &&
              !injected &&
              basename(String(path)).toLowerCase() === "archive-transaction.json"
            ) {
              injected = true;
              renameSync(evidencePath, displacedPath);
              mutableFs.writeFileSync(evidencePath, evidenceBytes);
            }
            throw error;
          }
        }) as typeof lstatHooks.lstatSync;
        syncBuiltinESMExports();
        try {
          assert.throws(
            () => inspectUnresolvedEffect(lock, workspace, runId),
            (error: unknown) => error instanceof EffectAuthorityUncertainError && error.message === ""
          );
          assert.equal(injected, true);
          assert.deepEqual(readFileSync(evidencePath), evidenceBytes);
          assert.deepEqual(readFileSync(displacedPath), evidenceBytes);
        } finally {
          lstatHooks.lstatSync = originalLstat;
          syncBuiltinESMExports();
        }
      } finally {
        lock.release();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("retains an unresolved transition and exposes a distinct restart-only recovery capability", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-effect-store-"));
  const capturedAt = new Date();
  try {
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    await seedActionableObservation(workspace, capturedAt);
    const lock = acquireRunLock(workspace, runId);
    try {
      const authority = await inspectActAuthority(lock, workspace, runId, {
        observationId,
        now: () => new Date(capturedAt.getTime() + 1_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });
      const intent = beginEffectIntent(lock, workspace, runId, authority, {
        effectId,
        startedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
        plan: effectPlan(),
        now: () => new Date(capturedAt.getTime() + 2_000),
        environmentFingerprint: "b".repeat(64),
        topologyFingerprint: "c".repeat(64)
      });

      transitionEffectIntent(lock, workspace, runId, intent, {
        state: "partial",
        reason: "input_unproven",
        stateChangedAt: new Date(capturedAt.getTime() + 3_000).toISOString()
      });
      const journalPath = join(workspace, ".cu", runId, "effect-journal.json");
      const journal = parseEffectJournalBytes(readFileSync(journalPath), {
        runId,
        workspaceFingerprint: workspaceFingerprint(workspace)
      });
      assert.equal(journal.state, "partial");
      assert.equal(journal.state === "partial" && journal.reason, "input_unproven");
      const archivePath = join(workspace, ".cu", runId, "archive-transaction.json");
      mutableFs.writeFileSync(archivePath, "{}\n", "utf8");
      assert.throws(
        () => inspectUnresolvedEffect(lock, workspace, runId),
        EffectAuthorityInvalidError
      );
      mutableFs.unlinkSync(archivePath);
      const unresolved = inspectUnresolvedEffect(lock, workspace, runId);
      assert.notEqual(unresolved, undefined);
      if (unresolved === undefined) assert.fail("expected unresolved effect");
      assert.deepEqual(effectResolutionDescriptor(unresolved), {
        effectId,
        journalSha256: sha256(readFileSync(journalPath))
      });
      assert.throws(
        () => transitionEffectIntent(lock, workspace, runId, unresolved as unknown as EffectIntent, {
          state: "partial",
          reason: "input_unproven",
          stateChangedAt: new Date(capturedAt.getTime() + 4_000).toISOString()
        }),
        EffectAuthorityInvalidError
      );
      assert.equal(existsSync(journalPath), true);
      await assert.rejects(
        () => inspectActAuthority(lock, workspace, runId, {
          observationId,
          now: () => new Date(capturedAt.getTime() + 5_000),
          environmentFingerprint: "b".repeat(64),
          topologyFingerprint: "c".repeat(64)
        }),
        EffectJournalUnresolvedError
      );
    } finally {
      lock.release();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
