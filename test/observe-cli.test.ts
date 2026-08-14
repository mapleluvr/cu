import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { admitActionBytes, segmentActionPlan } from "../src/action-file.js";
import { buildEffectSegmentPlan } from "../src/effect-plan.js";
import {
  bindRegionSelectorToDisplay,
  deriveDisplayInventory
} from "../src/display.js";
import {
  beginEffectIntent,
  inspectActAuthority,
  transitionEffectIntent
} from "../src/effect-store.js";
import { parseHistoryEventBytes } from "../src/history-event.js";
import { ObservationArchiveQuotaError } from "../src/observation-archive.js";
import { parseCaptureSidecarBytes, parseLiveObservationBytes } from "../src/observation-record.js";
import {
  observeRegion,
  ObserveArchiveError,
  ObserveCaptureError,
  ObserveQuotaError
} from "../src/observe.js";
import { parseRegionSelector } from "../src/region.js";
import { acquireRunLock } from "../src/run-lock.js";
import { ensureRun } from "../src/run.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");
const runId = "work-a";
const observationId = "obs_0123456789abcdef0123456789abcdef";
const requestId = "req_0123456789abcdef0123456789abcdef";
const transactionId = "txn_0123456789abcdef0123456789abcdef";
const historyEventId = "hist_0123456789abcdef0123456789abcdef_1";

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 25, 50, 75]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeCaptureDependencies(
  image: Buffer,
  afterWrite?: () => void,
  captureObservationId = observationId,
  captureRequestId = requestId,
  capturedAt = new Date("2026-07-25T10:00:00.000Z"),
  topology: Readonly<{
    virtualScreen: Readonly<{ x: number; y: number; width: number; height: number }>;
    monitors: readonly Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
      primary: boolean;
    }>[];
  }> = {
    virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
    monitors: [{ x: 0, y: 0, width: 100, height: 100, primary: true }]
  }
) {
  return {
    createObservationId: () => captureObservationId,
    createRequestId: () => captureRequestId,
    createTempRoot: () => mkdtempSync(join(tmpdir(), "cu-observe-core-capture-")),
    now: () => capturedAt,
    executeHelper(requestText: string) {
      const request = JSON.parse(requestText) as {
        requestId: string;
        destinationPath: string;
      };
      writeFileSync(request.destinationPath, image, { flag: "wx" });
      afterWrite?.();
      return {
        status: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(`${JSON.stringify({
          kind: "cu.windows-capture.result/v1",
          requestId: request.requestId,
          destinationPath: request.destinationPath,
          sourceRectPx: { x: 10, y: 20, width: 1, height: 1 },
          ...topology,
          desktop: {
            interactive: true,
            connected: true,
            kind: "default",
            sessionId: 1,
            desktopName: "Default"
          },
          foreground: { windowHandle: "0x0000000000000001", processId: 42 },
          image: { sha256: sha256(image), byteLength: image.length, width: 1, height: 1 }
        })}\n`, "utf8")
      };
    }
  };
}

function runCli(workspace: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true
  });
}

test("observe orchestration holds one run through capture and durable publication", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-core-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const image = onePixelPng();

  const result = await observeRegion(
    workspace,
    runId,
    parseRegionSelector("pixel:10,20,1,1"),
    {
      captureDependencies: {
        createObservationId: () => observationId,
        createRequestId: () => requestId,
        createTempRoot: () => mkdtempSync(join(tmpdir(), "cu-observe-core-capture-")),
        now: () => new Date("2026-07-25T10:00:00.000Z"),
        executeHelper(requestText: string) {
          const request = JSON.parse(requestText) as {
            requestId: string;
            destinationPath: string;
          };
          writeFileSync(request.destinationPath, image, { flag: "wx" });
          return {
            status: 0,
            signal: null,
            stderr: Buffer.alloc(0),
            stdout: Buffer.from(`${JSON.stringify({
              kind: "cu.windows-capture.result/v1",
              requestId: request.requestId,
              destinationPath: request.destinationPath,
              sourceRectPx: { x: 10, y: 20, width: 1, height: 1 },
              virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
              monitors: [{ x: 0, y: 0, width: 100, height: 100, primary: true }],
              desktop: {
                interactive: true,
                connected: true,
                kind: "default",
                sessionId: 1,
                desktopName: "Default"
              },
              foreground: { windowHandle: "0x0000000000000001", processId: 42 },
              image: { sha256: sha256(image), byteLength: image.length, width: 1, height: 1 }
            })}\n`, "utf8")
          };
        }
      },
      publishOptions: {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      }
    }
  );

  assert.deepEqual(result, {
    kind: "cu.observe.result/v1",
    runId,
    observationId,
    imagePath: `.cu/${runId}/captures/${observationId}.png`,
    coordinateSpace: "normalized_999_top_left",
    capturedAt: "2026-07-25T10:00:00.000Z",
    expiresAt: "2026-07-25T10:01:00.000Z",
    actionable: true,
    evictedHistoryCount: 0
  });
  const runDirectory = join(workspace, ".cu", runId);
  const metadata = readFileSync(join(runDirectory, "captures", `${observationId}.json`));
  const live = parseLiveObservationBytes(readFileSync(join(runDirectory, "live-observation.json")), {
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace)
  });
  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") assert.fail("expected actionable live record");
  assert.equal(live.captureMetadataSha256, sha256(metadata));
  assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);

  const liveBeforeFailure = readFileSync(join(runDirectory, "live-observation.json"));
  const historyBeforeFailure = readFileSync(join(runDirectory, "history.ndjson"));
  const captureEntriesBeforeFailure = readdirSync(join(runDirectory, "captures")).sort();
  await assert.rejects(
    observeRegion(
      workspace,
      runId,
      parseRegionSelector("pixel:10,20,1,1"),
      {
        captureDependencies: {
          createObservationId: () => "obs_11111111111111111111111111111111",
          createRequestId: () => "req_11111111111111111111111111111111",
          createTempRoot: () => mkdtempSync(join(tmpdir(), "cu-observe-core-failed-capture-")),
          now: () => new Date("2026-07-25T10:00:10.000Z"),
          executeHelper: () => ({
            status: 1,
            signal: null,
            stderr: Buffer.from("sensitive helper failure", "utf8"),
            stdout: Buffer.alloc(0)
          })
        }
      }
    ),
    (error: unknown) => error instanceof ObserveCaptureError && error.message === ""
  );
  assert.deepEqual(readFileSync(join(runDirectory, "live-observation.json")), liveBeforeFailure);
  assert.deepEqual(readFileSync(join(runDirectory, "history.ndjson")), historyBeforeFailure);
  assert.deepEqual(readdirSync(join(runDirectory, "captures")).sort(), captureEntriesBeforeFailure);
  assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
});

test("observe preserves an unbound region on mirrored display placements", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-mirrored-region-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const result = await observeRegion(
    workspace,
    runId,
    parseRegionSelector("pixel:10,20,1,1"),
    {
      captureDependencies: fakeCaptureDependencies(
        onePixelPng(),
        undefined,
        observationId,
        requestId,
        new Date("2026-07-25T10:00:00.000Z"),
        {
          virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
          monitors: [
            { x: 0, y: 0, width: 100, height: 100, primary: true },
            { x: 0, y: 0, width: 100, height: 100, primary: false }
          ]
        }
      ),
      publishOptions: {
        createTransactionId: () => transactionId,
        createHistoryEventId: () => historyEventId,
        now: () => new Date("2026-07-25T10:00:05.000Z")
      }
    }
  );

  assert.equal(result.kind, "cu.observe.result/v1");
  assert.equal(result.observationId, observationId);
});

test("observe admits a branded display-bound region without changing its public receipt", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-display-bound-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const topology = {
    virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
    monitors: [{ x: 0, y: 0, width: 100, height: 100, primary: true }]
  } as const;
  const selector = bindRegionSelectorToDisplay(
    deriveDisplayInventory(topology).displays[0]!.displayId,
    parseRegionSelector("pixel:10,20,1,1")
  );

  const result = await observeRegion(workspace, runId, selector, {
    captureDependencies: fakeCaptureDependencies(onePixelPng()),
    publishOptions: {
      createTransactionId: () => transactionId,
      createHistoryEventId: () => historyEventId,
      now: () => new Date("2026-07-25T10:00:05.000Z")
    }
  });

  assert.equal(result.kind, "cu.observe.result/v1");
  assert.equal(result.observationId, observationId);
  assert.equal(Object.hasOwn(result, "displayId"), false);
});

test("fresh observe resolves an unresolved effect after new-live cutover without replay", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-effect-recovery-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const image = onePixelPng();
  const binding = { runId, workspaceFingerprint: workspaceFingerprint(workspace) };
  const selector = parseRegionSelector("pixel:10,20,1,1");
  await observeRegion(workspace, runId, selector, {
    captureDependencies: fakeCaptureDependencies(image),
    publishOptions: {
      createTransactionId: () => transactionId,
      createHistoryEventId: () => historyEventId,
      now: () => new Date("2026-07-25T10:00:05.000Z")
    }
  });

  const runDirectory = join(workspace, ".cu", runId);
  const capture = parseCaptureSidecarBytes(
    readFileSync(join(runDirectory, "captures", `${observationId}.json`)),
    binding
  );
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions: [{ kind: "click", at: { x: 500, y: 500 } }]
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected plan");
  const effectPlan = buildEffectSegmentPlan(admitted.plan, segmentActionPlan(admitted.plan));
  const effectId = "eff_0123456789abcdef0123456789abcdef";
  const lock = acquireRunLock(workspace, runId);
  try {
    const authority = await inspectActAuthority(lock, workspace, runId, {
      observationId,
      now: () => new Date("2026-07-25T10:00:06.000Z"),
      environmentFingerprint: capture.environmentFingerprint,
      topologyFingerprint: capture.topologyFingerprint
    });
    const intent = beginEffectIntent(lock, workspace, runId, authority, {
      effectId,
      startedAt: "2026-07-25T10:00:07.000Z",
      plan: effectPlan,
      now: () => new Date("2026-07-25T10:00:07.000Z"),
      environmentFingerprint: capture.environmentFingerprint,
      topologyFingerprint: capture.topologyFingerprint
    });
    transitionEffectIntent(lock, workspace, runId, intent, {
      state: "partial",
      reason: "input_unproven",
      stateChangedAt: "2026-07-25T10:00:08.000Z"
    });
  } finally {
    lock.release();
  }
  const journalPath = join(runDirectory, "effect-journal.json");
  assert.equal(existsSync(journalPath), true);
  const consumed = parseLiveObservationBytes(
    readFileSync(join(runDirectory, "live-observation.json")),
    binding
  );
  assert.equal(consumed.kind, "cu.live-observation/v1");
  if (consumed.kind !== "cu.live-observation/v1") assert.fail("expected consumed live");
  assert.equal(consumed.state, "consumed");

  const recoveryObservationId = "obs_1123456789abcdef0123456789abcdef";
  const recovered = await observeRegion(workspace, runId, selector, {
    captureDependencies: fakeCaptureDependencies(
      image,
      undefined,
      recoveryObservationId,
      "req_1123456789abcdef0123456789abcdef",
      new Date("2026-07-25T10:00:10.000Z")
    ),
    publishOptions: {
      createTransactionId: () => "txn_1123456789abcdef0123456789abcdef",
      createHistoryEventId: (index) =>
        `hist_1123456789abcdef0123456789abcdef_${index + 1}`,
      now: () => new Date("2026-07-25T10:00:15.000Z")
    }
  });

  assert.equal(recovered.observationId, recoveryObservationId);
  assert.equal(existsSync(journalPath), false);
  const newLive = parseLiveObservationBytes(
    readFileSync(join(runDirectory, "live-observation.json")),
    binding
  );
  assert.equal(newLive.kind, "cu.live-observation/v1");
  if (newLive.kind !== "cu.live-observation/v1") assert.fail("expected recovery live");
  assert.equal(newLive.state, "actionable");
  assert.equal(newLive.observationId, recoveryObservationId);
  const history = readFileSync(join(runDirectory, "history.ndjson"))
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => parseHistoryEventBytes(Buffer.from(line, "utf8"), binding));
  const effectEvent = history.at(-1);
  assert.equal(effectEvent?.eventType, "effect_recovered");
  if (effectEvent?.eventType !== "effect_recovered") assert.fail("expected recovery event");
  assert.equal(effectEvent.effectId, effectId);
  assert.equal(effectEvent.recoveryObservationId, recoveryObservationId);
});

test("observe maps lock-release uncertainty over a failed capture", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-core-release-uncertain-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const ownerPath = join(workspace, ".cu", "@locks", runId, "owner.json");
  const replacement = Buffer.from("altered lock owner\n", "utf8");

  await assert.rejects(
    observeRegion(
      workspace,
      runId,
      parseRegionSelector("pixel:10,20,1,1"),
      {
        captureDependencies: {
          createObservationId: () => observationId,
          createRequestId: () => requestId,
          createTempRoot: () => mkdtempSync(join(tmpdir(), "cu-observe-core-release-capture-")),
          now: () => new Date("2026-07-25T10:00:00.000Z"),
          executeHelper: () => {
            writeFileSync(ownerPath, replacement);
            return {
              status: 1,
              signal: null,
              stderr: Buffer.from("sensitive helper failure", "utf8"),
              stdout: Buffer.alloc(0)
            };
          }
        }
      }
    ),
    (error: unknown) => error instanceof ObserveArchiveError && error.message === ""
  );
  assert.deepEqual(readFileSync(ownerPath), replacement);
  const runDirectory = join(workspace, ".cu", runId);
  assert.equal(existsSync(join(runDirectory, "captures")), false);
  assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
  assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
});

test("observe maps a post-capture archive conflict without publication", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-core-publish-block-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const runDirectory = join(workspace, ".cu", runId);
  const activePath = join(runDirectory, "archive-transaction.json");
  const activeBytes = Buffer.from("concurrent unprovable transaction\n", "utf8");

  await assert.rejects(
    observeRegion(
      workspace,
      runId,
      parseRegionSelector("pixel:10,20,1,1"),
      {
        captureDependencies: fakeCaptureDependencies(onePixelPng(), () => {
          writeFileSync(activePath, activeBytes, { flag: "wx" });
        })
      }
    ),
    (error: unknown) => error instanceof ObserveArchiveError && error.message === ""
  );
  assert.deepEqual(readFileSync(activePath), activeBytes);
  assert.equal(existsSync(join(runDirectory, "captures")), false);
  assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
  assert.equal(existsSync(join(runDirectory, "history.ndjson")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
});

test("observe maps quota refusal without publication", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-core-quota-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  await assert.rejects(
    observeRegion(
      workspace,
      runId,
      parseRegionSelector("pixel:10,20,1,1"),
      {
        captureDependencies: fakeCaptureDependencies(onePixelPng()),
        publishOptions: {
          createTransactionId: () => {
            throw new ObservationArchiveQuotaError();
          }
        }
      }
    ),
    (error: unknown) => error instanceof ObserveQuotaError && error.message === ""
  );
  const runDirectory = join(workspace, ".cu", runId);
  assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
  assert.equal(existsSync(join(runDirectory, "captures")), false);
  assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
});

test("observe maps an uninitialized workspace before helper or archive effects", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-workspace-invalid-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const region of ["pixel:10,20,1,1", "normalized:100,200,300,400"]) {
    const result = runCli(workspace, "observe", runId, "--region", region, "--json");
    assert.equal(result.status, 1, region);
    assert.equal(result.stderr, "", region);
    assert.deepEqual(JSON.parse(result.stdout), {
      kind: "cu.error/v1",
      code: "workspace_invalid",
      message: "Workspace state cannot be used safely.",
      retryable: false
    });
    assert.deepEqual(readdirSync(workspace), []);
  }
});

test("observe reports run-lock contention as a blocked archive without capture", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-lock-busy-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  try {
    const result = runCli(workspace, "observe", runId, "--region", "pixel:10,20,1,1", "--json");
    assert.equal(result.status, 3);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      kind: "cu.error/v1",
      code: "archive_recovery_required",
      message: "Observation archive requires recovery.",
      retryable: false
    });
    const runDirectory = join(workspace, ".cu", runId);
    assert.equal(existsSync(join(runDirectory, "captures")), false);
    assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
    assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
  } finally {
    lock.release();
  }
});

test("observe blocks an unprovable active transaction before helper capture", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-recovery-block-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = join(workspace, ".cu", runId);
  const activePath = join(runDirectory, "archive-transaction.json");
  const activeBytes = Buffer.from("not a transaction\n", "utf8");
  writeFileSync(activePath, activeBytes, { flag: "wx" });

  const result = runCli(workspace, "observe", runId, "--region", "pixel:10,20,1,1", "--json");

  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "archive_recovery_required",
    message: "Observation archive requires recovery.",
    retryable: false
  });
  assert.deepEqual(readFileSync(activePath), activeBytes);
  assert.equal(existsSync(join(runDirectory, "captures")), false);
  assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
});

test("observe without a region blocks before workspace effects", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-no-region-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = runCli(workspace, "observe", runId, "--json");

  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "blocked_environment",
    message: "Full-desktop capture is unavailable in this environment.",
    retryable: false
  });
  assert.deepEqual(readdirSync(workspace), []);
});

test("observe rejects invalid option shapes before workspace effects", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-observe-cli-usage-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const invalid = [
    ["observe"],
    ["observe", "../escape", "--region", "pixel:1,2,3,4"],
    ["observe", runId, "--region"],
    ["observe", runId, "--region", "pixel:1,2,3,4", "--region", "pixel:1,2,3,4"],
    ["observe", runId, "--region", "pixel:1,2,3,4", "--json", "--json"],
    ["observe", runId, "--region", "pixel:1,2,3,4", "--unknown"],
    ["observe", runId, "--region", "pixel:01,2,3,4"],
    ["observe", runId, "--display", `dsp_${"0".repeat(32)}`],
    ["observe", runId, "--region", "pixel:1,2,3,4", "--display", "DISPLAY1"],
    ["observe", runId, "--region", "pixel:1,2,3,4", "--display", `dsp_${"0".repeat(32)}`, "--display", `dsp_${"1".repeat(32)}`]
  ];

  for (const args of invalid) {
    const result = runCli(workspace, ...args, "--json");
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
    assert.deepEqual(JSON.parse(result.stdout), {
      kind: "cu.error/v1",
      code: "usage_invalid",
      message: "Invalid command invocation.",
      retryable: false
    });
    assert.deepEqual(readdirSync(workspace), []);
  }
});
