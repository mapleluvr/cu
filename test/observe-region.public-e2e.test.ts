import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateCaptureBundleBytes } from "../src/capture-bundle.js";
import { parseHistoryEventBytes } from "../src/history-event.js";
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
  startControlledWindowFixture
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

function runInstalledCli(cliPath: string, workspace: string, args: readonly string[]) {
  if (process.platform !== "win32") {
    return spawnSync(cliPath, args, { cwd: workspace, encoding: "utf8", shell: false });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `${quoteForCmd(cliPath)} ${args.map(quoteForCmd).join(" ")}`],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true
    }
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test(
  "installed cu observe publishes only the controlled target as actionable evidence",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "cu-observe-public-e2e-"));
    const packDirectory = join(root, "pack");
    const installDirectory = join(root, "install");
    const workspace = join(root, "workspace");
    const beforeTemp = readdirSync(tmpdir()).filter((name) => name.startsWith("cu-capture-")).sort();
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
    const cliTarget = join(installDirectory, "node_modules", "cu", "dist", "src", "cli.js");
    const cliPath = join(installDirectory, "node_modules", ".bin", "cu.cmd");
    assert.equal(existsSync(cliTarget), true, "packed public CLI target must exist");
    assert.equal(existsSync(cliPath), true, "installed public CLI shim must exist");

    const displayQuery = runInstalledCli(cliPath, workspace, ["displays", "--json"]);
    assert.equal(displayQuery.status, 0, displayQuery.stderr);
    assert.equal(displayQuery.stderr, "");
    const displayReceipt = JSON.parse(displayQuery.stdout) as {
      kind: string;
      topologyFingerprint: string;
      coordinateSpace: string;
      virtualScreenPx: { x: number; y: number; width: number; height: number };
      displays: Array<{
        displayId: string;
        boundsPx: { x: number; y: number; width: number; height: number };
        primary: boolean;
      }>;
    };
    assert.deepEqual(Object.keys(displayReceipt).sort(), [
      "coordinateSpace",
      "displays",
      "kind",
      "topologyFingerprint",
      "virtualScreenPx"
    ]);
    assert.equal(displayReceipt.kind, "cu.displays.result/v1");
    assert.equal(displayReceipt.coordinateSpace, "virtual_screen_pixels");
    assert.match(displayReceipt.topologyFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(displayReceipt.displays.length >= 1);
    assert.equal(existsSync(join(workspace, ".cu")), false);

    const initialized = runInstalledCli(cliPath, workspace, ["init", "--json"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.deepEqual(JSON.parse(initialized.stdout), {
      kind: "cu.init.result/v1",
      created: true
    });

    const fixture = await startControlledWindowFixture();
    t.after(async () => fixture.stop());
    const selectedDisplay = displayReceipt.displays.find(({ boundsPx }) => (
      fixture.target.x >= boundsPx.x &&
      fixture.target.y >= boundsPx.y &&
      fixture.target.x + fixture.target.width <= boundsPx.x + boundsPx.width &&
      fixture.target.y + fixture.target.height <= boundsPx.y + boundsPx.height
    ));
    assert.notEqual(selectedDisplay, undefined, "controlled target must fit one reported display");
    assert.match(selectedDisplay!.displayId, /^dsp_[a-f0-9]{32}$/);
    const region = `pixel:${fixture.target.x},${fixture.target.y},${fixture.target.width},${fixture.target.height}`;
    const observed = runInstalledCli(cliPath, workspace, [
      "observe",
      runId,
      "--region",
      region,
      "--display",
      selectedDisplay!.displayId,
      "--json"
    ]);
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(observed.stderr, "");
    const receipt = JSON.parse(observed.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(receipt).sort(), [
      "actionable",
      "capturedAt",
      "coordinateSpace",
      "evictedHistoryCount",
      "expiresAt",
      "imagePath",
      "kind",
      "observationId",
      "runId"
    ]);
    assert.equal(receipt.kind, "cu.observe.result/v1");
    assert.equal(receipt.runId, runId);
    assert.match(String(receipt.observationId), /^obs_[a-f0-9]{32}$/);
    assert.equal(receipt.imagePath, `.cu/${runId}/captures/${String(receipt.observationId)}.png`);
    assert.equal(receipt.coordinateSpace, "normalized_999_top_left");
    assert.match(String(receipt.capturedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.match(String(receipt.expiresAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(receipt.actionable, true);
    assert.equal(receipt.evictedHistoryCount, 0);

    const runDirectory = join(workspace, ".cu", runId);
    const observationId = String(receipt.observationId);
    const metadataPath = join(runDirectory, "captures", `${observationId}.json`);
    const imagePath = join(runDirectory, "captures", `${observationId}.png`);
    const metadata = readFileSync(metadataPath);
    const image = readFileSync(imagePath);
    const fingerprint = workspaceFingerprint(workspace);
    const bundle = await validateCaptureBundleBytes(metadata, image, {
      runId,
      workspaceFingerprint: fingerprint
    });
    assert.equal(bundle.capture.observationId, observationId);
    assert.equal(bundle.capture.image.sha256, sha256(image));
    assert.equal(bundle.capture.image.byteLength, image.length);
    assert.equal(bundle.capture.image.width, fixture.target.width);
    assert.equal(bundle.capture.image.height, fixture.target.height);
    assert.deepEqual(bundle.capture.source, {
      captureKind: "region",
      mapping: "normalized_endpoint_centers/v1",
      leftPx: fixture.target.x,
      topPx: fixture.target.y,
      widthPx: fixture.target.width,
      heightPx: fixture.target.height
    });
    assert.match(bundle.capture.environmentFingerprint, /^[a-f0-9]{64}$/);
    assert.match(bundle.capture.topologyFingerprint, /^[a-f0-9]{64}$/);

    const liveBytes = readFileSync(join(runDirectory, "live-observation.json"));
    const live = parseLiveObservationBytes(liveBytes, {
      runId,
      workspaceFingerprint: fingerprint
    });
    assert.equal(live.kind, "cu.live-observation/v1");
    if (live.kind !== "cu.live-observation/v1") assert.fail("expected actionable live record");
    validateBundleBoundLiveObservation(live, bundle.capture, bundle.captureMetadataSha256);
    assert.equal(live.observationId, observationId);
    assert.equal(live.captureMetadataSha256, sha256(metadata));
    assert.equal(live.state, "actionable");
    assert.equal(receipt.capturedAt, bundle.capture.capturedAt);
    assert.equal(receipt.expiresAt, bundle.capture.expiresAt);
    assert.equal(receipt.capturedAt, live.capturedAt);
    assert.equal(receipt.expiresAt, live.expiresAt);

    const historyBytes = readFileSync(join(runDirectory, "history.ndjson"));
    const historyLines = historyBytes.subarray(0, historyBytes.length - 1).toString("utf8").split("\n");
    assert.equal(historyLines.length, 1);
    const historyEvent = parseHistoryEventBytes(Buffer.from(historyLines[0]!, "utf8"), {
      runId,
      workspaceFingerprint: fingerprint
    });
    assert.equal(historyEvent.eventType, "capture_retained");
    if (historyEvent.eventType !== "capture_retained") assert.fail("expected retained history event");
    assert.equal(historyEvent.observationId, observationId);
    assert.equal(historyEvent.capturedAt, bundle.capture.capturedAt);
    assert.equal(historyEvent.transactionId, live.publishedByTransactionId);
    assert.deepEqual(readdirSync(join(runDirectory, "captures")).sort(), [
      `${observationId}.json`,
      `${observationId}.png`
    ]);

    const decoded = decodePngRgba(image);
    const pattern = readControlledPattern();
    const colors = deriveControlledPatternColors(fixture.token);
    assert.equal(decoded.width, fixture.target.width);
    assert.equal(decoded.height, fixture.target.height);
    for (const [index, sample] of pattern.samples.entries()) {
      assert.deepEqual(sampleRgb(decoded, sample.x, sample.y), colors.target[index]);
      assert.notDeepEqual(sampleRgb(decoded, sample.x, sample.y), colors.decoy[index]);
    }

    assert.equal(existsSync(join(runDirectory, "archive-transaction.json")), false);
    assert.equal(existsSync(join(workspace, ".cu", "@locks", runId)), false);
    assert.equal(
      existsSync(join(runDirectory, "@archive"))
        ? readdirSync(join(runDirectory, "@archive")).length
        : 0,
      0
    );
    assert.deepEqual(readdirSync(runDirectory).sort(), [
      "@archive",
      "captures",
      "history.ndjson",
      "live-observation.json",
      "run.json"
    ]);
    assert.deepEqual(
      readdirSync(tmpdir()).filter((name) => name.startsWith("cu-capture-")).sort(),
      beforeTemp
    );
  }
);
