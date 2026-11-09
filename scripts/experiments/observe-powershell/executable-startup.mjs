// Compare fresh process startup only. These programs do not capture pixels or validate the helper protocol.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const [outputRoot, gcc, pwsh] = process.argv.slice(2);
if (![outputRoot, gcc, pwsh].every((value) => value && isAbsolute(value))) {
  throw new Error("Usage: node scripts/experiments/observe-powershell/executable-startup.mjs NEW_ABSOLUTE_DIRECTORY ABSOLUTE_GCC ABSOLUTE_PWSH");
}
if (existsSync(outputRoot)) throw new Error("Output directory already exists.");
const { stockPowerShellPath } = await import(pathToFileURL(join(repositoryRoot, "dist/test/support/controlled-window.js")));
const stock = stockPowerShellPath();
const compiler = resolve(dirname(stock), "../../../Microsoft.NET/Framework64/v4.0.30319/csc.exe");
mkdirSync(outputRoot, { recursive: true });
const managed = join(outputRoot, "empty-managed.exe");
const native = join(outputRoot, "empty-native.exe");
for (const [executable, args] of [
  [compiler, ["/nologo", "/target:exe", "/optimize+", "/platform:anycpu", `/out:${managed}`, join(here, "EmptyHelper.cs")]],
  [gcc, ["-O2", "-s", "-static-libgcc", join(here, "empty-helper.c"), "-o", native]],
]) {
  const build = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
}
const flags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "exit 0"];
const variants = [
  { name: "ps51", executable: stock, args: flags },
  { name: "ps7", executable: pwsh, args: flags },
  { name: "framework-exe", executable: managed, args: [] },
  { name: "native-exe", executable: native, args: [] },
  { name: "node", executable: process.execPath, args: ["-e", "process.exit(0)"] },
];
const result = { note: "Fresh process, warm filesystem caches. Empty programs only; no capture, PNG, protocol, archive, or validation. Concurrent game/background load is not controlled.", rounds: 20, binaries: { managedBytes: statSync(managed).size, nativeBytes: statSync(native).size }, samples: [] };
const output = join(outputRoot, "results.json");
for (let pair = 0; pair < result.rounds; pair++) {
  const offset = pair % variants.length;
  let order = [...variants.slice(offset), ...variants.slice(0, offset)];
  if (Math.floor(pair / variants.length) % 2) order = order.toReversed();
  for (const variant of order) {
    const start = performance.now();
    const run = spawnSync(variant.executable, variant.args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000 });
    const totalMs = performance.now() - start;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
    result.samples.push({ pair, name: variant.name, totalMs });
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
const median = (values) => { const sorted = values.toSorted((a, b) => a - b); return (sorted[9] + sorted[10]) / 2; };
const times = (name) => result.samples.filter((s) => s.name === name).map((s) => s.totalMs);
result.medians = Object.fromEntries(variants.map((v) => [v.name, median(times(v.name))]));
result.comparisons = variants.slice(1).map((variant) => {
  const saved = times("ps51").map((value, index) => value - times(variant.name)[index]);
  return { baseline: "ps51", candidate: variant.name, pairedMedianSavedMs: median(saved), pairsWon: saved.filter((v) => v > 0).length };
});
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ medians: result.medians, comparisons: result.comparisons, binaries: result.binaries, output }));
