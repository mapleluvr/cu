import assert from "node:assert/strict";
import test from "node:test";

import { admitWindowsInputTiming } from "../src/windows-input-timing.js";

function isEmptyTimingError(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "WindowsInputTimingError" &&
    error.message === "";
}

test("rejects declared sequence delay above the authoritative 30000ms limit", () => {
  assert.throws(
    () => admitWindowsInputTiming(35_000, 0),
    (error: unknown) => isEmptyTimingError(error) && Object.keys(error as object).length === 1
  );
});

test("admits 30000ms declared delay plus one 5000ms generated drag within a bounded deadline", () => {
  const timing = admitWindowsInputTiming(30_000, 5_000);
  assert.deepEqual(timing, {
    declaredDelayMs: 30_000,
    generatedDragDurationMs: 5_000,
    totalDelayMs: 35_000,
    resultTimeoutMs: 50_000
  });
  assert.ok(Object.isFrozen(timing));
});

test("rejects malformed timing values without widening either independent ceiling", () => {
  for (const values of [
    [-1, 0],
    [30_001, 0],
    [0, -1],
    [0, 5_001],
    [Number.NaN, 0],
    [0, 1.5]
  ] as const) {
    assert.throws(
      () => admitWindowsInputTiming(values[0], values[1]),
      isEmptyTimingError
    );
  }
});
