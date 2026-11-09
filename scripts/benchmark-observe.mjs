// Development-only live benchmark. Capture only the repository-owned fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < argumentsList.length; index += 2) {
  const name = argumentsList[index];
  const value = argumentsList[index + 1];
  if (!["--baseline", "--candidate", "--rounds", "--output"].includes(name) || value === undefined || options.has(name)) {
    throw new Error("Usage: node scripts/benchmark-observe.mjs [--baseline BUILT_ROOT] [--candidate BUILT_ROOT] [--rounds N] [--output FILE]");
  }
  options.set(name, value);
}
const rounds = Number(options.get("--rounds") ?? 12);
if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 100) {
  throw new Error("--rounds must be an integer in 3..100");
}
if (process.platform !== "win32") throw new Error("This benchmark needs an interactive Windows desktop.");

const fixtureSupport = await import(pathToFileURL(join(repositoryRoot, "dist/test/support/controlled-window.js")));
const { initializeWorkspace } = await import(pathToFileURL(join(repositoryRoot, "dist/src/workspace.js")));
const variants = [
  ...(options.has("--baseline") ? [{ name: "baseline", root: resolve(options.get("--baseline")) }] : []),
  { name: "candidate", root: resolve(options.get("--candidate") ?? repositoryRoot) },
];
for (const variant of variants) {
  // Fail on a missing build before opening a desktop window.
  readFileSync(join(variant.root, "dist/src/cli.js"));
  assert.ok(existsSync(join(variant.root, "dist/helper/cu-capture.exe")) || existsSync(join(variant.root, "dist/helper/windows-capture.ps1")), "capture build missing");
}

const samples = [];
let fixture;
try {
  for (const variant of variants) {
    variant.workspace = mkdtempSync(join(tmpdir(), "cu-observe-benchmark-"));
    initializeWorkspace(variant.workspace);
  }
  fixture = await fixtureSupport.startControlledWindowFixture();
  const rectangle = fixture.target;
  const selector = `pixel:${rectangle.x},${rectangle.y},${rectangle.width},${rectangle.height}`;
  const colors = fixtureSupport.deriveControlledPatternColors(fixture.token);
  const pattern = fixtureSupport.readControlledPattern();
  for (let pair = 0; pair < rounds; pair += 1) {
    // Alternate AB/BA, keep retained-history counts equal, and never compete for desktop input.
    const order = pair % 2 === 0 ? variants : variants.toReversed();
    for (const variant of order) {
      const started = performance.now();
      const execution = spawnSync(
        process.execPath,
        [join(variant.root, "dist/src/cli.js"), "observe", "benchmark", "--region", selector, "--json"],
        { cwd: variant.workspace, encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 1_048_576 },
      );
      const totalMs = performance.now() - started;
      assert.equal(execution.status, 0, execution.stderr + execution.stdout);
      assert.equal(execution.stderr, "");
      const receipt = JSON.parse(execution.stdout);
      assert.equal(receipt.kind, "cu.observe.result/v1");
      const bytes = readFileSync(join(variant.workspace, receipt.imagePath));
      const decoded = fixtureSupport.decodePngRgba(bytes);
      assert.equal(decoded.width, rectangle.width);
      assert.equal(decoded.height, rectangle.height);
      for (const [index, point] of pattern.samples.entries()) {
        assert.deepEqual(fixtureSupport.sampleRgb(decoded, point.x, point.y), colors.target[index]);
      }
      const sample = { pair, variant: variant.name, totalMs, imageBytes: bytes.length, pixelsVerified: true };
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  };
  const timings = (name) => samples.filter((sample) => sample.variant === name).map((sample) => sample.totalMs);
  const summary = {
    rounds,
    region: rectangle,
    candidateMedianMs: median(timings("candidate")),
    candidateMinMs: Math.min(...timings("candidate")),
    candidateMaxMs: Math.max(...timings("candidate")),
  };
  if (options.has("--baseline")) {
    summary.baselineMedianMs = median(timings("baseline"));
    const saved = Array.from({ length: rounds }, (_, pair) => {
      const baseline = samples.find((sample) => sample.pair === pair && sample.variant === "baseline");
      const candidate = samples.find((sample) => sample.pair === pair && sample.variant === "candidate");
      return baseline.totalMs - candidate.totalMs;
    });
    summary.pairedMedianSavedMs = median(saved);
    summary.pairsWon = saved.filter((value) => value > 0).length;
    summary.reduction = 1 - summary.candidateMedianMs / summary.baselineMedianMs;
  }
  const result = {
    note: "CLI child process wall time; fixture setup, init, independent PNG verification and cleanup excluded. Equal growing histories; AB/BA ordering; no input injected.",
    runtimes: variants.map(({ name, root }) => ({ name, root })),
    summary,
    samples,
  };
  if (options.has("--output")) writeFileSync(resolve(options.get("--output")), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} finally {
  try {
    if (fixture !== undefined) await fixture.stop();
  } finally {
    for (const variant of variants) {
      if (variant.workspace !== undefined) rmSync(variant.workspace, { recursive: true, force: true });
    }
  }
}
