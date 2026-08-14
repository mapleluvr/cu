const CANONICAL_UNSIGNED = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_SIGNED = /^(?:0|-?[1-9][0-9]*)$/;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const MAX_CAPTURE_DIMENSION = 4096;
const admittedRegionSelectors = new WeakSet<object>();

export class RegionSelectorError extends Error {
  readonly name = "RegionSelectorError";

  constructor() {
    super("");
  }
}

export type NormalizedRegionSelector = Readonly<{
  kind: "normalized";
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type PixelRegionSelector = Readonly<{
  kind: "pixel";
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type RegionSelector = NormalizedRegionSelector | PixelRegionSelector;

export type PixelRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

function fail(): never {
  throw new RegionSelectorError();
}

function admitRegionSelector<T extends RegionSelector>(selector: T): T {
  const admitted = Object.freeze(selector);
  admittedRegionSelectors.add(admitted);
  return admitted;
}

export function isRegionSelector(value: unknown): value is RegionSelector {
  return value !== null && typeof value === "object" && admittedRegionSelectors.has(value);
}

function parseCanonicalUnsigned(value: string, maximum: number): number {
  if (!CANONICAL_UNSIGNED.test(value)) {
    return fail();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return fail();
  }
  return parsed;
}

function parseCanonicalSigned(value: string): number {
  if (!CANONICAL_SIGNED.test(value)) {
    return fail();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < INT32_MIN || parsed > INT32_MAX) {
    return fail();
  }
  return parsed;
}

export function parseRegionSelector(value: string): RegionSelector {
  if (typeof value !== "string") {
    return fail();
  }
  const separator = value.indexOf(":");
  if (separator < 1 || value.indexOf(":", separator + 1) !== -1) {
    return fail();
  }
  const kind = value.slice(0, separator);
  const parts = value.slice(separator + 1).split(",");
  if (parts.length !== 4) {
    return fail();
  }

  if (kind === "normalized") {
    const left = parseCanonicalUnsigned(parts[0]!, 999);
    const top = parseCanonicalUnsigned(parts[1]!, 999);
    const right = parseCanonicalUnsigned(parts[2]!, 999);
    const bottom = parseCanonicalUnsigned(parts[3]!, 999);
    if (left > right || top > bottom) {
      return fail();
    }
    return admitRegionSelector({ kind, left, top, right, bottom });
  }

  if (kind === "pixel") {
    const left = parseCanonicalSigned(parts[0]!);
    const top = parseCanonicalSigned(parts[1]!);
    const width = parseCanonicalUnsigned(parts[2]!, MAX_CAPTURE_DIMENSION);
    const height = parseCanonicalUnsigned(parts[3]!, MAX_CAPTURE_DIMENSION);
    if (width < 1 || height < 1) {
      return fail();
    }
    return admitRegionSelector({ kind, left, top, width, height });
  }

  return fail();
}

function isPixelRectangle(value: PixelRectangle): boolean {
  return (
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y) &&
    Number.isSafeInteger(value.width) &&
    Number.isSafeInteger(value.height) &&
    value.x >= INT32_MIN &&
    value.y >= INT32_MIN &&
    value.x <= INT32_MAX &&
    value.y <= INT32_MAX &&
    value.width >= 1 &&
    value.height >= 1 &&
    value.width <= INT32_MAX &&
    value.height <= INT32_MAX &&
    value.x + value.width <= INT32_MAX &&
    value.y + value.height <= INT32_MAX
  );
}

function contains(container: PixelRectangle, candidate: PixelRectangle): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  );
}

function covers(candidate: PixelRectangle, target: PixelRectangle): boolean {
  return (
    candidate.x <= target.x &&
    candidate.y <= target.y &&
    candidate.x + candidate.width >= target.x + target.width &&
    candidate.y + candidate.height >= target.y + target.height
  );
}

export function resolveRegionSelector(
  selector: RegionSelector,
  virtualScreen: PixelRectangle
): PixelRectangle {
  if (!isPixelRectangle(virtualScreen)) {
    return fail();
  }

  let resolved: PixelRectangle;
  if (selector.kind === "pixel") {
    resolved = {
      x: selector.left,
      y: selector.top,
      width: selector.width,
      height: selector.height
    };
  } else {
    const localLeft = Math.floor((selector.left * (virtualScreen.width - 1)) / 999);
    const localTop = Math.floor((selector.top * (virtualScreen.height - 1)) / 999);
    const localRightExclusive = Math.min(
      virtualScreen.width,
      Math.ceil((selector.right * (virtualScreen.width - 1)) / 999) + 1
    );
    const localBottomExclusive = Math.min(
      virtualScreen.height,
      Math.ceil((selector.bottom * (virtualScreen.height - 1)) / 999) + 1
    );
    resolved = {
      x: virtualScreen.x + localLeft,
      y: virtualScreen.y + localTop,
      width: localRightExclusive - localLeft,
      height: localBottomExclusive - localTop
    };
  }

  if (
    !isPixelRectangle(resolved) ||
    resolved.width > MAX_CAPTURE_DIMENSION ||
    resolved.height > MAX_CAPTURE_DIMENSION ||
    !contains(virtualScreen, resolved) ||
    covers(resolved, virtualScreen)
  ) {
    return fail();
  }
  return Object.freeze(resolved);
}
