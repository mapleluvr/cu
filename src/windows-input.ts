import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NormalizedAction, Point } from "./action-file.js";
import { parseStrictJsonBytes, type StrictJsonObject } from "./strict-json.js";
import { admitWindowsInputTiming } from "./windows-input-timing.js";

const HELPER_STARTUP_TIMEOUT_MS = 30_000;
const HELPER_PROTOCOL_MARGIN_MS = 15_000;
const MAX_HELPER_LINE_BYTES = 65_536;
const MAX_HELPER_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_NATIVE_RECORDS = 262_144;
const NATIVE_RECORD_BYTES = 32;
const MAX_TEXT_SCALARS = 2_048;
const MAX_TEXT_UTF16_UNITS = 4_096;
const MAX_TEXT_UTF8_BYTES = 8_192;

const MOUSE_MOVE = 0x0001;
const MOUSE_LEFT_DOWN = 0x0002;
const MOUSE_LEFT_UP = 0x0004;
const MOUSE_RIGHT_DOWN = 0x0008;
const MOUSE_RIGHT_UP = 0x0010;
const MOUSE_MIDDLE_DOWN = 0x0020;
const MOUSE_MIDDLE_UP = 0x0040;
const MOUSE_WHEEL = 0x0800;
const MOUSE_VIRTUAL_DESKTOP = 0x4000;
const MOUSE_ABSOLUTE = 0x8000;
const KEY_EXTENDED = 0x0001;
const KEY_UP = 0x0002;
const KEY_UNICODE = 0x0004;

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
const readyKeys = [
  "kind",
  "virtualScreen",
  "monitors",
  "desktop",
  "foreground",
] as const;
const resultKeys = [
  "kind",
  "executionId",
  "requestedNativeRecords",
  "acceptedNativeRecords",
  "cleanup",
  "heldAfter",
] as const;

export type PixelRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type NormalizedInputSource = Readonly<{
  mapping: "normalized_endpoint_centers/v1";
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}>;

export type WindowsInputSegment = Readonly<{
  source: NormalizedInputSource;
  actions: readonly NormalizedAction[];
}>;

export type NativeInputRecord = Readonly<{
  type: "mouse" | "key";
  dx: number;
  dy: number;
  flags: number;
  data: number;
  virtualKey: number;
  scanCode: number;
  delayAfterMs: number;
}>;

export type CompiledWindowsInputSegment = Readonly<{
  records: readonly NativeInputRecord[];
  emittedActionCount: number;
  emittedLeafActionCount: number;
  declaredDelayMs: number;
  generatedDragDurationMs: number;
  resultTimeoutMs: number;
}>;

const preparedWindowsInputBrand = Symbol("prepared windows input");

export type PreparedWindowsInputSegment = {
  readonly [preparedWindowsInputBrand]: true;
};

export type WindowsInputResult = Readonly<{
  requestedNativeRecords: number;
  acceptedNativeRecords: number;
  emittedActionCount: number;
  emittedLeafActionCount: number;
  cleanup: "not_needed";
  heldAfter: readonly [];
}>;

export type WindowsInputFailurePhase =
  | "helper_lost"
  | "input_unproven"
  | "cleanup_unproven";

export class WindowsInputError extends Error {
  readonly name = "WindowsInputError";

  constructor(readonly phase: WindowsInputFailurePhase = "helper_lost") {
    super("");
  }
}

export type WindowsInputSession = Readonly<{
  environmentFingerprint: string;
  topologyFingerprint: string;
  topology?: Readonly<{
    virtualScreen: PixelRectangle;
    monitors: readonly (PixelRectangle & { primary: boolean })[];
  }>;
  prepareSegment(segment: WindowsInputSegment): PreparedWindowsInputSegment;
  emitPrepared(
    prepared: PreparedWindowsInputSegment,
  ): Promise<WindowsInputResult>;
  emitSegment(segment: WindowsInputSegment): Promise<WindowsInputResult>;
  close(): Promise<void>;
}>;

type PreparedWindowsInputState = Readonly<{
  owner: object;
  compiled: CompiledWindowsInputSegment;
  requestText: string;
}>;

const preparedWindowsInputs = new WeakMap<
  PreparedWindowsInputSegment,
  PreparedWindowsInputState
>();

type MouseButton = "left" | "middle" | "right";
type HeldKind = "key" | "button";

type HelperReady = Readonly<{
  virtualScreen: PixelRectangle;
  monitors: readonly (PixelRectangle & { primary: boolean })[];
  desktop: Readonly<{
    interactive: true;
    connected: true;
    kind: "default";
    sessionId: number;
    desktopName: string;
  }>;
  foreground: Readonly<{ windowHandle: string; processId: number }>;
}>;

type HelperResult = Readonly<{
  executionId: string;
  requestedNativeRecords: number;
  acceptedNativeRecords: number;
  cleanup: "not_needed" | "released" | "unproven";
  heldAfter: readonly HeldKind[];
}>;

function fail(phase: WindowsInputFailurePhase = "helper_lost"): never {
  throw new WindowsInputError(phase);
}

function isRecord(value: unknown): value is StrictJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function requireRecord(value: unknown): StrictJsonObject {
  if (!isRecord(value)) return fail();
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return fail();
  }
  return value;
}

function parseRectangle(value: unknown): PixelRectangle {
  const record = requireRecord(value);
  if (!hasExactKeys(record, rectKeys)) return fail();
  return Object.freeze({
    x: requireInteger(record.x, -2_147_483_648, 2_147_483_647),
    y: requireInteger(record.y, -2_147_483_648, 2_147_483_647),
    width: requireInteger(record.width, 1, 2_147_483_647),
    height: requireInteger(record.height, 1, 2_147_483_647),
  });
}

function parseHelperReady(bytes: Buffer): HelperReady {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > MAX_HELPER_LINE_BYTES
    )
      return fail();
    const root = requireRecord(
      parseStrictJsonBytes(bytes, {
        maxBytes: MAX_HELPER_LINE_BYTES,
        maxDepth: 16,
      }),
    );
    if (
      !hasExactKeys(root, readyKeys) ||
      root.kind !== "cu.windows-input.ready/v1"
    )
      return fail();
    const virtualScreen = parseRectangle(root.virtualScreen);
    const monitorsRaw = root.monitors;
    if (
      !Array.isArray(monitorsRaw) ||
      monitorsRaw.length < 1 ||
      monitorsRaw.length > 32
    )
      return fail();
    const monitors = monitorsRaw.map((value) => {
      const record = requireRecord(value);
      if (
        !hasExactKeys(record, monitorKeys) ||
        typeof record.primary !== "boolean"
      )
        return fail();
      return Object.freeze({
        x: requireInteger(record.x, -2_147_483_648, 2_147_483_647),
        y: requireInteger(record.y, -2_147_483_648, 2_147_483_647),
        width: requireInteger(record.width, 1, 2_147_483_647),
        height: requireInteger(record.height, 1, 2_147_483_647),
        primary: record.primary,
      });
    });
    if (monitors.filter((monitor) => monitor.primary).length !== 1)
      return fail();
    const desktop = requireRecord(root.desktop);
    if (
      !hasExactKeys(desktop, desktopKeys) ||
      desktop.interactive !== true ||
      desktop.connected !== true ||
      desktop.kind !== "default" ||
      typeof desktop.desktopName !== "string" ||
      desktop.desktopName.length < 1 ||
      desktop.desktopName.length > 128
    ) {
      return fail();
    }
    const sessionId = requireInteger(desktop.sessionId, 0, 2_147_483_647);
    const foreground = requireRecord(root.foreground);
    if (
      !hasExactKeys(foreground, foregroundKeys) ||
      typeof foreground.windowHandle !== "string" ||
      !/^0x[0-9a-f]{16}$/.test(foreground.windowHandle)
    ) {
      return fail();
    }
    const processId = requireInteger(foreground.processId, 0, 2_147_483_647);
    return Object.freeze({
      virtualScreen,
      monitors: Object.freeze(monitors),
      desktop: Object.freeze({
        interactive: true,
        connected: true,
        kind: "default",
        sessionId,
        desktopName: desktop.desktopName,
      }),
      foreground: Object.freeze({
        windowHandle: foreground.windowHandle,
        processId,
      }),
    });
  } catch {
    return fail();
  }
}

function parseHelperResult(
  bytes: Buffer,
  requestedNativeRecords: number,
  expectedExecutionId: string,
): HelperResult {
  try {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > MAX_HELPER_LINE_BYTES
    )
      return fail();
    const root = requireRecord(
      parseStrictJsonBytes(bytes, {
        maxBytes: MAX_HELPER_LINE_BYTES,
        maxDepth: 8,
      }),
    );
    if (
      !hasExactKeys(root, resultKeys) ||
      root.kind !== "cu.windows-input.result/v1" ||
      typeof root.executionId !== "string" ||
      !/^inp_[a-f0-9]{32}$/.test(root.executionId) ||
      root.executionId !== expectedExecutionId
    )
      return fail();
    const requested = requireInteger(
      root.requestedNativeRecords,
      1,
      MAX_NATIVE_RECORDS,
    );
    const accepted = requireInteger(root.acceptedNativeRecords, 0, requested);
    if (requested !== requestedNativeRecords) return fail("input_unproven");
    if (
      root.cleanup !== "not_needed" &&
      root.cleanup !== "released" &&
      root.cleanup !== "unproven"
    )
      return fail();
    if (
      !Array.isArray(root.heldAfter) ||
      root.heldAfter.some((entry) => entry !== "key" && entry !== "button")
    )
      return fail();
    return Object.freeze({
      executionId: root.executionId,
      requestedNativeRecords: requested,
      acceptedNativeRecords: accepted,
      cleanup: root.cleanup,
      heldAfter: Object.freeze([...root.heldAfter]) as readonly HeldKind[],
    });
  } catch (error) {
    if (error instanceof WindowsInputError) throw error;
    return fail();
  }
}

function validateAdmittedHelperResult(
  helper: HelperResult,
): Readonly<{ requestedNativeRecords: number; acceptedNativeRecords: number }> {
  if (helper.cleanup === "unproven" || helper.heldAfter.length !== 0)
    return fail("cleanup_unproven");
  if (
    helper.acceptedNativeRecords !== helper.requestedNativeRecords ||
    helper.cleanup !== "not_needed"
  ) {
    return fail("input_unproven");
  }
  return Object.freeze({
    requestedNativeRecords: helper.requestedNativeRecords,
    acceptedNativeRecords: helper.acceptedNativeRecords,
  });
}

export function validateWindowsInputHelperResult(
  bytes: Buffer,
  requestedNativeRecords: number,
  expectedExecutionId: string,
): Readonly<{ requestedNativeRecords: number; acceptedNativeRecords: number }> {
  return validateAdmittedHelperResult(
    parseHelperResult(bytes, requestedNativeRecords, expectedExecutionId),
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function requireSource(
  source: NormalizedInputSource,
  virtualScreen: PixelRectangle,
): NormalizedInputSource {
  if (
    source === null ||
    typeof source !== "object" ||
    !hasObjectKeys(source as Record<string, unknown>, [
      "mapping",
      "leftPx",
      "topPx",
      "widthPx",
      "heightPx",
    ]) ||
    source.mapping !== "normalized_endpoint_centers/v1"
  ) {
    return fail("input_unproven");
  }
  const leftPx = requireInteger(source.leftPx, -2_147_483_648, 2_147_483_647);
  const topPx = requireInteger(source.topPx, -2_147_483_648, 2_147_483_647);
  const widthPx = requireInteger(source.widthPx, 1, 32_768);
  const heightPx = requireInteger(source.heightPx, 1, 32_768);
  const right = leftPx + widthPx;
  const bottom = topPx + heightPx;
  const virtualRight = virtualScreen.x + virtualScreen.width;
  const virtualBottom = virtualScreen.y + virtualScreen.height;
  if (
    leftPx < virtualScreen.x ||
    topPx < virtualScreen.y ||
    right > virtualRight ||
    bottom > virtualBottom ||
    right <= leftPx ||
    bottom <= topPx
  ) {
    return fail("input_unproven");
  }
  return Object.freeze({
    mapping: source.mapping,
    leftPx,
    topPx,
    widthPx,
    heightPx,
  });
}

function mapPoint(
  point: Point,
  source: NormalizedInputSource,
): Readonly<{ x: number; y: number }> {
  if (
    point === null ||
    typeof point !== "object" ||
    !hasObjectKeys(point as Record<string, unknown>, ["x", "y"]) ||
    !Number.isSafeInteger(point.x) ||
    !Number.isSafeInteger(point.y) ||
    point.x < 0 ||
    point.x > 999 ||
    point.y < 0 ||
    point.y > 999
  ) {
    return fail("input_unproven");
  }
  return Object.freeze({
    x: source.leftPx + Math.floor((point.x * (source.widthPx - 1)) / 999),
    y: source.topPx + Math.floor((point.y * (source.heightPx - 1)) / 999),
  });
}

function absoluteCoordinate(
  value: number,
  origin: number,
  extent: number,
): number {
  if (extent === 1) return 0;
  return Math.round(((value - origin) * 65_535) / (extent - 1));
}

function makeMouse(
  flags: number,
  dx = 0,
  dy = 0,
  data = 0,
  delayAfterMs = 0,
): NativeInputRecord {
  return Object.freeze({
    type: "mouse",
    dx,
    dy,
    flags,
    data,
    virtualKey: 0,
    scanCode: 0,
    delayAfterMs,
  });
}

function makeKey(
  virtualKey: number,
  flags: number,
  scanCode = 0,
  delayAfterMs = 0,
): NativeInputRecord {
  return Object.freeze({
    type: "key",
    dx: 0,
    dy: 0,
    flags,
    data: 0,
    virtualKey,
    scanCode,
    delayAfterMs,
  });
}

function movePixelRecord(
  point: Readonly<{ x: number; y: number }>,
  virtualScreen: PixelRectangle,
): NativeInputRecord {
  return makeMouse(
    MOUSE_MOVE | MOUSE_VIRTUAL_DESKTOP | MOUSE_ABSOLUTE,
    absoluteCoordinate(point.x, virtualScreen.x, virtualScreen.width),
    absoluteCoordinate(point.y, virtualScreen.y, virtualScreen.height),
  );
}

function moveRecord(
  point: Point,
  source: NormalizedInputSource,
  virtualScreen: PixelRectangle,
): NativeInputRecord {
  return movePixelRecord(mapPoint(point, source), virtualScreen);
}

function buttonFlags(
  button: MouseButton,
): Readonly<{ down: number; up: number }> {
  switch (button) {
    case "left":
      return { down: MOUSE_LEFT_DOWN, up: MOUSE_LEFT_UP };
    case "middle":
      return { down: MOUSE_MIDDLE_DOWN, up: MOUSE_MIDDLE_UP };
    case "right":
      return { down: MOUSE_RIGHT_DOWN, up: MOUSE_RIGHT_UP };
    default:
      return fail("input_unproven");
  }
}

function keyDefinition(
  key: string,
): Readonly<{ virtualKey: number; extended: boolean }> {
  if (/^Key[A-Z]$/.test(key))
    return { virtualKey: key.charCodeAt(3), extended: false };
  if (/^Digit[0-9]$/.test(key))
    return { virtualKey: key.charCodeAt(5), extended: false };
  if (/^Numpad[0-9]$/.test(key))
    return { virtualKey: 0x60 + Number(key[6]), extended: false };
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))
    return { virtualKey: 0x70 + Number(key.slice(1)) - 1, extended: false };
  const definitions: Record<
    string,
    Readonly<{ virtualKey: number; extended: boolean }>
  > = {
    Shift: { virtualKey: 0x10, extended: false },
    Control: { virtualKey: 0x11, extended: false },
    Alt: { virtualKey: 0x12, extended: false },
    Meta: { virtualKey: 0x5b, extended: true },
    Enter: { virtualKey: 0x0d, extended: false },
    Tab: { virtualKey: 0x09, extended: false },
    Escape: { virtualKey: 0x1b, extended: false },
    Space: { virtualKey: 0x20, extended: false },
    Backspace: { virtualKey: 0x08, extended: false },
    Delete: { virtualKey: 0x2e, extended: true },
    Insert: { virtualKey: 0x2d, extended: true },
    Home: { virtualKey: 0x24, extended: true },
    End: { virtualKey: 0x23, extended: true },
    PageUp: { virtualKey: 0x21, extended: true },
    PageDown: { virtualKey: 0x22, extended: true },
    ArrowUp: { virtualKey: 0x26, extended: true },
    ArrowDown: { virtualKey: 0x28, extended: true },
    ArrowLeft: { virtualKey: 0x25, extended: true },
    ArrowRight: { virtualKey: 0x27, extended: true },
    CapsLock: { virtualKey: 0x14, extended: false },
    NumLock: { virtualKey: 0x90, extended: false },
    ScrollLock: { virtualKey: 0x91, extended: false },
    PrintScreen: { virtualKey: 0x2c, extended: true },
    Pause: { virtualKey: 0x13, extended: false },
    ContextMenu: { virtualKey: 0x5d, extended: true },
    Semicolon: { virtualKey: 0xba, extended: false },
    Equal: { virtualKey: 0xbb, extended: false },
    Comma: { virtualKey: 0xbc, extended: false },
    Minus: { virtualKey: 0xbd, extended: false },
    Period: { virtualKey: 0xbe, extended: false },
    Slash: { virtualKey: 0xbf, extended: false },
    Backquote: { virtualKey: 0xc0, extended: false },
    BracketLeft: { virtualKey: 0xdb, extended: false },
    Backslash: { virtualKey: 0xdc, extended: false },
    BracketRight: { virtualKey: 0xdd, extended: false },
    Quote: { virtualKey: 0xde, extended: false },
    NumpadAdd: { virtualKey: 0x6b, extended: false },
    NumpadSubtract: { virtualKey: 0x6d, extended: false },
    NumpadMultiply: { virtualKey: 0x6a, extended: false },
    NumpadDivide: { virtualKey: 0x6f, extended: true },
    NumpadDecimal: { virtualKey: 0x6e, extended: false },
    NumpadEnter: { virtualKey: 0x0d, extended: true },
  };
  const definition = definitions[key];
  if (definition === undefined) return fail("input_unproven");
  return definition;
}

function validateText(text: unknown): string {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_TEXT_UTF16_UNITS
  ) {
    return fail("input_unproven");
  }
  let scalars = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return fail("input_unproven");
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail("input_unproven");
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return fail("input_unproven");
    }
    scalars++;
  }
  if (
    scalars > MAX_TEXT_SCALARS ||
    Buffer.byteLength(text, "utf8") > MAX_TEXT_UTF8_BYTES
  ) {
    return fail("input_unproven");
  }
  return text;
}

function setLastDelay(
  records: NativeInputRecord[],
  delayAfterMs: number,
): void {
  if (
    !Number.isSafeInteger(delayAfterMs) ||
    delayAfterMs < 0 ||
    delayAfterMs > 5_000 ||
    records.length === 0
  ) {
    return fail("input_unproven");
  }
  const previous = records[records.length - 1]!;
  records[records.length - 1] = Object.freeze({ ...previous, delayAfterMs });
}

function compileAction(
  action: NormalizedAction | Record<string, unknown>,
  source: NormalizedInputSource,
  virtualScreen: PixelRectangle,
): NativeInputRecord[] {
  if (
    action === null ||
    typeof action !== "object" ||
    Array.isArray(action) ||
    typeof action.kind !== "string"
  ) {
    return fail("input_unproven");
  }
  switch (action.kind) {
    case "pointer_move":
      if (!hasObjectKeys(action, ["kind", "to"])) return fail("input_unproven");
      return [moveRecord(action.to as Point, source, virtualScreen)];
    case "click": {
      if (
        !hasObjectKeys(action, ["kind", "at", "button", "count"]) ||
        !isMouseButton(action.button)
      ) {
        return fail("input_unproven");
      }
      if (action.count !== 1 && action.count !== 2)
        return fail("input_unproven");
      const flags = buttonFlags(action.button);
      const records = [moveRecord(action.at as Point, source, virtualScreen)];
      for (let index = 0; index < action.count; index++) {
        records.push(makeMouse(flags.down), makeMouse(flags.up));
      }
      return records;
    }
    case "drag": {
      if (
        !hasObjectKeys(action, [
          "kind",
          "from",
          "to",
          "button",
          "durationMs",
        ]) ||
        !isMouseButton(action.button)
      ) {
        return fail("input_unproven");
      }
      const durationMs = action.durationMs;
      if (
        action.button === "middle" ||
        typeof durationMs !== "number" ||
        !Number.isSafeInteger(durationMs) ||
        durationMs < 100 ||
        durationMs > 5_000
      ) {
        return fail("input_unproven");
      }
      const from = mapPoint(action.from as Point, source);
      const to = mapPoint(action.to as Point, source);
      if (from.x === to.x && from.y === to.y) return fail("input_unproven");
      const flags = buttonFlags(action.button);
      const batches = Math.min(120, Math.max(1, Math.ceil(durationMs / 16)));
      const records = [
        moveRecord(action.from as Point, source, virtualScreen),
        makeMouse(flags.down),
      ];
      for (let index = 1; index <= batches; index++) {
        const point = {
          x: Math.round(from.x + ((to.x - from.x) * index) / batches),
          y: Math.round(from.y + ((to.y - from.y) * index) / batches),
        };
        const record = movePixelRecord(point, virtualScreen);
        const elapsed = Math.floor((index * durationMs) / batches);
        const previousElapsed = Math.floor(
          ((index - 1) * durationMs) / batches,
        );
        records.push(
          Object.freeze({ ...record, delayAfterMs: elapsed - previousElapsed }),
        );
      }
      records.push(makeMouse(flags.up));
      return records;
    }
    case "wheel": {
      const deltaY = action.deltaY;
      if (
        !hasObjectKeys(action, ["kind", "at", "deltaY"]) ||
        typeof deltaY !== "number" ||
        !Number.isSafeInteger(deltaY) ||
        deltaY === 0 ||
        deltaY < -100 ||
        deltaY > 100
      ) {
        return fail("input_unproven");
      }
      return [
        moveRecord(action.at as Point, source, virtualScreen),
        makeMouse(MOUSE_WHEEL, 0, 0, deltaY * 120),
      ];
    }
    case "key": {
      if (
        !hasObjectKeys(action, ["kind", "key"]) ||
        typeof action.key !== "string"
      )
        return fail("input_unproven");
      const definition = keyDefinition(action.key);
      const flags = definition.extended ? KEY_EXTENDED : 0;
      return [
        makeKey(definition.virtualKey, flags),
        makeKey(definition.virtualKey, flags | KEY_UP),
      ];
    }
    case "type_text": {
      if (!hasObjectKeys(action, ["kind", "text"]))
        return fail("input_unproven");
      const text = validateText(action.text);
      const records: NativeInputRecord[] = [];
      for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        records.push(
          makeKey(0, KEY_UNICODE, unit),
          makeKey(0, KEY_UNICODE | KEY_UP, unit),
        );
      }
      return records;
    }
    case "chord": {
      if (
        !hasObjectKeys(action, ["kind", "keys"]) ||
        !Array.isArray(action.keys) ||
        action.keys.length < 2 ||
        action.keys.length > 6
      ) {
        return fail("input_unproven");
      }
      const definitions = action.keys.map((key) => {
        if (typeof key !== "string") return fail("input_unproven");
        return keyDefinition(key);
      });
      if (new Set(action.keys).size !== action.keys.length)
        return fail("input_unproven");
      return [
        ...definitions.map((definition) =>
          makeKey(
            definition.virtualKey,
            definition.extended ? KEY_EXTENDED : 0,
          ),
        ),
        ...definitions
          .slice()
          .reverse()
          .map((definition) =>
            makeKey(
              definition.virtualKey,
              (definition.extended ? KEY_EXTENDED : 0) | KEY_UP,
            ),
          ),
      ];
    }
    case "sequence": {
      if (
        !hasObjectKeys(action, ["kind", "coordinateKind", "steps"]) ||
        !Array.isArray(action.steps) ||
        action.steps.length < 1 ||
        action.steps.length > 32
      ) {
        return fail("input_unproven");
      }
      const records: NativeInputRecord[] = [];
      const held: Array<{ kind: HeldKind; value: string }> = [];
      let coordinateCount = 0;
      for (const step of action.steps) {
        if (
          step === null ||
          typeof step !== "object" ||
          Array.isArray(step) ||
          !hasObjectKeys(step, ["action", "delayAfterMs"]) ||
          !Number.isSafeInteger(step.delayAfterMs)
        ) {
          return fail("input_unproven");
        }
        const leaf = step.action as Record<string, unknown>;
        if (
          leaf === null ||
          typeof leaf !== "object" ||
          Array.isArray(leaf) ||
          typeof leaf.kind !== "string"
        )
          return fail("input_unproven");
        if (leaf.kind === "key_down") {
          if (
            !hasObjectKeys(leaf, ["kind", "key"]) ||
            !isTransitionModifier(leaf.key) ||
            held.some(
              (entry) => entry.kind === "key" && entry.value === leaf.key,
            )
          )
            return fail("input_unproven");
          held.push({ kind: "key", value: leaf.key });
        } else if (leaf.kind === "key_up") {
          const top = held[held.length - 1];
          if (
            !hasObjectKeys(leaf, ["kind", "key"]) ||
            !isTransitionModifier(leaf.key) ||
            top?.kind !== "key" ||
            top.value !== leaf.key
          )
            return fail("input_unproven");
          held.pop();
        } else if (leaf.kind === "button_down") {
          if (
            !hasObjectKeys(leaf, ["kind", "button", "at"]) ||
            !isMouseButton(leaf.button) ||
            held.some(
              (entry) => entry.kind === "button" && entry.value === leaf.button,
            )
          )
            return fail("input_unproven");
          held.push({ kind: "button", value: leaf.button });
          coordinateCount++;
        } else if (leaf.kind === "button_up") {
          const top = held[held.length - 1];
          if (
            !hasObjectKeys(leaf, ["kind", "button"]) ||
            !isMouseButton(leaf.button) ||
            top?.kind !== "button" ||
            top.value !== leaf.button
          )
            return fail("input_unproven");
          held.pop();
        } else if (
          leaf.kind === "pointer_move" ||
          leaf.kind === "click" ||
          leaf.kind === "drag" ||
          leaf.kind === "wheel"
        ) {
          coordinateCount++;
        } else {
          return fail("input_unproven");
        }
        if (coordinateCount > 1) return fail("input_unproven");
        const leafRecords = compileSequenceLeaf(leaf, source, virtualScreen);
        setLastDelay(leafRecords, step.delayAfterMs);
        records.push(...leafRecords);
      }
      if (
        coordinateCount !== 1 ||
        held.length !== 0 ||
        action.coordinateKind !== sequenceCoordinateKind(action.steps)
      )
        return fail("input_unproven");
      return records;
    }
    default:
      return fail("input_unproven");
  }
}

function hasObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isMouseButton(value: unknown): value is MouseButton {
  return value === "left" || value === "middle" || value === "right";
}

function isTransitionModifier(
  value: unknown,
): value is "Control" | "Alt" | "Shift" {
  return value === "Control" || value === "Alt" || value === "Shift";
}

function compileSequenceLeaf(
  leaf: Record<string, unknown>,
  source: NormalizedInputSource,
  virtualScreen: PixelRectangle,
): NativeInputRecord[] {
  if (leaf.kind === "key_down" || leaf.kind === "key_up") {
    const definition = keyDefinition(leaf.key as string);
    const flags =
      (definition.extended ? KEY_EXTENDED : 0) |
      (leaf.kind === "key_up" ? KEY_UP : 0);
    return [makeKey(definition.virtualKey, flags)];
  }
  if (leaf.kind === "button_down") {
    return [
      moveRecord(leaf.at as Point, source, virtualScreen),
      makeMouse(buttonFlags(leaf.button as MouseButton).down),
    ];
  }
  if (leaf.kind === "button_up") {
    return [makeMouse(buttonFlags(leaf.button as MouseButton).up)];
  }
  return compileAction(leaf, source, virtualScreen);
}

function sequenceCoordinateKind(steps: unknown[]): string | undefined {
  for (const step of steps) {
    if (step !== null && typeof step === "object" && !Array.isArray(step)) {
      const action = (step as Record<string, unknown>).action;
      if (
        action !== null &&
        typeof action === "object" &&
        !Array.isArray(action)
      ) {
        const kind = (action as Record<string, unknown>).kind;
        if (
          kind === "pointer_move" ||
          kind === "click" ||
          kind === "drag" ||
          kind === "wheel" ||
          kind === "button_down"
        ) {
          return kind;
        }
      }
    }
  }
  return undefined;
}

function actionTiming(action: NormalizedAction): Readonly<{
  declaredDelayMs: number;
  generatedDragDurationMs: number;
}> {
  if (action.kind === "drag") {
    return { declaredDelayMs: 0, generatedDragDurationMs: action.durationMs };
  }
  if (action.kind !== "sequence") {
    return { declaredDelayMs: 0, generatedDragDurationMs: 0 };
  }
  let declaredDelayMs = 0;
  let generatedDragDurationMs = 0;
  for (const step of action.steps) {
    declaredDelayMs += step.delayAfterMs;
    if (step.action.kind === "drag")
      generatedDragDurationMs += step.action.durationMs;
  }
  return { declaredDelayMs, generatedDragDurationMs };
}

export function compileWindowsInputSegment(
  segment: WindowsInputSegment,
  virtualScreen: PixelRectangle,
): CompiledWindowsInputSegment {
  try {
    if (
      segment === null ||
      typeof segment !== "object" ||
      !hasObjectKeys(segment as Record<string, unknown>, [
        "source",
        "actions",
      ]) ||
      !Array.isArray(segment.actions) ||
      segment.actions.length < 1 ||
      segment.actions.length > 32
    ) {
      return fail("input_unproven");
    }
    const admittedVirtualScreen = parseRectangle(virtualScreen);
    const source = requireSource(segment.source, admittedVirtualScreen);
    const records: NativeInputRecord[] = [];
    let leaves = 0;
    let declaredDelayMs = 0;
    let generatedDragDurationMs = 0;
    for (const action of segment.actions) {
      const actionRecords = compileAction(
        action,
        source,
        admittedVirtualScreen,
      );
      const timing = actionTiming(action);
      records.push(...actionRecords);
      leaves += action.kind === "sequence" ? action.steps.length : 1;
      declaredDelayMs += timing.declaredDelayMs;
      generatedDragDurationMs += timing.generatedDragDurationMs;
    }
    const timing = admitWindowsInputTiming(
      declaredDelayMs,
      generatedDragDurationMs,
    );
    const actualDelayMs = records.reduce(
      (total, record) => total + record.delayAfterMs,
      0,
    );
    if (
      leaves > 32 ||
      records.length < 1 ||
      records.length > MAX_NATIVE_RECORDS ||
      !Number.isSafeInteger(actualDelayMs) ||
      actualDelayMs !== timing.totalDelayMs
    )
      return fail("input_unproven");
    return Object.freeze({
      records: Object.freeze(records),
      emittedActionCount: segment.actions.length,
      emittedLeafActionCount: leaves,
      declaredDelayMs: timing.declaredDelayMs,
      generatedDragDurationMs: timing.generatedDragDurationMs,
      resultTimeoutMs: timing.resultTimeoutMs,
    });
  } catch (error) {
    if (error instanceof WindowsInputError) throw error;
    return fail("input_unproven");
  }
}

function encodeRecords(records: readonly NativeInputRecord[]): string {
  if (records.length < 1 || records.length > MAX_NATIVE_RECORDS)
    return fail("input_unproven");
  const bytes = Buffer.allocUnsafe(records.length * NATIVE_RECORD_BYTES);
  for (const [index, record] of records.entries()) {
    const offset = index * NATIVE_RECORD_BYTES;
    bytes.writeInt32LE(
      record.type === "mouse" ? 0 : record.type === "key" ? 1 : -1,
      offset,
    );
    bytes.writeInt32LE(record.dx, offset + 4);
    bytes.writeInt32LE(record.dy, offset + 8);
    bytes.writeUInt32LE(record.flags, offset + 12);
    bytes.writeInt32LE(record.data, offset + 16);
    bytes.writeUInt32LE(record.virtualKey, offset + 20);
    bytes.writeUInt32LE(record.scanCode, offset + 24);
    bytes.writeUInt32LE(record.delayAfterMs, offset + 28);
  }
  return bytes.toString("base64");
}

function resolvePowerShellExecutable(): string {
  if (process.platform !== "win32") return fail();
  const slash = "\\";
  const kernelPath = `${slash}${slash}?${slash}GLOBALROOT${slash}SystemRoot${slash}System32${slash}WindowsPowerShell${slash}v1.0${slash}powershell.exe`;
  const resolved = realpathSync.native(kernelPath);
  const file = lstatSync(resolved);
  if (!file.isFile() || file.isSymbolicLink()) return fail();
  return resolved;
}

function childEnvironmentForStockPowerShell(
  powershellPath: string,
  tempRoot: string,
): NodeJS.ProcessEnv {
  const systemRoot = resolve(dirname(powershellPath), "../../..");
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key.toLowerCase() !== "systemroot" && key.toLowerCase() !== "windir",
      ),
    ),
    SYSTEMROOT: systemRoot,
    WINDIR: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
  };
}

class HelperLines {
  private readonly lines: Buffer[] = [];
  private buffered = Buffer.alloc(0);
  private readonly waiters: Array<(line: Buffer | undefined) => void> = [];
  private readonly endWaiters: Array<() => void> = [];
  private ended = false;
  private valid = true;
  private receivedBytes = 0;

  constructor(readable: NodeJS.ReadableStream) {
    readable.on("data", (chunk: Buffer) => {
      if (this.ended) return;
      const owned = Buffer.from(chunk);
      this.receivedBytes += owned.length;
      const next = Buffer.concat([this.buffered, owned]);
      if (
        this.receivedBytes > MAX_HELPER_LINE_BYTES * 2 ||
        next.length > MAX_HELPER_LINE_BYTES
      ) {
        this.finish(false);
        return;
      }
      let offset = 0;
      let newline = next.indexOf(0x0a, offset);
      while (newline >= 0) {
        const line = next.subarray(offset, newline);
        if (
          line.length === 0 ||
          line.length > MAX_HELPER_LINE_BYTES ||
          this.lines.length >= 2
        ) {
          this.finish(false);
          return;
        }
        this.push(Buffer.from(line));
        offset = newline + 1;
        newline = next.indexOf(0x0a, offset);
      }
      this.buffered = Buffer.from(next.subarray(offset));
    });
    readable.on("end", () => this.finish(this.buffered.length === 0));
    readable.on("error", () => this.finish(false));
  }

  async next(): Promise<Buffer> {
    const queued = this.lines.shift();
    if (queued !== undefined) return queued;
    if (this.ended) return fail();
    return new Promise<Buffer>((resolveLine, rejectLine) => {
      this.waiters.push((line) => {
        if (line === undefined) rejectLine(new WindowsInputError());
        else resolveLine(line);
      });
    });
  }

  expectRequestBoundary(): void {
    if (
      this.ended ||
      !this.valid ||
      this.buffered.length !== 0 ||
      this.lines.length !== 0
    ) {
      return fail();
    }
  }

  async expectCleanEnd(): Promise<void> {
    if (!this.ended) {
      await new Promise<void>((resolveEnd) => this.endWaiters.push(resolveEnd));
    }
    if (!this.valid || this.buffered.length !== 0 || this.lines.length !== 0)
      return fail();
  }

  private push(line: Buffer): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.lines.push(line);
  }

  private finish(valid: boolean): void {
    if (this.ended) return;
    this.valid = this.valid && valid;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
    for (const waiter of this.endWaiters.splice(0)) waiter();
  }
}

type ChildClose = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

function observeChildClose(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildClose> {
  return new Promise((resolveClose) => {
    child.once("close", (code, signal) =>
      resolveClose(Object.freeze({ code, signal })),
    );
  });
}

function writeHelperChunk(
  writable: ChildProcessWithoutNullStreams["stdin"],
  text: string,
  end: boolean,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false;
    const settle = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      writable.off("error", onError);
      if (error === undefined || error === null) resolveWrite();
      else rejectWrite(new WindowsInputError());
    };
    const onError = () => settle(new WindowsInputError());
    const onWritten = (error?: Error | null) => settle(error);
    writable.once("error", onError);
    if (end) writable.end(text, "utf8", onWritten);
    else writable.write(text, "utf8", onWritten);
  });
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs = HELPER_STARTUP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(
      () => rejectValue(new WindowsInputError()),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}

export async function openWindowsInputSession(): Promise<WindowsInputSession> {
  if (process.platform !== "win32") return fail();
  let tempRoot: string | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClose: Promise<ChildClose> | undefined;
  let closed = false;
  let emitted = false;
  let childTransportError = false;
  let stdinTransportError = false;
  let stderrBytes = 0;
  let stderrInvalid = false;

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    let cleanupUnproven = false;
    if (child !== undefined) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        if (childClose === undefined) cleanupUnproven = true;
        else await waitWithTimeout(childClose, HELPER_PROTOCOL_MARGIN_MS);
      } catch {
        cleanupUnproven = true;
      }
    }
    if (tempRoot !== undefined) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        cleanupUnproven = true;
      }
    }
    if (cleanupUnproven) return fail("cleanup_unproven");
  };

  try {
    tempRoot = resolve(mkdtempSync(join(tmpdir(), "cu-input-")));
    const powershellPath = resolvePowerShellExecutable();
    const helperPath = fileURLToPath(
      new URL("../helper/windows-input.ps1", import.meta.url),
    );
    child = spawn(
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
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: childEnvironmentForStockPowerShell(powershellPath, tempRoot),
      },
    ) as ChildProcessWithoutNullStreams;
    childClose = observeChildClose(child);
    child.on("error", () => {
      childTransportError = true;
    });
    child.stdin.on("error", () => {
      stdinTransportError = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_HELPER_LINE_BYTES) stderrInvalid = true;
    });
    child.stderr.on("error", () => {
      stderrInvalid = true;
    });
    const lines = new HelperLines(child.stdout);
    const ready = parseHelperReady(await waitWithTimeout(lines.next()));
    const topologyFingerprint = hashJson({
      virtualScreen: ready.virtualScreen,
      monitors: ready.monitors,
    });
    const environmentFingerprint = hashJson({
      topologyFingerprint,
      desktop: ready.desktop,
      foreground: ready.foreground,
    });

    const owner = Object.freeze({});
    const prepareSegment = (
      segment: WindowsInputSegment,
    ): PreparedWindowsInputSegment => {
      if (closed || emitted) return fail("input_unproven");
      const compiled = compileWindowsInputSegment(segment, ready.virtualScreen);
      const requestText = `${JSON.stringify({
        kind: "cu.windows-input.request/v1",
        recordsBase64: encodeRecords(compiled.records),
        declaredDelayMs: compiled.declaredDelayMs,
        generatedDragDurationMs: compiled.generatedDragDurationMs,
      })}\n`;
      if (Buffer.byteLength(requestText, "utf8") > MAX_HELPER_REQUEST_BYTES) {
        return fail("input_unproven");
      }
      const prepared = Object.freeze({
        [preparedWindowsInputBrand]: true,
      }) as PreparedWindowsInputSegment;
      preparedWindowsInputs.set(prepared, { owner, compiled, requestText });
      return prepared;
    };
    const emitPrepared = async (
      prepared: PreparedWindowsInputSegment,
    ): Promise<WindowsInputResult> => {
      if (prepared === null || typeof prepared !== "object")
        return fail("input_unproven");
      const preparedState = preparedWindowsInputs.get(prepared);
      if (
        preparedState === undefined ||
        preparedState.owner !== owner ||
        closed ||
        emitted
      ) {
        return fail("input_unproven");
      }
      preparedWindowsInputs.delete(prepared);
      emitted = true;
      const { compiled, requestText } = preparedState;
      let requestMayHaveReachedHelper = false;
      let protocolProven = false;
      try {
        lines.expectRequestBoundary();
        requestMayHaveReachedHelper = true;
        await waitWithTimeout(
          writeHelperChunk(child!.stdin, requestText, false),
          HELPER_PROTOCOL_MARGIN_MS,
        );
        const executionId = `inp_${randomBytes(16).toString("hex")}`;
        const executeText = `${JSON.stringify({
          kind: "cu.windows-input.execute/v1",
          executionId,
        })}\n`;
        await waitWithTimeout(
          writeHelperChunk(child!.stdin, executeText, true),
          HELPER_PROTOCOL_MARGIN_MS,
        );
        const resultBytes = await waitWithTimeout(
          lines.next(),
          compiled.resultTimeoutMs,
        );
        await waitWithTimeout(
          lines.expectCleanEnd(),
          HELPER_PROTOCOL_MARGIN_MS,
        );
        const childResult = await waitWithTimeout(
          childClose!,
          HELPER_PROTOCOL_MARGIN_MS,
        );
        if (
          childResult.code !== 0 ||
          childResult.signal !== null ||
          childTransportError ||
          stdinTransportError ||
          stderrInvalid ||
          stderrBytes !== 0
        )
          return fail("cleanup_unproven");
        const admittedResult = parseHelperResult(
          resultBytes,
          compiled.records.length,
          executionId,
        );
        protocolProven = true;
        const helper = validateAdmittedHelperResult(admittedResult);
        closed = true;
        try {
          rmSync(tempRoot!, { recursive: true, force: true });
        } catch {
          return fail("cleanup_unproven");
        }
        return Object.freeze({
          requestedNativeRecords: helper.requestedNativeRecords,
          acceptedNativeRecords: helper.acceptedNativeRecords,
          emittedActionCount: compiled.emittedActionCount,
          emittedLeafActionCount: compiled.emittedLeafActionCount,
          cleanup: "not_needed",
          heldAfter: Object.freeze([]) as readonly [],
        });
      } catch (error) {
        try {
          await cleanup();
        } catch (cleanupError) {
          if (cleanupError instanceof WindowsInputError) throw cleanupError;
          return fail("cleanup_unproven");
        }
        if (requestMayHaveReachedHelper && !protocolProven)
          return fail("cleanup_unproven");
        if (error instanceof WindowsInputError) throw error;
        return fail(
          requestMayHaveReachedHelper ? "cleanup_unproven" : "helper_lost",
        );
      }
    };

    return Object.freeze({
      environmentFingerprint,
      topologyFingerprint,
      topology: Object.freeze({
        virtualScreen: ready.virtualScreen,
        monitors: ready.monitors,
      }),
      prepareSegment,
      emitPrepared,
      async emitSegment(
        segment: WindowsInputSegment,
      ): Promise<WindowsInputResult> {
        return emitPrepared(prepareSegment(segment));
      },
      async close(): Promise<void> {
        await cleanup();
      },
    });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (cleanupError instanceof WindowsInputError) throw cleanupError;
      return fail("cleanup_unproven");
    }
    if (error instanceof WindowsInputError) throw error;
    return fail();
  }
}
