import { createHash } from "node:crypto";

import {
  isRegionSelector,
  resolveRegionSelector,
  type PixelRectangle,
  type RegionSelector,
} from "./region.js";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const MAX_MONITORS = 32;
const DISPLAY_ID_PATTERN = /^dsp_[a-f0-9]{32}$/;
const admittedDisplayRegionSelectors = new WeakSet<object>();
const admittedFullScreenSelectors = new WeakSet<object>();

export class DisplaySelectorError extends Error {
  readonly name = "DisplaySelectorError";

  constructor() {
    super("");
  }
}

export class DisplayTopologyError extends Error {
  readonly name = "DisplayTopologyError";

  constructor() {
    super("");
  }
}

export type DisplayMonitor = Readonly<PixelRectangle & { primary: boolean }>;

export type DisplayTopology = Readonly<{
  virtualScreen: PixelRectangle;
  monitors: readonly DisplayMonitor[];
}>;

export type PublicDisplay = Readonly<{
  displayId: string;
  boundsPx: PixelRectangle;
  primary: boolean;
}>;

export type DisplayRegionSelector = Readonly<{
  kind: "display_region";
  displayId: string;
  region: RegionSelector;
}>;

export type FullScreenSelector = Readonly<{
  kind: "full_screen";
  displayIds: readonly string[];
}>;

export type CaptureSelector =
  | RegionSelector
  | DisplayRegionSelector
  | FullScreenSelector;

export type DisplayInventory = Readonly<{
  kind: "cu.displays.result/v1";
  topologyFingerprint: string;
  coordinateSpace: "virtual_screen_pixels";
  virtualScreenPx: PixelRectangle;
  displays: readonly PublicDisplay[];
}>;

function selectorFail(): never {
  throw new DisplaySelectorError();
}

function fail(): never {
  throw new DisplayTopologyError();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail();
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isInt32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= INT32_MIN &&
    value <= INT32_MAX
  );
}

function parseRectangle(value: unknown): PixelRectangle {
  const record = objectValue(value);
  if (
    !hasExactKeys(record, ["x", "y", "width", "height"]) ||
    !isInt32(record.x) ||
    !isInt32(record.y) ||
    !isInt32(record.width) ||
    !isInt32(record.height) ||
    record.width < 1 ||
    record.height < 1 ||
    record.x + record.width > INT32_MAX ||
    record.y + record.height > INT32_MAX
  ) {
    return fail();
  }
  return Object.freeze({
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
  });
}

function isPixelRectangle(value: PixelRectangle): boolean {
  return (
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y) &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.x >= INT32_MIN &&
    value.y >= INT32_MIN &&
    value.width >= 1 &&
    value.height >= 1 &&
    value.x + value.width <= INT32_MAX &&
    value.y + value.height <= INT32_MAX
  );
}

function contains(
  container: PixelRectangle,
  candidate: PixelRectangle,
): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function displayId(topologyFingerprint: string, index: number): string {
  const digest = hashJson({
    kind: "cu.display-id/v1",
    topologyFingerprint,
    index,
  });
  return `dsp_${digest.slice(0, 32)}`;
}

export function isDisplayId(value: unknown): value is string {
  return typeof value === "string" && DISPLAY_ID_PATTERN.test(value);
}

export function bindRegionSelectorToDisplay(
  displayId: string,
  region: RegionSelector,
): DisplayRegionSelector {
  if (!isDisplayId(displayId) || !isRegionSelector(region)) {
    return selectorFail();
  }
  const selector = Object.freeze({
    kind: "display_region" as const,
    displayId,
    region,
  });
  admittedDisplayRegionSelectors.add(selector);
  return selector;
}

export function bindFullScreenSelectorToDisplays(
  displayIds: readonly string[],
): FullScreenSelector {
  if (
    !Array.isArray(displayIds) ||
    displayIds.length < 1 ||
    displayIds.length > MAX_MONITORS ||
    displayIds.some((id) => !isDisplayId(id)) ||
    new Set(displayIds).size !== displayIds.length
  ) {
    return selectorFail();
  }
  const selector = Object.freeze({
    kind: "full_screen" as const,
    displayIds: Object.freeze([...displayIds]),
  });
  admittedFullScreenSelectors.add(selector);
  return selector;
}
export function isCaptureSelector(value: unknown): value is CaptureSelector {
  return (
    isRegionSelector(value) ||
    (value !== null &&
      typeof value === "object" &&
      (admittedDisplayRegionSelectors.has(value) ||
        admittedFullScreenSelectors.has(value)))
  );
}

type AdmittedTopology = Readonly<{
  virtualScreen: PixelRectangle;
  monitors: readonly DisplayMonitor[];
  topologyFingerprint: string;
}>;

function admitTopology(
  value: unknown,
  requireDistinctDisplays: boolean,
): AdmittedTopology {
  const topology = objectValue(value);
  if (!hasExactKeys(topology, ["virtualScreen", "monitors"])) {
    return fail();
  }
  const virtualScreen = parseRectangle(topology.virtualScreen);
  if (
    !Array.isArray(topology.monitors) ||
    topology.monitors.length < 1 ||
    topology.monitors.length > MAX_MONITORS
  ) {
    return fail();
  }

  const monitors = topology.monitors.map((value) => {
    const monitor = objectValue(value);
    if (
      !hasExactKeys(monitor, ["x", "y", "width", "height", "primary"]) ||
      typeof monitor.primary !== "boolean"
    ) {
      return fail();
    }
    const bounds = parseRectangle({
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
    });
    if (!contains(virtualScreen, bounds)) {
      return fail();
    }
    return Object.freeze({ ...bounds, primary: monitor.primary });
  });

  const distinctPlacementCount = new Set(
    monitors.map(({ x, y, width, height }) =>
      JSON.stringify({ x, y, width, height }),
    ),
  ).size;
  if (
    monitors.filter((monitor) => monitor.primary).length !== 1 ||
    (requireDistinctDisplays && distinctPlacementCount !== monitors.length)
  ) {
    return fail();
  }

  const stableTopology = Object.freeze({
    virtualScreen,
    monitors: Object.freeze(monitors),
  });
  return Object.freeze({
    ...stableTopology,
    topologyFingerprint: hashJson(stableTopology),
  });
}

export function deriveTopologyFingerprint(value: unknown): string {
  return admitTopology(value, false).topologyFingerprint;
}

export function resolveCaptureSelector(
  selector: CaptureSelector,
  topology: unknown,
): PixelRectangle {
  if (!isCaptureSelector(selector)) {
    return selectorFail();
  }
  if (isRegionSelector(selector)) {
    return resolveRegionSelector(
      selector,
      admitTopology(topology, false).virtualScreen,
    );
  }

  const inventory = deriveDisplayInventory(topology);
  if (selector.kind === "display_region") {
    const display = inventory.displays.find(
      (candidate) => candidate.displayId === selector.displayId,
    );
    if (display === undefined) {
      return selectorFail();
    }
    const resolved = resolveRegionSelector(
      selector.region,
      inventory.virtualScreenPx,
    );
    if (!contains(display.boundsPx, resolved)) {
      return selectorFail();
    }
    return resolved;
  }

  const selectedDisplays: PublicDisplay[] = [];
  for (const displayId of selector.displayIds) {
    const display = inventory.displays.find(
      (candidate) => candidate.displayId === displayId,
    );
    if (
      display === undefined ||
      selectedDisplays.some(
        ({ displayId: selectedId }) => selectedId === displayId,
      )
    ) {
      return selectorFail();
    }
    selectedDisplays.push(display);
  }
  return Object.freeze(unionDisplayBounds(selectedDisplays));
}

export function deriveDisplayInventory(value: unknown): DisplayInventory {
  const topology = admitTopology(value, true);
  const displays = topology.monitors.map((monitor, index) =>
    Object.freeze({
      displayId: displayId(topology.topologyFingerprint, index),
      boundsPx: Object.freeze({
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
      }),
      primary: monitor.primary,
    }),
  );

  return Object.freeze({
    kind: "cu.displays.result/v1",
    topologyFingerprint: topology.topologyFingerprint,
    coordinateSpace: "virtual_screen_pixels",
    virtualScreenPx: topology.virtualScreen,
    displays: Object.freeze(displays),
  });
}

function unionDisplayBounds(
  displays: readonly PublicDisplay[],
): PixelRectangle {
  const left = Math.min(...displays.map(({ boundsPx }) => boundsPx.x));
  const top = Math.min(...displays.map(({ boundsPx }) => boundsPx.y));
  const right = Math.max(
    ...displays.map(({ boundsPx }) => boundsPx.x + boundsPx.width),
  );
  const bottom = Math.max(
    ...displays.map(({ boundsPx }) => boundsPx.y + boundsPx.height),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fullScreenSelectorForBounds(
  bounds: PixelRectangle,
  topology: unknown,
): FullScreenSelector {
  if (!isPixelRectangle(bounds)) {
    return selectorFail();
  }
  const inventory = deriveDisplayInventory(topology);
  if (!contains(inventory.virtualScreenPx, bounds)) {
    return selectorFail();
  }
  const selected = inventory.displays.filter(({ boundsPx }) =>
    contains(bounds, boundsPx),
  );
  if (
    selected.length < 1 ||
    JSON.stringify(unionDisplayBounds(selected)) !== JSON.stringify(bounds)
  ) {
    return selectorFail();
  }
  return bindFullScreenSelectorToDisplays(
    selected.map(({ displayId }) => displayId),
  );
}
