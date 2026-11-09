// Fresh-process startup floor; no desktop capture and no helper script execution.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const [output, stock, pwsh] = process.argv.slice(2);
if (!output || !stock || !pwsh) throw new Error("Usage: node scripts/experiments/observe-powershell/startup.mjs OUTPUT STOCK_EXE PWSH_EXE");
const variants = [{ name: "ps51", executable: stock }, { name: "ps7", executable: pwsh }];
const samples = [];
for (let pair = 0; pair < 16; pair++) {
  for (const variant of pair % 2 ? variants.toReversed() : variants) {
    const start = performance.now();
    const run = spawnSync(variant.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "exit 0"], { windowsHide: true, shell: false, encoding: "utf8", timeout: 30_000 });
    const totalMs = performance.now() - start;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
    samples.push({ pair, name: variant.name, totalMs });
  }
}
const median = (a) => { const s = a.toSorted((a, b) => a - b); return (s[7] + s[8]) / 2; };
const summary = Object.fromEntries(variants.map(({ name }) => [name, median(samples.filter((s) => s.name === name).map((s) => s.totalMs))]));
writeFileSync(output, `${JSON.stringify({ note: "Fresh process, warm OS caches, exit 0; game/background load retained.", summary, samples }, null, 2)}\n`);
console.log(JSON.stringify(summary));
