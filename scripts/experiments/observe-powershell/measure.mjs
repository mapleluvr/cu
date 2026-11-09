// Research-only CLI matrix. Each row gets its own growing archive; desktop work stays serial.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [manifestPath, output, roundText, ...selection] = process.argv.slice(2);
const fresh = selection.includes("--fresh");
const names = selection.filter((name) => name !== "--fresh");
const rounds = Number(roundText);
if (!manifestPath || !output || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 100 || names.length < 2 || new Set(names).size !== names.length) {
  throw new Error("Usage: node scripts/experiments/observe-powershell/measure.mjs MANIFEST OUTPUT ROUNDS VARIANT VARIANT [...]");
}
function parseJson(text, context) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`Invalid JSON in ${context}`, { cause }); }
}
const manifest = parseJson(readFileSync(manifestPath, "utf8"), manifestPath);
const variants = names.map((name) => {
  const entry = manifest.variants.find((v) => v.name === name);
  if (!entry) throw new Error(`Unknown variant: ${name}`);
  return { ...entry };
});
const support = await import(pathToFileURL(join(manifest.fixtureRoot ?? repositoryRoot, "dist/test/support/controlled-window.js")));
const { initializeWorkspace } = await import(pathToFileURL(join(repositoryRoot, "dist/src/workspace.js")));
const result = { note: "Complete CLI wall time. Fixture/init/pixel checks excluded. Rotating then reversed order. Fresh mode uses a new initialized workspace for every sample, records failures and continues the finite schedule without retry; growing-history mode stops on failure.", fresh, manifest, rounds, names, samples: [] };
const save = () => writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const median = (values) => {
  const s = values.toSorted((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2;
};
let fixture;
try {
  for (const variant of variants) {
    variant.workspace = mkdtempSync(join(tmpdir(), "cu-runtime-benchmark-"));
    initializeWorkspace(variant.workspace);
  }
  fixture = await support.startControlledWindowFixture();
  const rect = fixture.target;
  result.region = rect;
  const colors = support.deriveControlledPatternColors(fixture.token);
  const pattern = support.readControlledPattern();
  for (let pair = 0; pair < rounds; pair++) {
    const start = pair % variants.length;
    let order = [...variants.slice(start), ...variants.slice(0, start)];
    if (Math.floor(pair / variants.length) % 2) order = order.toReversed();
    for (const variant of order) {
      if (fresh) {
        rmSync(variant.workspace, { recursive: true, force: true });
        variant.workspace = mkdtempSync(join(tmpdir(), "cu-runtime-benchmark-"));
        initializeWorkspace(variant.workspace);
      }
      const before = performance.now();
      const execution = spawnSync(process.execPath, [join(variant.root, "dist/src/cli.js"), "observe", "benchmark", "--region", `pixel:${rect.x},${rect.y},${rect.width},${rect.height}`, "--json"], {
        cwd: variant.workspace, encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1_048_576,
      });
      const sample = { pair, name: variant.name, totalMs: performance.now() - before, status: execution.status };
      result.samples.push(sample);
      if (execution.status !== 0 || execution.stderr !== "") {
        sample.error = execution.stderr + execution.stdout;
        save();
        console.log(JSON.stringify(sample));
        if (fresh) continue;
        throw new Error(sample.error);
      }
      const receipt = parseJson(execution.stdout, `${variant.name} observe receipt`);
      assert.equal(receipt.kind, "cu.observe.result/v1");
      const bytes = readFileSync(join(variant.workspace, receipt.imagePath));
      const decoded = support.decodePngRgba(bytes);
      assert.equal(decoded.width, rect.width);
      assert.equal(decoded.height, rect.height);
      for (const [i, point] of pattern.samples.entries()) {
        assert.deepEqual(support.sampleRgb(decoded, point.x, point.y), colors.target[i]);
      }
      sample.imageBytes = bytes.length;
      sample.pixelsVerified = true;
      save();
      console.log(JSON.stringify(sample));
    }
  }
  assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
  const successes = (name) => result.samples.filter((s) => s.name === name && s.pixelsVerified);
  result.medians = Object.fromEntries(names.map((name) => [name, successes(name).length ? median(successes(name).map((s) => s.totalMs)) : null]));
  result.failures = Object.fromEntries(names.map((name) => [name, rounds - successes(name).length]));
  result.comparisons = [];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
    const matched = successes(names[a]).flatMap((baseline) => {
      const candidate = successes(names[b]).find((s) => s.pair === baseline.pair);
      return candidate ? [{ baseline: baseline.totalMs, candidate: candidate.totalMs }] : [];
    });
    const saved = matched.map((s) => s.baseline - s.candidate);
    result.comparisons.push({ baseline: names[a], candidate: names[b], matchedPairs: saved.length, pairedMedianSavedMs: saved.length ? median(saved) : null, pairsWon: saved.filter((v) => v > 0).length, medianReduction: saved.length ? 1 - median(matched.map((s) => s.candidate)) / median(matched.map((s) => s.baseline)) : null });
  }
  result.complete = true;
  save();
  console.log(JSON.stringify({ medians: result.medians, comparisons: result.comparisons }));
} catch (error) {
  result.complete = false;
  result.error = String(error);
  save();
  throw error;
} finally {
  try { if (fixture) await fixture.stop(); }
  finally { for (const variant of variants) if (variant.workspace) rmSync(variant.workspace, { recursive: true, force: true }); }
}
