import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bindRegionSelectorToDisplay,
  bindFullScreenSelectorToDisplays,
  deriveDisplayInventory,
  deriveTopologyFingerprint,
  DisplaySelectorError,
  DisplayTopologyError,
  isCaptureSelector,
  resolveCaptureSelector,
} from "../src/display.js";
import { parseRegionSelector } from "../src/region.js";
import {
  queryWindowsDisplays,
  WindowsDisplayError,
  type WindowsCaptureHelperExecution,
} from "../src/windows-capture.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");

const dualDisplayTopology = Object.freeze({
  virtualScreen: Object.freeze({ x: -1280, y: 0, width: 3200, height: 1080 }),
  monitors: Object.freeze([
    Object.freeze({
      x: -1280,
      y: 56,
      width: 1280,
      height: 1024,
      primary: false,
    }),
    Object.freeze({ x: 0, y: 0, width: 1920, height: 1080, primary: true }),
  ]),
});

const mirroredDisplayTopology = Object.freeze({
  virtualScreen: Object.freeze({ x: 0, y: 0, width: 100, height: 100 }),
  monitors: Object.freeze([
    Object.freeze({ x: 0, y: 0, width: 100, height: 100, primary: true }),
    Object.freeze({ x: 0, y: 0, width: 100, height: 100, primary: false }),
  ]),
});

function runCli(workspace: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("derives deterministic topology-bound identifiers for distinct display placements", () => {
  const first = deriveDisplayInventory(dualDisplayTopology);
  const repeated = deriveDisplayInventory(dualDisplayTopology);

  assert.deepEqual(repeated, first);
  assert.equal(first.kind, "cu.displays.result/v1");
  assert.equal(first.coordinateSpace, "virtual_screen_pixels");
  assert.match(first.topologyFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.virtualScreenPx, {
    x: -1280,
    y: 0,
    width: 3200,
    height: 1080,
  });
  assert.equal(first.displays.length, 2);
  assert.match(first.displays[0]!.displayId, /^dsp_[a-f0-9]{32}$/);
  assert.match(first.displays[1]!.displayId, /^dsp_[a-f0-9]{32}$/);
  assert.notEqual(first.displays[0]!.displayId, first.displays[1]!.displayId);
  assert.deepEqual(
    first.displays.map(({ boundsPx, primary }) => ({ boundsPx, primary })),
    [
      {
        boundsPx: { x: -1280, y: 56, width: 1280, height: 1024 },
        primary: false,
      },
      {
        boundsPx: { x: 0, y: 0, width: 1920, height: 1080 },
        primary: true,
      },
    ],
  );

  const changed = deriveDisplayInventory({
    virtualScreen: { x: -1280, y: 0, width: 3200, height: 1080 },
    monitors: [
      { x: -1280, y: 0, width: 1280, height: 1024, primary: false },
      { x: 0, y: 0, width: 1920, height: 1080, primary: true },
    ],
  });
  assert.notEqual(changed.topologyFingerprint, first.topologyFingerprint);
  assert.notEqual(changed.displays[0]!.displayId, first.displays[0]!.displayId);
});

test("rejects malformed or ambiguous topology before minting display identifiers", () => {
  const invalid = [
    {
      virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
      monitors: [{ x: 0, y: 0, width: 100, height: 100, primary: false }],
    },
    {
      virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
      monitors: [
        { x: 0, y: 0, width: 100, height: 100, primary: true },
        { x: 0, y: 0, width: 100, height: 100, primary: false },
      ],
    },
    {
      virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
      monitors: [{ x: 90, y: 0, width: 20, height: 100, primary: true }],
    },
  ];

  for (const topology of invalid) {
    assert.throws(() => deriveDisplayInventory(topology), DisplayTopologyError);
  }
});

test("preserves legacy unbound regions on mirrored display placements", () => {
  assert.deepEqual(
    resolveCaptureSelector(
      parseRegionSelector("pixel:10,20,5,6"),
      mirroredDisplayTopology,
    ),
    { x: 10, y: 20, width: 5, height: 6 },
  );
  assert.equal(
    deriveTopologyFingerprint(mirroredDisplayTopology),
    createHash("sha256")
      .update(JSON.stringify(mirroredDisplayTopology), "utf8")
      .digest("hex"),
  );
  assert.throws(
    () => deriveDisplayInventory(mirroredDisplayTopology),
    DisplayTopologyError,
  );
});

test("binds a regional selector to one exact display placement", () => {
  const inventory = deriveDisplayInventory(dualDisplayTopology);
  const selected = bindRegionSelectorToDisplay(
    inventory.displays[1]!.displayId,
    parseRegionSelector("pixel:20,30,100,80"),
  );

  assert.equal(isCaptureSelector(selected), true);
  assert.deepEqual(selected, {
    kind: "display_region",
    displayId: inventory.displays[1]!.displayId,
    region: { kind: "pixel", left: 20, top: 30, width: 100, height: 80 },
  });
  assert.deepEqual(resolveCaptureSelector(selected, dualDisplayTopology), {
    x: 20,
    y: 30,
    width: 100,
    height: 80,
  });
});

test("binds one or more exact displays for full-screen capture", () => {
  const inventory = deriveDisplayInventory(dualDisplayTopology);
  const selected = bindFullScreenSelectorToDisplays(
    inventory.displays.map(({ displayId }) => displayId),
  );

  assert.equal(isCaptureSelector(selected), true);
  assert.deepEqual(selected, {
    kind: "full_screen",
    displayIds: inventory.displays.map(({ displayId }) => displayId),
  });
  assert.deepEqual(resolveCaptureSelector(selected, dualDisplayTopology), {
    x: -1280,
    y: 0,
    width: 3200,
    height: 1080,
  });
  assert.deepEqual(
    resolveCaptureSelector(
      bindFullScreenSelectorToDisplays([inventory.displays[1]!.displayId]),
      dualDisplayTopology,
    ),
    inventory.displays[1]!.boundsPx,
  );
});
test("rejects stale display ids, cross-display regions, and structural selector forgeries", () => {
  const inventory = deriveDisplayInventory(dualDisplayTopology);
  const primaryId = inventory.displays[1]!.displayId;
  const stale = bindRegionSelectorToDisplay(
    primaryId,
    parseRegionSelector("pixel:20,30,100,80"),
  );
  const changedTopology = {
    virtualScreen: { x: -1280, y: 0, width: 3200, height: 1080 },
    monitors: [
      { x: -1280, y: 0, width: 1280, height: 1024, primary: false },
      { x: 0, y: 0, width: 1920, height: 1080, primary: true },
    ],
  };
  assert.throws(
    () => resolveCaptureSelector(stale, changedTopology),
    DisplaySelectorError,
  );

  const crossing = bindRegionSelectorToDisplay(
    primaryId,
    parseRegionSelector("pixel:-10,20,20,20"),
  );
  assert.throws(
    () => resolveCaptureSelector(crossing, dualDisplayTopology),
    DisplaySelectorError,
  );

  const fullVirtualScreen = bindRegionSelectorToDisplay(
    primaryId,
    parseRegionSelector("normalized:0,0,999,999"),
  );
  assert.throws(() =>
    resolveCaptureSelector(fullVirtualScreen, dualDisplayTopology),
  );

  assert.equal(
    isCaptureSelector({
      kind: "display_region",
      displayId: primaryId,
      region: parseRegionSelector("pixel:20,30,100,80"),
    }),
    false,
  );
});

test("queries a display snapshot through command TEMP and returns only public topology", () => {
  const root = mkdtempSync(join(tmpdir(), "cu-display-query-parent-"));
  let request: Record<string, unknown> | undefined;

  const result = queryWindowsDisplays({
    createRequestId: () => `req_${"1".repeat(32)}`,
    createTempRoot: () => root,
    executeHelper(requestText: string): WindowsCaptureHelperExecution {
      request = JSON.parse(requestText) as Record<string, unknown>;
      return {
        status: 0,
        signal: null,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          `${JSON.stringify({
            kind: "cu.windows-display.result/v1",
            requestId: request.requestId,
            virtualScreen: dualDisplayTopology.virtualScreen,
            monitors: dualDisplayTopology.monitors,
          })}\n`,
          "utf8",
        ),
      };
    },
    removeTempRoot: (path: string) =>
      rmSync(path, { recursive: true, force: true }),
  });

  assert.deepEqual(request, {
    kind: "cu.windows-display.request/v1",
    requestId: `req_${"1".repeat(32)}`,
  });
  assert.equal(result.kind, "cu.displays.result/v1");
  assert.equal(result.displays.length, 2);
  assert.equal(Object.hasOwn(result, "desktop"), false);
  assert.equal(Object.hasOwn(result, "foreground"), false);
  assert.equal(existsSync(root), false);
});

test("contains malformed display-helper output and cleanup uncertainty", () => {
  for (const mode of ["malformed", "cleanup"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cu-display-query-${mode}-`));
    const stdout =
      mode === "cleanup"
        ? Buffer.from(
            `${JSON.stringify({
              kind: "cu.windows-display.result/v1",
              requestId: `req_${"2".repeat(32)}`,
              virtualScreen: dualDisplayTopology.virtualScreen,
              monitors: dualDisplayTopology.monitors,
            })}\n`,
            "utf8",
          )
        : Buffer.from("{private malformed output\n", "utf8");
    assert.throws(
      () =>
        queryWindowsDisplays({
          createRequestId: () => `req_${"2".repeat(32)}`,
          createTempRoot: () => root,
          executeHelper: () => ({
            status: 0,
            signal: null,
            stderr: Buffer.alloc(0),
            stdout,
          }),
          removeTempRoot:
            mode === "cleanup"
              ? () => {
                  throw new Error("private cleanup path");
                }
              : (path: string) =>
                  rmSync(path, { recursive: true, force: true }),
        }),
      (error: unknown) =>
        error instanceof WindowsDisplayError && error.message === "",
      mode,
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("public displays reports topology without creating workspace state", {
  skip: process.platform !== "win32",
}, (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cu-displays-cli-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = runCli(workspace, "displays", "--json");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "coordinateSpace",
    "displays",
    "kind",
    "topologyFingerprint",
    "virtualScreenPx",
  ]);
  assert.equal(receipt.kind, "cu.displays.result/v1");
  assert.match(String(receipt.topologyFingerprint), /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(receipt.displays));
  assert.ok(receipt.displays.length >= 1);
  assert.equal(existsSync(join(workspace, ".cu")), false);
});
