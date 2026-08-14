const MAX_DECLARED_DELAY_MS = 30_000;
const MAX_GENERATED_DRAG_DURATION_MS = 5_000;
const PROTOCOL_MARGIN_MS = 15_000;

export class WindowsInputTimingError extends Error {
  readonly name = "WindowsInputTimingError";

  constructor() {
    super("");
  }
}

export type WindowsInputTiming = Readonly<{
  declaredDelayMs: number;
  generatedDragDurationMs: number;
  totalDelayMs: number;
  resultTimeoutMs: number;
}>;

function requireDuration(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new WindowsInputTimingError();
  }
  return value;
}

export function admitWindowsInputTiming(
  declaredDelayMs: number,
  generatedDragDurationMs: number
): WindowsInputTiming {
  const declared = requireDuration(declaredDelayMs, MAX_DECLARED_DELAY_MS);
  const generated = requireDuration(
    generatedDragDurationMs,
    MAX_GENERATED_DRAG_DURATION_MS
  );
  const totalDelayMs = declared + generated;
  return Object.freeze({
    declaredDelayMs: declared,
    generatedDragDurationMs: generated,
    totalDelayMs,
    resultTimeoutMs: totalDelayMs + PROTOCOL_MARGIN_MS
  });
}
