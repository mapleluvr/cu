import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { openWindowsInputSession, WindowsInputError } from "../src/windows-input.js";
import { startControlledWindowFixture } from "./support/controlled-window.js";

function inputTempRoots(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("cu-input-"));
}

test("helper refuses persistent foreground drift after ready without emitting input", { concurrency: false }, async () => {
  if (process.platform !== "win32") return;
  const beforeTemps = inputTempRoots();
  const fixture = await startControlledWindowFixture();
  try {
    await fixture.waitForQuiet();
    const session = await openWindowsInputSession();
    let actualError: unknown;
    try {
      await fixture.focus("decoy");
      await session.emitSegment({
        source: {
          mapping: "normalized_endpoint_centers/v1",
          leftPx: fixture.target.x,
          topPx: fixture.target.y,
          widthPx: fixture.target.width,
          heightPx: fixture.target.height
        },
        actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
      });
    } catch (error) {
      actualError = error;
    } finally {
      await session.close();
    }

    assert.ok(actualError instanceof WindowsInputError && actualError.message === "");
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
    assert.deepEqual(inputTempRoots(), beforeTemps);
  } finally {
    await fixture.stop();
  }
});

test("command-scoped helper emits one exact controlled target click and leaves decoy, holds, and TEMP empty", { concurrency: false }, async () => {
  if (process.platform !== "win32") return;
  const beforeTemps = inputTempRoots();
  const fixture = await startControlledWindowFixture();
  try {
    await fixture.waitForQuiet();
    const session = await openWindowsInputSession();
    let result;
    try {
      assert.match(session.environmentFingerprint, /^[a-f0-9]{64}$/);
      assert.match(session.topologyFingerprint, /^[a-f0-9]{64}$/);
      result = await session.emitSegment({
        source: {
          mapping: "normalized_endpoint_centers/v1",
          leftPx: fixture.target.x,
          topPx: fixture.target.y,
          widthPx: fixture.target.width,
          heightPx: fixture.target.height
        },
        actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
      });
    } finally {
      await session.close();
    }

    assert.deepEqual(result, {
      requestedNativeRecords: 3,
      acceptedNativeRecords: 3,
      emittedActionCount: 1,
      emittedLeafActionCount: 1,
      cleanup: "not_needed",
      heldAfter: []
    });
    const events = await fixture.snapshotAndClear();
    assert.deepEqual(events.target, [
      { kind: "click", button: "left", x: 199, y: 149, count: 1 }
    ]);
    assert.deepEqual(events.decoy, []);
    assert.deepEqual(inputTempRoots(), beforeTemps);
  } finally {
    await fixture.stop();
  }
});
