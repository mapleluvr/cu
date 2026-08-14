import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { parseEffectJournalBytes } from "../src/effect-journal.js";
import { parseHistoryEventBytes, type HistoryEvent } from "../src/history-event.js";
import {
  parseLiveObservationBytes,
  validateBundleBoundLiveObservation
} from "../src/observation-record.js";
import { workspaceFingerprint } from "../src/workspace.js";
import {
  decodePngRgba,
  deriveControlledPatternColors,
  readControlledPattern,
  sampleRgb,
  startControlledWindowFixture,
  type ControlledWindowFixture
} from "./support/controlled-window.js";

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

function runInstalledCli(
  cliPath: string,
  workspace: string,
  args: readonly string[],
  input?: Buffer
) {
  if (process.platform !== "win32") {
    return spawnSync(cliPath, args, { cwd: workspace, encoding: "utf8", shell: false, input });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `${quoteForCmd(cliPath)} ${args.map(quoteForCmd).join(" ")}`],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      input
    }
  );
}

function parseOnlyJson(stdout: string): Record<string, unknown> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function writeAction(
  path: string,
  observationId: string,
  actions: readonly unknown[]
): void {
  writeFileSync(path, Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions
  }), "utf8"));
}

function readHistory(runDirectory: string, fingerprint: string): HistoryEvent[] {
  const bytes = readFileSync(join(runDirectory, "history.ndjson"));
  assert.equal(bytes.length > 0 && bytes[bytes.length - 1] === 0x0a, true);
  return bytes.subarray(0, -1).toString("utf8").split("\n").map((line) =>
    parseHistoryEventBytes(Buffer.from(line, "utf8"), {
      runId,
      workspaceFingerprint: fingerprint
    })
  );
}

function expectedPoint(
  fixture: ControlledWindowFixture,
  x: number,
  y: number
): Readonly<{ x: number; y: number }> {
  return {
    x: Math.floor((x * (fixture.target.width - 1)) / 999),
    y: Math.floor((y * (fixture.target.height - 1)) / 999)
  };
}

function assertOneControlledClick(
  events: Awaited<ReturnType<ControlledWindowFixture["snapshotAndClear"]>>,
  expected: Readonly<{ x: number; y: number }>
): void {
  assert.deepEqual(events.decoy, []);
  assert.equal(events.target.length, 1);
  const event = events.target[0]!;
  assert.deepEqual(
    { kind: event.kind, button: event.button, count: event.count },
    { kind: "click", button: "left", count: 1 }
  );
  assert.equal(Math.abs(event.x - expected.x) <= 8, true);
  assert.equal(Math.abs(event.y - expected.y) <= 8, true);
}

function tempRoots(prefix: string): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).sort();
}

async function validateActionableCapture(
  workspace: string,
  fixture: ControlledWindowFixture,
  observationId: string,
  receipt: Record<string, unknown>
) {
  const runDirectory = join(workspace, ".cu", runId);
  const metadata = readFileSync(join(runDirectory, "captures", `${observationId}.json`));
  const image = readFileSync(join(runDirectory, "captures", `${observationId}.png`));
  const fingerprint = workspaceFingerprint(workspace);
  const bundle = await validateCaptureBundleBytes(metadata, image, {
    runId,
    workspaceFingerprint: fingerprint
  });
  const live = parseLiveObservationBytes(
    readFileSync(join(runDirectory, "live-observation.json")),
    { runId, workspaceFingerprint: fingerprint }
  );
  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") assert.fail("expected actionable live");
  validateBundleBoundLiveObservation(live, bundle.capture, bundle.captureMetadataSha256);
  assert.equal(live.state, "actionable");
  assert.equal(receipt.observationId, observationId);
  assert.equal(receipt.imagePath, `.cu/${runId}/captures/${observationId}.png`);
  assert.equal(receipt.capturedAt, bundle.capture.capturedAt);
  assert.equal(receipt.expiresAt, bundle.capture.expiresAt);
  assert.equal(receipt.capturedAt, live.capturedAt);
  assert.equal(receipt.expiresAt, live.expiresAt);
  assert.deepEqual(bundle.capture.source, {
    captureKind: "region",
    mapping: "normalized_endpoint_centers/v1",
    leftPx: fixture.target.x,
    topPx: fixture.target.y,
    widthPx: fixture.target.width,
    heightPx: fixture.target.height
  });

  const decoded = decodePngRgba(image);
  const pattern = readControlledPattern();
  const colors = deriveControlledPatternColors(fixture.token);
  assert.equal(decoded.width, fixture.target.width);
  assert.equal(decoded.height, fixture.target.height);
  for (const [index, sample] of pattern.samples.entries()) {
    assert.deepEqual(sampleRgb(decoded, sample.x, sample.y), colors.target[index]);
    assert.notDeepEqual(sampleRgb(decoded, sample.x, sample.y), colors.decoy[index]);
  }
  return { bundle, fingerprint, live };
}

function assertSteadyState(workspace: string): void {
  const runDirectory = join(workspace, ".cu", runId);
  assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
  assert.equal(existsSync(join(runDirectory, "effect-journal.json")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
  assert.equal(
    existsSync(join(runDirectory, "@archive"))
      ? readdirSync(join(runDirectory, "@archive")).length
      : 0,
    0
  );
}

test(
  "installed cu act emits only controlled target effects, checkpoints, and never replays unresolved input",
  { skip: process.platform !== "win32", concurrency: false },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cu-act-public-e2e-"));
    const packDirectory = join(root, "pack");
    const installDirectory = join(root, "install");
    const workspace = join(root, "workspace");
    const beforeCaptureTemps = tempRoots("cu-capture-");
    const beforeInputTemps = tempRoots("cu-input-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const path of [packDirectory, installDirectory, workspace]) {
      mkdirSync(path, { recursive: true });
    }

    const packed = runNpm(repositoryRoot, ["pack", "--pack-destination", packDirectory]);
    assert.equal(packed.status, 0, packed.stderr);
    const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const installed = runNpm(installDirectory, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packDirectory, tarballs[0]!)
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    const installedRoot = join(installDirectory, "node_modules", "cu");
    const cliPath = join(installDirectory, "node_modules", ".bin", "cu.cmd");
    assert.equal(existsSync(join(installedRoot, "dist", "src", "cli.js")), true);
    assert.equal(existsSync(cliPath), true);

    const initialized = runInstalledCli(cliPath, workspace, ["init", "--json"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.deepEqual(parseOnlyJson(initialized.stdout), {
      kind: "cu.init.result/v1",
      created: true
    });

    const fixture = await startControlledWindowFixture();
    t.after(async () => fixture.stop());
    const region = `pixel:${fixture.target.x},${fixture.target.y},${fixture.target.width},${fixture.target.height}`;
    const observe = () => {
      const result = runInstalledCli(cliPath, workspace, [
        "observe", runId, "--region", region, "--json"
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const receipt = parseOnlyJson(result.stdout);
      assert.deepEqual(Object.keys(receipt).sort(), [
        "actionable", "capturedAt", "coordinateSpace", "evictedHistoryCount",
        "expiresAt", "imagePath", "kind", "observationId", "runId"
      ]);
      assert.equal(receipt.kind, "cu.observe.result/v1");
      return receipt;
    };

    await fixture.waitForQuiet();
    const firstObservation = observe();
    const firstObservationId = String(firstObservation.observationId);
    await validateActionableCapture(workspace, fixture, firstObservationId, firstObservation);
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });

    const completedAction = join(root, "completed-action.json");
    writeAction(completedAction, firstObservationId, [
      { kind: "click", at: { x: 500, y: 500 } }
    ]);
    await fixture.waitForQuiet();
    const completed = runInstalledCli(cliPath, workspace, [
      "act", runId, "--action-file", completedAction, "--json"
    ]);
    assert.equal(completed.status, 0, `${completed.stderr}\n${completed.stdout}`);
    assert.equal(completed.stderr, "");
    assert.deepEqual(parseOnlyJson(completed.stdout), {
      kind: "cu.act.result/v1",
      runId,
      outcome: "completed",
      emittedActionCount: 1,
      emittedLeafActionCount: 1,
      unexecutedActionCount: 0
    });
    const center = expectedPoint(fixture, 500, 500);
    assertOneControlledClick(await fixture.snapshotAndClear(), center);
    assertSteadyState(workspace);

    await fixture.waitForQuiet();
    const secondObservation = observe();
    const secondObservationId = String(secondObservation.observationId);
    await validateActionableCapture(workspace, fixture, secondObservationId, secondObservation);
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });

    const privateTail = "private-unexecuted-tail";
    const checkpointAction = join(root, "checkpoint-action.json");
    writeAction(checkpointAction, secondObservationId, [
      { kind: "click", at: { x: 250, y: 750 } },
      { kind: "click", at: { x: 750, y: 250 } },
      { kind: "type_text", text: privateTail }
    ]);
    await fixture.waitForQuiet();
    const checkpoint = runInstalledCli(cliPath, workspace, [
      "act", runId, "--action-file", checkpointAction, "--json"
    ]);
    assert.equal(checkpoint.status, 0, `${checkpoint.stderr}\n${checkpoint.stdout}`);
    assert.equal(checkpoint.stderr, "");
    const checkpointReceipt = parseOnlyJson(checkpoint.stdout);
    assert.deepEqual(Object.keys(checkpointReceipt).sort(), [
      "checkpoint", "emittedActionCount", "emittedLeafActionCount", "kind",
      "outcome", "runId", "unexecutedActionCount"
    ]);
    assert.equal(checkpointReceipt.kind, "cu.act.result/v1");
    assert.equal(checkpointReceipt.runId, runId);
    assert.equal(checkpointReceipt.outcome, "checkpoint");
    assert.equal(checkpointReceipt.emittedActionCount, 1);
    assert.equal(checkpointReceipt.emittedLeafActionCount, 1);
    assert.equal(checkpointReceipt.unexecutedActionCount, 2);
    assert.doesNotMatch(checkpoint.stdout, new RegExp(privateTail));
    const checkpointObservation = checkpointReceipt.checkpoint as Record<string, unknown>;
    assert.deepEqual(Object.keys(checkpointObservation).sort(), [
      "actionable", "capturedAt", "coordinateSpace", "evictedHistoryCount",
      "expiresAt", "imagePath", "observationId"
    ]);
    assert.equal(checkpointObservation.actionable, true);
    assert.equal(checkpointObservation.evictedHistoryCount, 0);
    const checkpointObservationId = String(checkpointObservation.observationId);
    const checkpointState = await validateActionableCapture(
      workspace,
      fixture,
      checkpointObservationId,
      checkpointObservation
    );
    const quarter = expectedPoint(fixture, 250, 750);
    assertOneControlledClick(await fixture.snapshotAndClear(), quarter);
    assertSteadyState(workspace);
    const runDirectory = join(workspace, ".cu", runId);
    const checkpointHistory = readHistory(runDirectory, checkpointState.fingerprint);
    const retained = checkpointHistory.filter((event) => event.eventType === "capture_retained");
    const recovered = checkpointHistory.filter((event) => event.eventType === "effect_recovered");
    assert.equal(retained.length, 3);
    assert.equal(recovered.length, 1);
    const retainedCheckpoint = retained.at(-1)!;
    assert.equal(retainedCheckpoint.eventType, "capture_retained");
    if (retainedCheckpoint.eventType !== "capture_retained") assert.fail("expected retained event");
    assert.equal(retainedCheckpoint.observationId, checkpointObservationId);
    assert.equal(retainedCheckpoint.capturedAt, checkpointState.bundle.capture.capturedAt);
    assert.equal(retainedCheckpoint.transactionId, checkpointState.live.publishedByTransactionId);
    const recoveredCheckpoint = recovered[0]!;
    assert.equal(recoveredCheckpoint.eventType, "effect_recovered");
    if (recoveredCheckpoint.eventType !== "effect_recovered") assert.fail("expected recovery event");
    assert.equal(recoveredCheckpoint.recoveryObservationId, checkpointObservationId);
    assert.equal(recoveredCheckpoint.transactionId, checkpointState.live.publishedByTransactionId);

    await fixture.waitForQuiet();
    const blocked = runInstalledCli(cliPath, workspace, [
      "act", runId, "--action-file", checkpointAction, "--json"
    ]);
    assert.equal(blocked.status, 3);
    assert.deepEqual(parseOnlyJson(blocked.stdout), {
      kind: "cu.error/v1",
      code: "observation_unavailable",
      message: "No matching actionable observation is available.",
      retryable: false
    });
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });

    await fixture.waitForQuiet();
    const fourthObservation = observe();
    const fourthObservationId = String(fourthObservation.observationId);
    const fourthState = await validateActionableCapture(
      workspace,
      fixture,
      fourthObservationId,
      fourthObservation
    );
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });

    const workerPath = join(root, "derived-uncertainty-worker.mjs");
    const moduleUrl = (name: string) => pathToFileURL(
      join(installedRoot, "dist", "src", `${name}.js`)
    ).href;
    writeFileSync(workerPath, [
      `import { admitActionBytes } from ${JSON.stringify(moduleUrl("action-file"))};`,
      `import { actRegion, ActPartialError } from ${JSON.stringify(moduleUrl("act"))};`,
      `import { WindowsInputError } from ${JSON.stringify(moduleUrl("windows-input"))};`,
      `const planResult = admitActionBytes(Buffer.from(${JSON.stringify(JSON.stringify({
        kind: "cu.action/v1",
        observationId: fourthObservationId,
        coordinateSpace: "normalized_999_top_left",
        actions: [{ kind: "click", at: { x: 500, y: 500 } }]
      }))}, "utf8"));`,
      `if (!planResult.ok) process.exit(80);`,
      `const token = Object.freeze({});`,
      `const session = Object.freeze({`,
      `  environmentFingerprint: ${JSON.stringify(fourthState.bundle.capture.environmentFingerprint)},`,
      `  topologyFingerprint: ${JSON.stringify(fourthState.bundle.capture.topologyFingerprint)},`,
      `  prepareSegment() { return token; },`,
      `  async emitPrepared(value) { if (value !== token) process.exit(81); throw new WindowsInputError("input_unproven"); },`,
      `  async emitSegment() { process.exit(82); },`,
      `  async close() {}`,
      `});`,
      `try {`,
      `  await actRegion(${JSON.stringify(workspace)}, ${JSON.stringify(runId)}, planResult.plan, {`,
      `    createEffectId: () => "eff_abcdef0123456789abcdef0123456789",`,
      `    openInputSession: async () => session`,
      `  });`,
      `} catch (error) {`,
      `  if (error instanceof ActPartialError && error.code === "input_unproven") process.exit(91);`,
      `}`,
      `process.exit(83);`
    ].join("\n"), "utf8");
    const worker = spawnSync(process.execPath, [workerPath], {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(worker.status, 91, `${worker.stdout}\n${worker.stderr}`);
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
    const journalPath = join(runDirectory, "effect-journal.json");
    const journal = parseEffectJournalBytes(readFileSync(journalPath), {
      runId,
      workspaceFingerprint: fourthState.fingerprint
    });
    assert.equal(journal.state, "partial");
    if (!("reason" in journal)) assert.fail("expected partial journal reason");
    assert.equal(journal.reason, "input_unproven");
    assert.equal(journal.observation.observationId, fourthObservationId);
    assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);

    const unresolvedAction = join(root, "unresolved-action.json");
    writeAction(unresolvedAction, fourthObservationId, [
      { kind: "click", at: { x: 500, y: 500 } }
    ]);
    const livePath = join(runDirectory, "live-observation.json");
    const displacedLivePath = join(runDirectory, "@displaced-live-evidence");
    renameSync(livePath, displacedLivePath);
    const corruptAct = runInstalledCli(cliPath, workspace, [
      "act", runId, "--action-file", unresolvedAction, "--json"
    ]);
    assert.equal(corruptAct.status, 1);
    assert.deepEqual(parseOnlyJson(corruptAct.stdout), {
      kind: "cu.error/v1",
      code: "effect_journal_invalid",
      message: "Effect journal state is invalid.",
      retryable: false
    });
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
    renameSync(displacedLivePath, livePath);

    await fixture.waitForQuiet();
    const secondAct = runInstalledCli(cliPath, workspace, [
      "act", runId, "--action-file", unresolvedAction, "--json"
    ]);
    assert.equal(secondAct.status, 3);
    assert.deepEqual(parseOnlyJson(secondAct.stdout), {
      kind: "cu.error/v1",
      code: "effect_journal_unresolved",
      message: "An unresolved effect blocks this action.",
      retryable: false
    });
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });

    await fixture.waitForQuiet();
    const recoveryObservation = observe();
    const recoveryObservationId = String(recoveryObservation.observationId);
    const recoveryState = await validateActionableCapture(
      workspace,
      fixture,
      recoveryObservationId,
      recoveryObservation
    );
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
    assert.equal(existsSync(journalPath), false);
    assertSteadyState(workspace);
    const finalHistory = readHistory(runDirectory, recoveryState.fingerprint);
    const finalEvent = finalHistory.at(-1)!;
    assert.equal(finalEvent.eventType, "effect_recovered");
    if (finalEvent.eventType !== "effect_recovered") assert.fail("expected effect recovery");
    assert.equal(finalEvent.effectId, "eff_abcdef0123456789abcdef0123456789");
    assert.equal(finalEvent.recoveryObservationId, recoveryObservationId);
    assert.equal(finalEvent.transactionId, recoveryState.live.publishedByTransactionId);

    assert.deepEqual(tempRoots("cu-capture-"), beforeCaptureTemps);
    assert.deepEqual(tempRoots("cu-input-"), beforeInputTemps);
  }
);
