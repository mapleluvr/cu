import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateCaptureBundleBytes,
  type ValidatedCaptureBundle,
} from "./capture-bundle.js";
import {
  deriveDisplayInventory,
  deriveTopologyFingerprint,
  isCaptureSelector,
  resolveCaptureSelector,
  type CaptureSelector,
  type DisplayInventory,
} from "./display.js";
import { isRunId } from "./identifiers.js";
import type { CaptureSidecar } from "./observation-record.js";
import {
  DEFAULT_OBSERVATION_TTL_MS,
  expirationFor,
  isObservationTtlMs,
  type ObservationTtlMs,
} from "./observation-expiry.js";
import type { PixelRectangle } from "./region.js";
import { readStableBinaryFileWithWitness } from "./regular-file.js";
import { parseStrictJsonBytes, type StrictJsonObject } from "./strict-json.js";

const MAX_CAPTURE_BYTES = 67_108_864;
const MAX_HELPER_OUTPUT_BYTES = 65_536;
const HELPER_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{32}$/;
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{32}$/;
const WINDOW_HANDLE_PATTERN = /^0x[0-9a-f]{16}$/;
const displayResultKeys = [
  "kind",
  "requestId",
  "virtualScreen",
  "monitors",
] as const;
const resultKeys = [
  "kind",
  "requestId",
  "destinationPath",
  "sourceRectPx",
  "virtualScreen",
  "monitors",
  "desktop",
  "foreground",
  "image",
] as const;
const rectKeys = ["x", "y", "width", "height"] as const;
const monitorKeys = ["x", "y", "width", "height", "primary"] as const;
const desktopKeys = [
  "interactive",
  "connected",
  "kind",
  "sessionId",
  "desktopName",
] as const;
const foregroundKeys = ["windowHandle", "processId"] as const;
const imageKeys = ["sha256", "byteLength", "width", "height"] as const;

export class WindowsDisplayError extends Error {
  readonly name = "WindowsDisplayError";

  constructor() {
    super("");
  }
}

export class WindowsCaptureError extends Error {
  readonly name = "WindowsCaptureError";

  constructor() {
    super("");
  }
}

export type WindowsCaptureHelperExecution = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}>;

export type WindowsDisplayDependencies = Readonly<{
  createRequestId?: () => string;
  createTempRoot?: () => string;
  executeHelper?: (
    requestText: string,
    tempRoot: string,
  ) => WindowsCaptureHelperExecution;
  removeTempRoot?: (path: string) => void;
}>;

export type WindowsCaptureDependencies = Readonly<{
  createObservationId?: () => string;
  createRequestId?: () => string;
  createTempRoot?: () => string;
  executeHelper?: (
    requestText: string,
    tempRoot: string,
  ) => WindowsCaptureHelperExecution;
  now?: () => Date;
  removeTempRoot?: (path: string) => void;
}>;

export type RegionalCapture = Readonly<{
  bundle: ValidatedCaptureBundle;
  observationId: string;
  capturedAt: string;
  expiresAt: string | null;
  captureMetadataSha256: string;
  environmentFingerprint: string;
  topologyFingerprint: string;
  sourceRectPx: PixelRectangle;
}>;

type DisplayResult = {
  requestId: string;
  virtualScreen: PixelRectangle;
  monitors: ReadonlyArray<PixelRectangle & { primary: boolean }>;
};

type CaptureResult = {
  requestId: string;
  destinationPath: string;
  sourceRectPx: PixelRectangle;
  virtualScreen: PixelRectangle;
  monitors: ReadonlyArray<PixelRectangle & { primary: boolean }>;
  desktop: {
    interactive: true;
    connected: true;
    kind: "default";
    sessionId: number;
    desktopName: string;
  };
  foreground: { windowHandle: string; processId: number };
  image: { sha256: string; byteLength: number; width: number; height: number };
};

function displayFail(): never {
  throw new WindowsDisplayError();
}

function fail(): never {
  throw new WindowsCaptureError();
}

function hasExactKeys(
  value: StrictJsonObject,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function requireObject(value: unknown): StrictJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  return value as StrictJsonObject;
}

function isInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function parseRect(value: unknown): PixelRectangle {
  const object = requireObject(value);
  if (
    !hasExactKeys(object, rectKeys) ||
    !isInteger(object.x, -2_147_483_648, 2_147_483_647) ||
    !isInteger(object.y, -2_147_483_648, 2_147_483_647) ||
    !isInteger(object.width, 1, 2_147_483_647) ||
    !isInteger(object.height, 1, 2_147_483_647)
  ) {
    return fail();
  }
  return Object.freeze({
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  });
}

function parseDisplayHelperResult(
  stdout: Buffer,
  expectedRequestId: string,
): DisplayResult {
  try {
    if (!Buffer.isBuffer(stdout) || stdout.length > MAX_HELPER_OUTPUT_BYTES) {
      return displayFail();
    }
    const root = requireObject(
      parseStrictJsonBytes(stdout, {
        maxBytes: MAX_HELPER_OUTPUT_BYTES,
        maxDepth: 16,
      }),
    );
    if (
      !hasExactKeys(root, displayResultKeys) ||
      root.kind !== "cu.windows-display.result/v1" ||
      root.requestId !== expectedRequestId
    ) {
      return displayFail();
    }
    const virtualScreen = parseRect(root.virtualScreen);
    if (
      !Array.isArray(root.monitors) ||
      root.monitors.length < 1 ||
      root.monitors.length > 32
    ) {
      return displayFail();
    }
    const monitors = root.monitors.map((monitorValue) => {
      const monitor = requireObject(monitorValue);
      if (
        !hasExactKeys(monitor, monitorKeys) ||
        !isInteger(monitor.x, -2_147_483_648, 2_147_483_647) ||
        !isInteger(monitor.y, -2_147_483_648, 2_147_483_647) ||
        !isInteger(monitor.width, 1, 2_147_483_647) ||
        !isInteger(monitor.height, 1, 2_147_483_647) ||
        typeof monitor.primary !== "boolean"
      ) {
        return displayFail();
      }
      return Object.freeze({
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
        primary: monitor.primary,
      });
    });
    if (monitors.filter((monitor) => monitor.primary).length !== 1) {
      return displayFail();
    }
    return {
      requestId: expectedRequestId,
      virtualScreen,
      monitors,
    };
  } catch {
    return displayFail();
  }
}

function parseHelperResult(
  stdout: Buffer,
  expectedRequestId: string,
  destinationPath: string,
): CaptureResult {
  try {
    if (!Buffer.isBuffer(stdout) || stdout.length > MAX_HELPER_OUTPUT_BYTES) {
      return fail();
    }
    const root = requireObject(
      parseStrictJsonBytes(stdout, {
        maxBytes: MAX_HELPER_OUTPUT_BYTES,
        maxDepth: 16,
      }),
    );
    if (
      !hasExactKeys(root, resultKeys) ||
      root.kind !== "cu.windows-capture.result/v1" ||
      root.requestId !== expectedRequestId ||
      root.destinationPath !== destinationPath
    ) {
      return fail();
    }
    const sourceRectPx = parseRect(root.sourceRectPx);
    const virtualScreen = parseRect(root.virtualScreen);
    if (
      !Array.isArray(root.monitors) ||
      root.monitors.length < 1 ||
      root.monitors.length > 32
    ) {
      return fail();
    }
    const monitors = root.monitors.map((monitorValue) => {
      const monitor = requireObject(monitorValue);
      if (
        !hasExactKeys(monitor, monitorKeys) ||
        !isInteger(monitor.x, -2_147_483_648, 2_147_483_647) ||
        !isInteger(monitor.y, -2_147_483_648, 2_147_483_647) ||
        !isInteger(monitor.width, 1, 2_147_483_647) ||
        !isInteger(monitor.height, 1, 2_147_483_647) ||
        typeof monitor.primary !== "boolean"
      ) {
        return fail();
      }
      return Object.freeze({
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
        primary: monitor.primary,
      });
    });
    if (monitors.filter((monitor) => monitor.primary).length !== 1) {
      return fail();
    }
    const desktop = requireObject(root.desktop);
    if (
      !hasExactKeys(desktop, desktopKeys) ||
      desktop.interactive !== true ||
      desktop.connected !== true ||
      desktop.kind !== "default" ||
      !isInteger(desktop.sessionId, 0, 2_147_483_647) ||
      typeof desktop.desktopName !== "string" ||
      desktop.desktopName.length < 1 ||
      desktop.desktopName.length > 128
    ) {
      return fail();
    }
    const foreground = requireObject(root.foreground);
    if (
      !hasExactKeys(foreground, foregroundKeys) ||
      typeof foreground.windowHandle !== "string" ||
      !WINDOW_HANDLE_PATTERN.test(foreground.windowHandle) ||
      !isInteger(foreground.processId, 0, 2_147_483_647)
    ) {
      return fail();
    }
    const image = requireObject(root.image);
    if (
      !hasExactKeys(image, imageKeys) ||
      typeof image.sha256 !== "string" ||
      !SHA256_PATTERN.test(image.sha256) ||
      !isInteger(image.byteLength, 1, MAX_CAPTURE_BYTES) ||
      !isInteger(image.width, 1, 32_768) ||
      !isInteger(image.height, 1, 32_768)
    ) {
      return fail();
    }
    return {
      requestId: expectedRequestId,
      destinationPath,
      sourceRectPx,
      virtualScreen,
      monitors,
      desktop: {
        interactive: true,
        connected: true,
        kind: "default",
        sessionId: desktop.sessionId,
        desktopName: desktop.desktopName,
      },
      foreground: {
        windowHandle: foreground.windowHandle,
        processId: foreground.processId,
      },
      image: {
        sha256: image.sha256,
        byteLength: image.byteLength,
        width: image.width,
        height: image.height,
      },
    };
  } catch {
    return fail();
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function defaultObservationId(): string {
  return `obs_${randomBytes(16).toString("hex")}`;
}

function defaultRequestId(): string {
  return `req_${randomBytes(16).toString("hex")}`;
}

function resolvePowerShellExecutable(): string {
  if (process.platform !== "win32") {
    return fail();
  }
  const slash = "\\";
  const kernelPath = `${slash}${slash}?${slash}GLOBALROOT${slash}SystemRoot${slash}System32${slash}WindowsPowerShell${slash}v1.0${slash}powershell.exe`;
  const resolved = realpathSync.native(kernelPath);
  const file = lstatSync(resolved);
  if (!file.isFile() || file.isSymbolicLink()) {
    return fail();
  }
  return resolved;
}

function defaultExecuteHelper(
  requestText: string,
  tempRoot: string,
): WindowsCaptureHelperExecution {
  const helperPath = fileURLToPath(
    new URL("../helper/windows-capture.ps1", import.meta.url),
  );
  const powershellPath = resolvePowerShellExecutable();
  const systemRoot = resolve(dirname(powershellPath), "../../..");
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.toLowerCase() !== "systemroot" && key.toLowerCase() !== "windir",
    ),
  );
  const result = spawnSync(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
    ],
    {
      input: requestText,
      windowsHide: true,
      shell: false,
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 131_072,
      env: {
        ...childEnvironment,
        SYSTEMROOT: systemRoot,
        WINDIR: systemRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
      },
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

export function queryWindowsDisplays(
  dependencies: WindowsDisplayDependencies = {},
): DisplayInventory {
  const createRequestId = dependencies.createRequestId ?? defaultRequestId;
  const createTempRoot =
    dependencies.createTempRoot ??
    (() => mkdtempSync(join(tmpdir(), "cu-display-")));
  const executeHelper = dependencies.executeHelper ?? defaultExecuteHelper;
  const removeTempRoot =
    dependencies.removeTempRoot ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));

  let tempRoot: string | undefined;
  let result: DisplayInventory | undefined;
  let failed = false;
  try {
    const requestId = createRequestId();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return displayFail();
    }
    tempRoot = resolve(createTempRoot());
    const canonicalRoot = realpathSync.native(tempRoot);
    const requestText = `${JSON.stringify({
      kind: "cu.windows-display.request/v1",
      requestId,
    })}\n`;
    const execution = executeHelper(requestText, canonicalRoot);
    if (
      !Buffer.isBuffer(execution.stdout) ||
      !Buffer.isBuffer(execution.stderr) ||
      execution.status !== 0 ||
      execution.signal !== null ||
      execution.stderr.length !== 0
    ) {
      return displayFail();
    }
    const helper = parseDisplayHelperResult(execution.stdout, requestId);
    result = deriveDisplayInventory({
      virtualScreen: helper.virtualScreen,
      monitors: helper.monitors,
    });
  } catch {
    failed = true;
  } finally {
    if (tempRoot !== undefined) {
      try {
        removeTempRoot(tempRoot);
      } catch {
        failed = true;
      }
    }
  }
  if (failed || result === undefined) {
    return displayFail();
  }
  return result;
}

export async function captureRegionalObservation(
  request: Readonly<{
    selector: CaptureSelector;
    runId: string;
    workspaceFingerprint: string;
    ttlMs?: ObservationTtlMs;
  }>,
  dependencies: WindowsCaptureDependencies = {},
): Promise<RegionalCapture> {
  const createObservationId =
    dependencies.createObservationId ?? defaultObservationId;
  const createRequestId = dependencies.createRequestId ?? defaultRequestId;
  const createTempRoot =
    dependencies.createTempRoot ??
    (() => mkdtempSync(join(tmpdir(), "cu-capture-")));
  const executeHelper = dependencies.executeHelper ?? defaultExecuteHelper;
  const now = dependencies.now ?? (() => new Date());
  const removeTempRoot =
    dependencies.removeTempRoot ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));

  let tempRoot: string | undefined;
  let result: RegionalCapture | undefined;
  let failed = false;
  try {
    const observationId = createObservationId();
    const requestId = createRequestId();
    const capturedAtDate = now();
    const capturedAt = capturedAtDate.toISOString();
    const ttlMs =
      request.ttlMs === undefined ? DEFAULT_OBSERVATION_TTL_MS : request.ttlMs;
    if (!isObservationTtlMs(ttlMs)) {
      return fail();
    }
    const expiresAt = expirationFor(capturedAtDate, ttlMs);
    if (
      !OBSERVATION_ID_PATTERN.test(observationId) ||
      !REQUEST_ID_PATTERN.test(requestId) ||
      !isRunId(request.runId) ||
      !isCaptureSelector(request.selector) ||
      !SHA256_PATTERN.test(request.workspaceFingerprint)
    ) {
      return fail();
    }

    tempRoot = resolve(createTempRoot());
    const canonicalRoot = realpathSync.native(tempRoot);
    const destinationPath = join(canonicalRoot, `${requestId}.png`);
    if (dirname(destinationPath) !== canonicalRoot) {
      return fail();
    }
    const requestText = `${JSON.stringify({
      kind: "cu.windows-capture.request/v1",
      requestId,
      destinationPath,
      selector: request.selector,
    })}\n`;
    const execution = executeHelper(requestText, canonicalRoot);
    if (
      !Buffer.isBuffer(execution.stdout) ||
      !Buffer.isBuffer(execution.stderr) ||
      execution.status !== 0 ||
      execution.signal !== null ||
      execution.stderr.length !== 0
    ) {
      return fail();
    }
    const helper = parseHelperResult(
      execution.stdout,
      requestId,
      destinationPath,
    );
    const source = helper.sourceRectPx;
    const topology = {
      virtualScreen: helper.virtualScreen,
      monitors: helper.monitors,
    };
    const expectedSource = resolveCaptureSelector(request.selector, topology);
    if (
      source.x !== expectedSource.x ||
      source.y !== expectedSource.y ||
      source.width !== expectedSource.width ||
      source.height !== expectedSource.height
    ) {
      return fail();
    }
    const imageBytes = readStableBinaryFileWithWitness(destinationPath, [
      canonicalRoot,
    ]).bytes;
    const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
    if (
      imageBytes.length !== helper.image.byteLength ||
      imageSha256 !== helper.image.sha256
    ) {
      return fail();
    }

    const topologyFingerprint = deriveTopologyFingerprint(topology);
    const environmentFingerprint = hashJson({
      topologyFingerprint,
      desktop: helper.desktop,
      foreground: helper.foreground,
    });
    const sidecar: CaptureSidecar = {
      kind: "cu.capture/v1",
      schemaVersion: 1,
      runId: request.runId,
      workspaceFingerprint: request.workspaceFingerprint,
      observationId,
      capturedAt,
      expiresAt,
      coordinateSpace: "normalized_999_top_left",
      source: {
        captureKind:
          request.selector.kind === "full_screen" ? "full" : "region",
        mapping: "normalized_endpoint_centers/v1",
        leftPx: source.x,
        topPx: source.y,
        widthPx: source.width,
        heightPx: source.height,
      },
      environmentFingerprint,
      topologyFingerprint,
      image: {
        mediaType: "image/png",
        sha256: imageSha256,
        byteLength: imageBytes.length,
        width: helper.image.width,
        height: helper.image.height,
      },
    };
    const captureMetadataBytes = Buffer.from(
      `${JSON.stringify(sidecar)}\n`,
      "utf8",
    );
    const bundle = await validateCaptureBundleBytes(
      captureMetadataBytes,
      imageBytes,
      {
        runId: request.runId,
        workspaceFingerprint: request.workspaceFingerprint,
      },
    );
    result = Object.freeze({
      bundle,
      observationId,
      capturedAt,
      expiresAt,
      captureMetadataSha256: bundle.captureMetadataSha256,
      environmentFingerprint,
      topologyFingerprint,
      sourceRectPx: source,
    });
  } catch {
    failed = true;
  } finally {
    if (tempRoot !== undefined) {
      try {
        removeTempRoot(tempRoot);
      } catch {
        failed = true;
      }
    }
  }
  if (failed || result === undefined) {
    return fail();
  }
  return result;
}
