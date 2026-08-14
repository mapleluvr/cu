import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyValidatedCaptureBundleBytes } from "../src/capture-bundle.js";
import { parseRegionSelector } from "../src/region.js";
import { captureRegionalObservation } from "../src/windows-capture.js";
import {
  decodePngRgba,
  deriveControlledPatternColors,
  readControlledPattern,
  sampleRgb,
  startControlledWindowFixture
} from "./support/controlled-window.js";

async function captureFixtureTarget() {
  const fixture = await startControlledWindowFixture();
  try {
    const captured = await captureRegionalObservation({
      selector: parseRegionSelector(
        `pixel:${fixture.target.x},${fixture.target.y},${fixture.target.width},${fixture.target.height}`
      ),
      runId: "work-a",
      workspaceFingerprint: "b".repeat(64)
    });
    return { fixture, captured };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

test(
  "stock helper captures token-derived controlled target pixels and excludes decoy pixels",
  { skip: process.platform !== "win32" },
  async (t) => {
    const beforeTemp = readdirSync(tmpdir()).filter((entry) => entry.startsWith("cu-capture-")).sort();
    const { fixture, captured } = await captureFixtureTarget();
    t.after(async () => fixture.stop());
    const copied = copyValidatedCaptureBundleBytes(captured.bundle);
    const decoded = decodePngRgba(copied.image);
    const pattern = readControlledPattern();
    const colors = deriveControlledPatternColors(fixture.token);

    assert.equal(decoded.width, fixture.target.width);
    assert.equal(decoded.height, fixture.target.height);
    assert.deepEqual(captured.sourceRectPx, fixture.target);
    for (const [index, sample] of pattern.samples.entries()) {
      assert.deepEqual(
        sampleRgb(decoded, sample.x, sample.y),
        colors.target[index],
        `${fixture.token}:${sample.x},${sample.y}`
      );
      assert.notDeepEqual(
        sampleRgb(decoded, sample.x, sample.y),
        colors.decoy[index],
        `decoy ${fixture.token}:${sample.x},${sample.y}`
      );
    }
    assert.deepEqual(
      readdirSync(tmpdir()).filter((entry) => entry.startsWith("cu-capture-")).sort(),
      beforeTemp
    );
  }
);

test(
  "fixture and stock helper ignore a spoofed SystemRoot before either child starts",
  { skip: process.platform !== "win32" },
  async (t) => {
    const originalEntries = Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() === "systemroot" || key.toLowerCase() === "windir"
    );
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === "systemroot" || key.toLowerCase() === "windir") {
        delete process.env[key];
      }
    }
    process.env.SYSTEMROOT = join(tmpdir(), "cu-attacker-system-root");
    process.env.WINDIR = join(tmpdir(), "cu-attacker-windir");
    try {
      const { fixture, captured } = await captureFixtureTarget();
      t.after(async () => fixture.stop());
      assert.deepEqual(captured.sourceRectPx, fixture.target);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.toLowerCase() === "systemroot" || key.toLowerCase() === "windir") {
          delete process.env[key];
        }
      }
      for (const [key, value] of originalEntries) {
        process.env[key] = value;
      }
    }
  }
);
