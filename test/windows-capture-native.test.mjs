import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.CU_NATIVE_HELPER_TEST_PATH ?? join(repo, "dist/helper/cu-capture.exe");
const support = await import(pathToFileURL(join(repo, "dist/test/support/controlled-window.js")));
const { deriveDisplayInventory } = await import(pathToFileURL(join(repo, "dist/src/display.js")));
const requestId = `req_${"a".repeat(32)}`;
function run(text, temp) {
  return spawnSync(executable, [], { input: text, encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000, env: { ...process.env, TEMP: temp, TMP: temp } });
}
function json(text) { try { return JSON.parse(text); } catch (cause) { throw new Error("Invalid helper JSON", { cause }); } }
function query(temp) {
  const result = run(`${JSON.stringify({ kind: "cu.windows-display.request/v1", requestId })}\n`, temp);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const receipt = json(result.stdout);
  assert.equal(receipt.kind, "cu.windows-display.result/v1");
  assert.equal(receipt.requestId, requestId);
  return receipt;
}

test("native displays returns a validated inventory without creating a file", () => {
  const root = mkdtempSync(join(tmpdir(), "cu-native-display-"));
  try {
    const receipt = query(root);
    const inventory = deriveDisplayInventory({ virtualScreen: receipt.virtualScreen, monitors: receipt.monitors });
    assert.ok(inventory.displays.length > 0);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native helper rejects malformed private transport and selectors before creating files", () => {
  const root = mkdtempSync(join(tmpdir(), "cu-native-reject-"));
  try {
    const base = { kind: "cu.windows-capture.request/v1", requestId, destinationPath: join(root, "capture.png"), selector: { kind: "pixel", left: 0, top: 0, width: 1, height: 1 } };
    const encode = (value) => `${JSON.stringify(value)}\n`;
    const good = encode(base);
    const variants = [
      "", "{}\n", good.trimEnd(), good + "\n", " " + good, good + "{}", "\ufeff" + good,
      good.replace('"width":1', '"width":1.0'), good.replace('"width":1', '"width":1e0'),
      good.replace('"left":0', '"left":-0'), good.replace('"kind":', '"kind":"ignored","kind":'),
      good.replace('"selector":', '"unknown":0,"selector":'),
      good.replace('"pixel"', '"p\\u0069xel"'), Buffer.from([0xff, 0xfe]), "x".repeat(65_537),
      encode({ ...base, kind: [base.kind] }), encode({ ...base, requestId: [requestId] }),
      encode({ ...base, requestId: `req_${"A".repeat(32)}` }),
      ...[
        null, [], { ...base.selector, kind: ["pixel"] }, { ...base.selector, Width: 1 },
        { ...base.selector, width: 0 }, { ...base.selector, width: 4097 }, { ...base.selector, left: 2147483648 },
        { ...base.selector, height: true }, { kind: "normalized", left: 999, top: 0, right: 0, bottom: 999 },
        { kind: "full_screen", displayIds: [] }, { kind: "full_screen", displayIds: [`dsp_${"0".repeat(32)}`, `dsp_${"0".repeat(32)}`] },
        { kind: "display_region", displayId: `dsp_${"0".repeat(32)}`, region: base.selector },
      ].map((selector) => encode({ ...base, selector })),
    ];
    for (const [index, value] of variants.entries()) {
      const result = run(value, root);
      assert.equal(result.status, 3, `case ${index}: ${result.stderr}`);
      assert.equal(result.stdout, "", `case ${index}`);
      assert.equal(result.stderr.trim(), "capture_failed", `case ${index}`);
      assert.deepEqual(readdirSync(root), [], `case ${index}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native helper preserves existing or out-of-TEMP destination bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cu-native-path-"));
  const temp = join(root, "temp"); mkdirSync(temp);
  const inside = join(temp, "keep.png"), outside = join(root, "keep.png");
  writeFileSync(inside, "inside"); writeFileSync(outside, "outside");
  try {
    for (const destinationPath of [inside, outside, join(temp, "new.png:stream"), join(temp, "new.PNG")]) {
      const result = run(`${JSON.stringify({ kind: "cu.windows-capture.request/v1", requestId, destinationPath, selector: { kind: "pixel", left: 0, top: 0, width: 1, height: 1 } })}\n`, temp);
      assert.equal(result.status, 3, result.stderr);
    }
    assert.equal(readFileSync(inside, "utf8"), "inside");
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.deepEqual(readdirSync(temp), ["keep.png"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native capture preserves actual pixels, Unicode paths and display-bound authority", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cu-native-pixels-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temp = join(root, "中文 空格"); mkdirSync(temp);
  const fixture = await support.startControlledWindowFixture();
  try {
    const topology = query(temp);
    const inventory = deriveDisplayInventory({ virtualScreen: topology.virtualScreen, monitors: topology.monitors });
    const r = fixture.target;
    const display = inventory.displays.find(({ boundsPx: b }) => r.x >= b.x && r.y >= b.y && r.x + r.width <= b.x + b.width && r.y + r.height <= b.y + b.height);
    assert.ok(display);
    const region = { kind: "pixel", left: r.x, top: r.y, width: r.width, height: r.height };
    for (const [index, selector] of [region, { kind: "display_region", displayId: display.displayId, region }].entries()) {
      const destinationPath = join(temp, `截图-${index}.png`);
      const result = run(`${JSON.stringify({ kind: "cu.windows-capture.request/v1", requestId, destinationPath, selector })}\n`, temp);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const receipt = json(result.stdout), bytes = readFileSync(destinationPath);
      assert.deepEqual(receipt.sourceRectPx, r);
      assert.equal(receipt.destinationPath, destinationPath);
      assert.equal(receipt.image.byteLength, bytes.length);
      assert.equal(receipt.image.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.deepEqual(receipt.desktop, { interactive: true, connected: true, kind: "default", sessionId: receipt.desktop.sessionId, desktopName: "Default" });
      const decoded = support.decodePngRgba(bytes), colors = support.deriveControlledPatternColors(fixture.token);
      assert.equal(decoded.width, r.width); assert.equal(decoded.height, r.height);
      for (const [i, point] of support.readControlledPattern().samples.entries()) assert.deepEqual(support.sampleRgb(decoded, point.x, point.y), colors.target[i]);
    }
    assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
  } finally { await fixture.stop(); }
});
