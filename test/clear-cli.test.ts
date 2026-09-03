import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import {
  beginEffectIntent,
  finalizeCompletedEffectIntent,
  inspectActAuthority,
} from "../src/effect-store.js";
import { publishCaptureObservation } from "../src/observation-archive.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");
const runId = "work-a";
const observations = [
  "obs_0123456789abcdef0123456789abcdef",
  "obs_1123456789abcdef0123456789abcdef",
  "obs_2123456789abcdef0123456789abcdef",
] as const;

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-clear-cli-"));
}

function runCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

function onlyJson(stdout: string): Record<string, unknown> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  return JSON.parse(stdout) as Record<string, unknown>;
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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function imageBytes(seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, seed, 0, 0, 0, seed, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bundle(
  root: string,
  observationId: string,
  capturedAt: string,
  seed: number,
) {
  const image = imageBytes(seed);
  const metadata = Buffer.from(
    `${JSON.stringify({
      kind: "cu.capture/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: workspaceFingerprint(root),
      observationId,
      capturedAt,
      expiresAt: new Date(
        new Date(capturedAt).getTime() + 60_000,
      ).toISOString(),
      coordinateSpace: "normalized_999_top_left",
      source: {
        captureKind: "region",
        mapping: "normalized_endpoint_centers/v1",
        leftPx: 10,
        topPx: 20,
        widthPx: 2,
        heightPx: 1,
      },
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
      image: {
        mediaType: "image/png",
        sha256: sha256(image),
        byteLength: image.length,
        width: 2,
        height: 1,
      },
    })}\n`,
    "utf8",
  );
  return validateCaptureBundleBytes(metadata, image, {
    runId,
    workspaceFingerprint: workspaceFingerprint(root),
  });
}

async function seedThree(root: string): Promise<void> {
  const lock = acquireRunLock(root, runId);
  try {
    for (let index = 0; index < observations.length; index += 1) {
      const hex = `${index + 1}`.repeat(32);
      await publishCaptureObservation(
        lock,
        root,
        runId,
        await bundle(
          root,
          observations[index]!,
          `2026-07-25T10:0${index}:00.000Z`,
          80 + index,
        ),
        {
          createTransactionId: () => `txn_${hex}`,
          createHistoryEventId: (eventIndex) => `hist_${hex}_${eventIndex + 1}`,
          now: () => new Date(`2026-07-25T10:0${index}:05.000Z`),
        },
      );
    }
  } finally {
    lock.release();
  }
}

function snapshotRun(root: string): Record<string, string> {
  const runDirectory = join(root, ".cu", runId);
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
  const admitted = admitActionBytes(
    Buffer.from(
      JSON.stringify({
        kind: "cu.action/v1",
        observationId,
        coordinateSpace: "normalized_999_top_left",
        actions: [{ kind: "click", at: { x: 500, y: 500 } }],
      }),
      "utf8",
    ),
  );
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted action plan");
  return buildEffectSegmentPlan(
    admitted.plan,
    segmentActionPlan(admitted.plan),
  );
}

function usageFailure(result: ReturnType<typeof runCli>): void {
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "usage_invalid",
    message: "Invalid command invocation.",
    retryable: false,
  });
}

test("clear and clearall reject malformed argv before workspace effects", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invalid = [
    ["clear", "--json"],
    ["clear", "../escape", "2026-07-25T10:00:00.000Z", "--json"],
    ["clear", runId, "not-a-time", "--json"],
    ["clear", runId, "2026-07-25T10:00:00Z", "--json"],
    [
      "clear",
      runId,
      "2026-07-25T10:00:00.000Z",
      "2026-07-25T10:00:00.000Z",
      "--json",
    ],
    [
      "clear",
      runId,
      "2026-07-25T10:00:00.000Z",
      "2026-07-25T10:01:00.000Z",
      "extra",
      "--json",
    ],
    ["clearall", "--json"],
    ["clearall", runId, "extra", "--json"],
    ["clearall", runId, "--json", "--json"],
  ];
  for (const args of invalid) {
    usageFailure(runCli(root, ...args));
    assert.equal(existsSync(join(root, ".cu")), false, args.join(" "));
  }
});

test("clear applies a half-open range and clearall leaves only run.json", async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  await seedThree(root);
  const runDirectory = join(root, ".cu", runId);

  const cleared = runCli(
    root,
    "clear",
    runId,
    "2026-07-25T10:02:00.000Z",
    "--json",
  );
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(cleared.stderr, "");
  assert.deepEqual(onlyJson(cleared.stdout), {
    kind: "cu.clear.result/v1",
    runId,
    clearedCount: 2,
    invalidatedCurrent: false,
  });
  assert.deepEqual(readdirSync(join(runDirectory, "captures")).sort(), [
    `${observations[2]}.json`,
    `${observations[2]}.png`,
  ]);

  const clearedAll = runCli(root, "clearall", runId, "--json");
  assert.equal(clearedAll.status, 0, clearedAll.stderr);
  assert.equal(clearedAll.stderr, "");
  assert.deepEqual(onlyJson(clearedAll.stdout), {
    kind: "cu.clearall.result/v1",
    runId,
    clearedCount: 1,
  });
  assert.deepEqual(readdirSync(runDirectory), ["run.json"]);
});

test("clearall maps an exact held lock to run_busy without mutation", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  const runPath = join(root, ".cu", runId, "run.json");
  const before = readFileSync(runPath);
  const lock = acquireRunLock(root, runId);
  try {
    const result = runCli(root, "clearall", runId, "--json");
    assert.equal(result.status, 3);
    assert.equal(result.stderr, "");
    assert.deepEqual(onlyJson(result.stdout), {
      kind: "cu.error/v1",
      code: "run_busy",
      message: "Run is busy.",
      retryable: false,
    });
    assert.deepEqual(readFileSync(runPath), before);
    assert.deepEqual(readdirSync(join(root, ".cu", runId)), ["run.json"]);
  } finally {
    lock.release();
  }
});

test("clearall maps an active archive transaction without repair", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  const transactionPath = join(root, ".cu", runId, "archive-transaction.json");
  const bytes = Buffer.from(
    `${JSON.stringify({
      kind: "cu.archive-transaction/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: workspaceFingerprint(root),
      transactionId: "txn_0123456789abcdef0123456789abcdef",
      operation: "clear_all",
      state: "prepared",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:00:00.000Z",
      priorLive: null,
      movedBundles: [],
      historyEvents: [],
      payload: { deletesLiveRecord: true, selectedObservationIds: [] },
    })}\n`,
    "utf8",
  );
  writeFileSync(transactionPath, bytes);

  const result = runCli(root, "clearall", runId, "--json");
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "archive_recovery_required",
    message: "Observation archive requires recovery.",
    retryable: false,
  });
  assert.deepEqual(readFileSync(transactionPath), bytes);
});

test("clearall maps a valid unresolved effect without cleanup", async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  await seedThree(root);
  const lock = acquireRunLock(root, runId);
  try {
    const capturedAt = new Date("2026-07-25T10:02:00.000Z");
    const authority = await inspectActAuthority(lock, root, runId, {
      observationId: observations[2]!,
      now: () => new Date(capturedAt.getTime() + 2_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
    });
    beginEffectIntent(lock, root, runId, authority, {
      effectId: "eff_0123456789abcdef0123456789abcdef",
      startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
      plan: effectPlan(observations[2]!),
      now: () => new Date(capturedAt.getTime() + 3_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
    });
  } finally {
    lock.release();
  }
  const before = snapshotRun(root);
  const result = runCli(root, "clearall", runId, "--json");
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "effect_journal_unresolved",
    message: "An unresolved effect blocks this command.",
    retryable: false,
  });
  assert.deepEqual(snapshotRun(root), before);
});

test("clearall reports a consumed observation separately from an unresolved effect", async (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  await seedThree(root);
  const lock = acquireRunLock(root, runId);
  try {
    const capturedAt = new Date("2026-07-25T10:02:00.000Z");
    const authority = await inspectActAuthority(lock, root, runId, {
      observationId: observations[2]!,
      now: () => new Date(capturedAt.getTime() + 2_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
    });
    const intent = beginEffectIntent(lock, root, runId, authority, {
      effectId: "eff_1123456789abcdef0123456789abcdef",
      startedAt: new Date(capturedAt.getTime() + 3_000).toISOString(),
      plan: effectPlan(observations[2]!),
      now: () => new Date(capturedAt.getTime() + 3_000),
      environmentFingerprint: "b".repeat(64),
      topologyFingerprint: "c".repeat(64),
    });
    finalizeCompletedEffectIntent(lock, root, runId, intent);
  } finally {
    lock.release();
  }

  const result = runCli(root, "clearall", runId, "--json");
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "observation_consumed",
    message:
      "Current observation has been consumed; capture a new observation before cleanup.",
    retryable: true,
  });
});

test("clearall maps malformed effect evidence to effect_journal_invalid without cleanup", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeWorkspace(root);
  ensureRun(root, runId);
  const journalPath = join(root, ".cu", runId, "effect-journal.json");
  writeFileSync(journalPath, Buffer.from('{\\"malformed\\":true}\\n', "utf8"));
  const before = snapshotRun(root);
  const result = runCli(root, "clearall", runId, "--json");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(onlyJson(result.stdout), {
    kind: "cu.error/v1",
    code: "effect_journal_invalid",
    message: "Effect journal state is invalid.",
    retryable: false,
  });
  assert.deepEqual(snapshotRun(root), before);
});
