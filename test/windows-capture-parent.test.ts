import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { copyValidatedCaptureBundleBytes } from "../src/capture-bundle.js";
import {
  bindRegionSelectorToDisplay,
  deriveDisplayInventory
} from "../src/display.js";
import {
  RegionSelectorError,
  parseRegionSelector,
  resolveRegionSelector
} from "../src/region.js";
import {
  captureRegionalObservation,
  WindowsCaptureError,
  type WindowsCaptureHelperExecution
} from "../src/windows-capture.js";

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

function helperResult(
  requestId: string,
  destinationPath: string,
  png: Buffer,
  sourceRectPx: Readonly<{ x: number; y: number; width: number; height: number }>
): object {
  return {
    kind: "cu.windows-capture.result/v1",
    requestId,
    destinationPath,
    sourceRectPx,
    virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
    monitors: [{ x: 0, y: 0, width: 100, height: 100, primary: true }],
    desktop: {
      interactive: true,
      connected: true,
      kind: "default",
      sessionId: 1,
      desktopName: "Default"
    },
    foreground: { windowHandle: "0x0000000000001234", processId: 123 },
    image: {
      sha256: createHash("sha256").update(png).digest("hex"),
      byteLength: png.length,
      width: 2,
      height: 1
    }
  };
}

const virtualScreen = { x: -1920, y: 0, width: 3840, height: 1080 } as const;

function helperStdout(value: object): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

test("parses exact normalized and pixel region selector forms", () => {
  assert.deepEqual(parseRegionSelector("normalized:100,200,800,700"), {
    kind: "normalized",
    left: 100,
    top: 200,
    right: 800,
    bottom: 700
  });
  assert.deepEqual(parseRegionSelector("pixel:-120,40,400,300"), {
    kind: "pixel",
    left: -120,
    top: 40,
    width: 400,
    height: 300
  });
});

test("maps inclusive normalized endpoint centers into one half-open virtual-screen rectangle", () => {
  const selector = parseRegionSelector("normalized:250,250,749,749");

  assert.deepEqual(resolveRegionSelector(selector, virtualScreen), {
    x: -960,
    y: 270,
    width: 1920,
    height: 540
  });
});

test("admits one helper result into an owned exact capture bundle and removes command TEMP", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-test-"));
  const image = pngBytes();
  const imageSha256 = createHash("sha256").update(image).digest("hex");
  let helperRequest: Record<string, unknown> | undefined;
  const executeHelper = (requestText: string): WindowsCaptureHelperExecution => {
    helperRequest = JSON.parse(requestText) as Record<string, unknown>;
    const destinationPath = String(helperRequest.destinationPath);
    writeFileSync(destinationPath, image, { flag: "wx" });
    return {
      status: 0,
      signal: null,
      stdout: helperStdout({
        kind: "cu.windows-capture.result/v1",
        requestId: helperRequest.requestId,
        destinationPath,
        sourceRectPx: { x: 10, y: 20, width: 2, height: 1 },
        virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
        monitors: [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }],
        desktop: {
          interactive: true,
          connected: true,
          kind: "default",
          sessionId: 1,
          desktopName: "Default"
        },
        foreground: { windowHandle: "0x0000000000001234", processId: 42 },
        image: { sha256: imageSha256, byteLength: image.length, width: 2, height: 1 }
      }),
      stderr: Buffer.alloc(0)
    };
  };

  const captured = await captureRegionalObservation(
    {
      selector: parseRegionSelector("pixel:10,20,2,1"),
      runId: "work-a",
      workspaceFingerprint: "a".repeat(64)
    },
    {
      createObservationId: () => "obs_0123456789abcdef0123456789abcdef",
      createRequestId: () => "req_0123456789abcdef0123456789abcdef",
      createTempRoot: () => root,
      executeHelper,
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      removeTempRoot: (path: string) => rmSync(path, { recursive: true, force: true })
    }
  );

  assert.equal(helperRequest?.kind, "cu.windows-capture.request/v1");
  assert.deepEqual(helperRequest?.selector, {
    kind: "pixel",
    left: 10,
    top: 20,
    width: 2,
    height: 1
  });
  assert.equal(captured.observationId, "obs_0123456789abcdef0123456789abcdef");
  assert.equal(captured.capturedAt, "2026-07-25T10:00:00.000Z");
  assert.equal(captured.expiresAt, "2026-07-25T10:01:00.000Z");
  const expectedTopologyFingerprint = createHash("sha256")
    .update(JSON.stringify({
      virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
      monitors: [{ x: 0, y: 0, width: 1920, height: 1080, primary: true }]
    }))
    .digest("hex");
  assert.equal(captured.topologyFingerprint, expectedTopologyFingerprint);
  assert.equal(
    captured.environmentFingerprint,
    createHash("sha256")
      .update(JSON.stringify({
        topologyFingerprint: expectedTopologyFingerprint,
        desktop: {
          interactive: true,
          connected: true,
          kind: "default",
          sessionId: 1,
          desktopName: "Default"
        },
        foreground: { windowHandle: "0x0000000000001234", processId: 42 }
      }))
      .digest("hex")
  );
  const copied = copyValidatedCaptureBundleBytes(captured.bundle);
  assert.deepEqual(copied.image, image);
  const sidecar = JSON.parse(copied.captureMetadata.toString("utf8")) as Record<string, unknown>;
  assert.equal(sidecar.observationId, captured.observationId);
  assert.deepEqual(sidecar.source, {
    captureKind: "region",
    mapping: "normalized_endpoint_centers/v1",
    leftPx: 10,
    topPx: 20,
    widthPx: 2,
    heightPx: 1
  });
  assert.deepEqual(sidecar.image, {
    mediaType: "image/png",
    sha256: imageSha256,
    byteLength: image.length,
    width: 2,
    height: 1
  });
  assert.equal(copied.captureMetadata.includes(Buffer.from("0x0000000000001234")), false);
  assert.equal(existsSync(root), false);
});

test("admits a region only when the helper topology preserves its selected display", async () => {
  const topology = {
    virtualScreen: { x: 0, y: 0, width: 200, height: 100 },
    monitors: [
      { x: 0, y: 0, width: 100, height: 100, primary: true },
      { x: 100, y: 0, width: 100, height: 100, primary: false }
    ]
  } as const;
  const displayId = deriveDisplayInventory(topology).displays[1]!.displayId;
  const selector = bindRegionSelectorToDisplay(
    displayId,
    parseRegionSelector("pixel:110,20,2,1")
  );
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-display-bound-"));
  const image = pngBytes();
  let helperRequest: Record<string, unknown> | undefined;

  const captured = await captureRegionalObservation(
    {
      selector,
      runId: "work-a",
      workspaceFingerprint: "1".repeat(64)
    },
    {
      createObservationId: () => `obs_${"1".repeat(32)}`,
      createRequestId: () => `req_${"1".repeat(32)}`,
      createTempRoot: () => root,
      executeHelper(requestText: string): WindowsCaptureHelperExecution {
        helperRequest = JSON.parse(requestText) as Record<string, unknown>;
        const destinationPath = String(helperRequest.destinationPath);
        writeFileSync(destinationPath, image, { flag: "wx" });
        return {
          status: 0,
          signal: null,
          stderr: Buffer.alloc(0),
          stdout: helperStdout({
            kind: "cu.windows-capture.result/v1",
            requestId: helperRequest.requestId,
            destinationPath,
            sourceRectPx: { x: 110, y: 20, width: 2, height: 1 },
            ...topology,
            desktop: {
              interactive: true,
              connected: true,
              kind: "default",
              sessionId: 1,
              desktopName: "Default"
            },
            foreground: { windowHandle: "0x0000000000001234", processId: 42 },
            image: {
              sha256: createHash("sha256").update(image).digest("hex"),
              byteLength: image.length,
              width: 2,
              height: 1
            }
          })
        };
      },
      removeTempRoot: (path: string) => rmSync(path, { recursive: true, force: true })
    }
  );

  assert.deepEqual(helperRequest?.selector, {
    kind: "display_region",
    displayId,
    region: { kind: "pixel", left: 110, top: 20, width: 2, height: 1 }
  });
  assert.deepEqual(captured.sourceRectPx, { x: 110, y: 20, width: 2, height: 1 });
  assert.equal(existsSync(root), false);
});

test("rejects a helper capture produced under a topology that makes the display id stale", async () => {
  const requestedTopology = {
    virtualScreen: { x: 0, y: 0, width: 200, height: 100 },
    monitors: [
      { x: 0, y: 0, width: 100, height: 100, primary: true },
      { x: 100, y: 0, width: 100, height: 100, primary: false }
    ]
  } as const;
  const selector = bindRegionSelectorToDisplay(
    deriveDisplayInventory(requestedTopology).displays[1]!.displayId,
    parseRegionSelector("pixel:110,20,2,1")
  );
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-stale-display-"));
  const image = pngBytes();

  await assert.rejects(
    captureRegionalObservation(
      {
        selector,
        runId: "work-a",
        workspaceFingerprint: "2".repeat(64)
      },
      {
        createObservationId: () => `obs_${"2".repeat(32)}`,
        createRequestId: () => `req_${"2".repeat(32)}`,
        createTempRoot: () => root,
        executeHelper(requestText: string): WindowsCaptureHelperExecution {
          const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
          writeFileSync(request.destinationPath, image, { flag: "wx" });
          return {
            status: 0,
            signal: null,
            stderr: Buffer.alloc(0),
            stdout: helperStdout({
              kind: "cu.windows-capture.result/v1",
              requestId: request.requestId,
              destinationPath: request.destinationPath,
              sourceRectPx: { x: 110, y: 20, width: 2, height: 1 },
              virtualScreen: { x: 0, y: 0, width: 200, height: 100 },
              monitors: [{ x: 0, y: 0, width: 200, height: 100, primary: true }],
              desktop: {
                interactive: true,
                connected: true,
                kind: "default",
                sessionId: 1,
                desktopName: "Default"
              },
              foreground: { windowHandle: "0x0000000000001234", processId: 42 },
              image: {
                sha256: createHash("sha256").update(image).digest("hex"),
                byteLength: image.length,
                width: 2,
                height: 1
              }
            })
          };
        },
        removeTempRoot: (path: string) => rmSync(path, { recursive: true, force: true })
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(existsSync(root), false);
});

test("rejects a helper source rectangle that does not match the parent selector mapping", async () => {
  const png = pngBytes();
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-mismatch-"));
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: parseRegionSelector("pixel:0,0,2,1"),
        runId: "work-a",
        workspaceFingerprint: "c".repeat(64)
      },
      {
        createObservationId: () => `obs_${"3".repeat(32)}`,
        createRequestId: () => `req_${"4".repeat(32)}`,
        createTempRoot: () => root,
        executeHelper(requestText: string): WindowsCaptureHelperExecution {
          const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
          writeFileSync(request.destinationPath, png, { flag: "wx" });
          return {
            status: 0,
            signal: null,
            stderr: Buffer.alloc(0),
            stdout: helperStdout(helperResult(request.requestId, request.destinationPath, png, {
              x: 1,
              y: 0,
              width: 2,
              height: 1
            }))
          };
        }
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(existsSync(root), false);
});

test("refuses a missing runtime selector before helper or TEMP side effects", async () => {
  let createdTemp = 0;
  let helperCalls = 0;
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: undefined as never,
        runId: "work-a",
        workspaceFingerprint: "f".repeat(64)
      },
      {
        createTempRoot() {
          createdTemp += 1;
          return mkdtempSync(join(tmpdir(), "cu-windows-capture-missing-selector-"));
        },
        executeHelper() {
          helperCalls += 1;
          throw new Error("must not execute");
        }
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(createdTemp, 0);
  assert.equal(helperCalls, 0);
});

test("contains helper diagnostics and removes TEMP on helper failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-error-"));
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: parseRegionSelector("pixel:0,0,2,1"),
        runId: "work-a",
        workspaceFingerprint: "e".repeat(64)
      },
      {
        createTempRoot: () => root,
        executeHelper(): WindowsCaptureHelperExecution {
          return {
            status: 3,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("private helper path and target title", "utf8")
          };
        }
      }
    ),
    (error: unknown) =>
      error instanceof WindowsCaptureError &&
      error.message === "" &&
      !String(error).includes("private helper")
  );
  assert.equal(existsSync(root), false);
});

test("rejects a malformed run binding before helper or TEMP side effects", async () => {
  let createdTemp = 0;
  let helperCalls = 0;
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: parseRegionSelector("pixel:0,0,2,1"),
        runId: "Work-A",
        workspaceFingerprint: "d".repeat(64)
      },
      {
        createTempRoot() {
          createdTemp += 1;
          return mkdtempSync(join(tmpdir(), "cu-windows-capture-invalid-run-"));
        },
        executeHelper() {
          helperCalls += 1;
          throw new Error("must not execute");
        }
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(createdTemp, 0);
  assert.equal(helperCalls, 0);
});

test("rejects a structural selector forgery before helper or TEMP side effects", async () => {
  let createdTemp = 0;
  let helperCalls = 0;
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: Object.freeze({ kind: "pixel", left: 0, top: 0, width: 2, height: 1 }) as never,
        runId: "work-a",
        workspaceFingerprint: "7".repeat(64)
      },
      {
        createTempRoot() {
          createdTemp += 1;
          return mkdtempSync(join(tmpdir(), "cu-windows-capture-forged-selector-"));
        },
        executeHelper() {
          helperCalls += 1;
          throw new Error("must not execute");
        }
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(createdTemp, 0);
  assert.equal(helperCalls, 0);
});

test("rejects malformed helper stdout bytes and shapes without trusting destination bytes", async () => {
  const image = pngBytes();
  const imageSha256 = createHash("sha256").update(image).digest("hex");
  const validResult = (requestId: string, destinationPath: string) =>
    helperResult(requestId, destinationPath, image, { x: 0, y: 0, width: 2, height: 1 });
  const cases = [
    {
      name: "invalid utf8 inside json string",
      stdout(requestId: string, destinationPath: string) {
        const prefix = Buffer.from(
          `{"kind":"cu.windows-capture.result/v1","requestId":${JSON.stringify(requestId)},"destinationPath":${JSON.stringify(destinationPath)},"sourceRectPx":{"x":0,"y":0,"width":2,"height":1},"virtualScreen":{"x":0,"y":0,"width":100,"height":100},"monitors":[{"x":0,"y":0,"width":100,"height":100,"primary":true}],"desktop":{"interactive":true,"connected":true,"kind":"default","sessionId":1,"desktopName":"`,
          "utf8"
        );
        const suffix = Buffer.from(
          `"},"foreground":{"windowHandle":"0x0000000000001234","processId":123},"image":{"sha256":"${imageSha256}","byteLength":${image.length},"width":2,"height":1}}\n`,
          "utf8"
        );
        return Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);
      }
    },
    {
      name: "duplicate key",
      stdout: (requestId: string, destinationPath: string) => Buffer.from(
        `{"kind":"ignored","kind":"cu.windows-capture.result/v1","requestId":${JSON.stringify(requestId)},"destinationPath":${JSON.stringify(destinationPath)},"sourceRectPx":{"x":0,"y":0,"width":2,"height":1},"virtualScreen":{"x":0,"y":0,"width":100,"height":100},"monitors":[{"x":0,"y":0,"width":100,"height":100,"primary":true}],"desktop":{"interactive":true,"connected":true,"kind":"default","sessionId":1,"desktopName":"Default"},"foreground":{"windowHandle":"0x0000000000001234","processId":123},"image":{"sha256":"${imageSha256}","byteLength":${image.length},"width":2,"height":1}}\n`,
        "utf8"
      )
    },
    {
      name: "extra key",
      stdout: (requestId: string, destinationPath: string) => helperStdout({
        ...validResult(requestId, destinationPath),
        extra: true
      })
    }
  ];

  for (const current of cases) {
    const root = mkdtempSync(join(tmpdir(), `cu-windows-capture-stdout-${current.name.replaceAll(" ", "-")}-`));
    await assert.rejects(
      captureRegionalObservation(
        {
          selector: parseRegionSelector("pixel:0,0,2,1"),
          runId: "work-a",
          workspaceFingerprint: "8".repeat(64)
        },
        {
          createRequestId: () => `req_${"8".repeat(32)}`,
          createTempRoot: () => root,
          executeHelper(requestText: string): WindowsCaptureHelperExecution {
            const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
            writeFileSync(request.destinationPath, image, { flag: "wx" });
            return {
              status: 0,
              signal: null,
              stdout: current.stdout(request.requestId, request.destinationPath),
              stderr: Buffer.alloc(0)
            };
          }
        }
      ),
      (error: unknown) => error instanceof WindowsCaptureError && error.message === "",
      current.name
    );
    assert.equal(existsSync(root), false, current.name);
  }
});

test("rejects helper image metadata mismatches and oversized destination files", async () => {
  const image = pngBytes();
  const mismatches = [
    { name: "sha", image: { sha256: "0".repeat(64) } },
    { name: "byteLength", image: { byteLength: image.length + 1 } },
    { name: "width", image: { width: 3 } },
    { name: "height", image: { height: 2 } }
  ];

  for (const current of mismatches) {
    const root = mkdtempSync(join(tmpdir(), `cu-windows-capture-metadata-${current.name}-`));
    await assert.rejects(
      captureRegionalObservation(
        {
          selector: parseRegionSelector("pixel:0,0,2,1"),
          runId: "work-a",
          workspaceFingerprint: "9".repeat(64)
        },
        {
          createRequestId: () => `req_${"9".repeat(32)}`,
          createTempRoot: () => root,
          executeHelper(requestText: string): WindowsCaptureHelperExecution {
            const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
            writeFileSync(request.destinationPath, image, { flag: "wx" });
            const base = helperResult(request.requestId, request.destinationPath, image, {
              x: 0,
              y: 0,
              width: 2,
              height: 1
            }) as { image: Record<string, unknown> };
            return {
              status: 0,
              signal: null,
              stdout: helperStdout({ ...base, image: { ...base.image, ...current.image } }),
              stderr: Buffer.alloc(0)
            };
          }
        }
      ),
      (error: unknown) => error instanceof WindowsCaptureError && error.message === "",
      current.name
    );
    assert.equal(existsSync(root), false, current.name);
  }

  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-oversized-destination-"));
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: parseRegionSelector("pixel:0,0,2,1"),
        runId: "work-a",
        workspaceFingerprint: "a".repeat(64)
      },
      {
        createRequestId: () => `req_${"a".repeat(32)}`,
        createTempRoot: () => root,
        executeHelper(requestText: string): WindowsCaptureHelperExecution {
          const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
          writeFileSync(request.destinationPath, Buffer.from([0]), { flag: "wx" });
          truncateSync(request.destinationPath, 67_108_865);
          return {
            status: 0,
            signal: null,
            stdout: helperStdout(helperResult(request.requestId, request.destinationPath, image, {
              x: 0,
              y: 0,
              width: 2,
              height: 1
            })),
            stderr: Buffer.alloc(0)
          };
        }
      }
    ),
    (error: unknown) => error instanceof WindowsCaptureError && error.message === ""
  );
  assert.equal(existsSync(root), false);
});

test("reports cleanup failure as the same content-free capture error", async () => {
  const root = mkdtempSync(join(tmpdir(), "cu-windows-capture-cleanup-failure-"));
  const image = pngBytes();
  await assert.rejects(
    captureRegionalObservation(
      {
        selector: parseRegionSelector("pixel:0,0,2,1"),
        runId: "work-a",
        workspaceFingerprint: "b".repeat(64)
      },
      {
        createRequestId: () => `req_${"b".repeat(32)}`,
        createTempRoot: () => root,
        executeHelper(requestText: string): WindowsCaptureHelperExecution {
          const request = JSON.parse(requestText) as { requestId: string; destinationPath: string };
          writeFileSync(request.destinationPath, image, { flag: "wx" });
          return {
            status: 0,
            signal: null,
            stdout: helperStdout(helperResult(request.requestId, request.destinationPath, image, {
              x: 0,
              y: 0,
              width: 2,
              height: 1
            })),
            stderr: Buffer.alloc(0)
          };
        },
        removeTempRoot() {
          throw new Error("private cleanup path");
        }
      }
    ),
    (error: unknown) =>
      error instanceof WindowsCaptureError &&
      error.message === "" &&
      !String(error).includes("private cleanup")
  );
  rmSync(root, { recursive: true, force: true });
});

test("rejects noncanonical, out-of-range, inverted, oversized, and full-screen selectors", () => {
  const rejected = [
    "normalized:0,0,1000,999",
    "normalized:500,0,499,999",
    "normalized:0,500,999,499",
    "normalized:00,0,1,1",
    "pixel:+1,2,3,4",
    "pixel:-0,2,3,4",
    "pixel:1,2,0,4",
    "pixel:1,2,4097,4",
    "pixel:1, 2,3,4",
    "pixels:1,2,3,4",
    ""
  ];
  for (const value of rejected) {
    assert.throws(() => parseRegionSelector(value), RegionSelectorError, value);
  }

  assert.throws(
    () => resolveRegionSelector(parseRegionSelector("normalized:0,0,999,999"), virtualScreen),
    RegionSelectorError
  );
  assert.throws(
    () => resolveRegionSelector(parseRegionSelector("pixel:-1920,0,3840,1080"), virtualScreen),
    RegionSelectorError
  );
  assert.throws(
    () => resolveRegionSelector(parseRegionSelector("pixel:2000,100,400,300"), virtualScreen),
    RegionSelectorError
  );
});
