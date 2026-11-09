// Run the existing helper behavior tests against experimental runtimes. The fixture itself stays on stock PowerShell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [manifestPath, ...names] = process.argv.slice(2);
if (!manifestPath || !names.length) throw new Error("Usage: node scripts/experiments/observe-powershell/verify.mjs MANIFEST VARIANT [...]");
function parseJson(text, context) {
  try { return JSON.parse(text); }
  catch (cause) { throw new Error(`Invalid JSON in ${context}`, { cause }); }
}
const manifest = parseJson(readFileSync(manifestPath, "utf8"), manifestPath);
let expectedDisplay;
for (const name of names) {
  const variant = manifest.variants.find((v) => v.name === name);
  assert.ok(variant, `Unknown variant ${name}`);
  const original = readFileSync(join(variant.root, "dist/test/windows-capture-helper.test.js"), "utf8");
  assert.ok(original.includes("stockPowerShellPath()"));
  const testPath = join(variant.root, "dist/test/windows-capture-runtime.test.js");
  writeFileSync(testPath, original.replaceAll("stockPowerShellPath()", JSON.stringify(variant.executable)));
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", testPath], { encoding: "utf8", windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 1_048_576 });
  writeFileSync(join(variant.root, "verification.log"), result.stdout + result.stderr);
  console.log(JSON.stringify({ name, status: result.status, log: join(variant.root, "verification.log") }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const query = spawnSync(process.execPath, [join(variant.root, "dist/src/cli.js"), "displays", "--json"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  assert.equal(query.status, 0, query.stderr + query.stdout);
  const display = parseJson(query.stdout, `${name} displays receipt`);
  if (expectedDisplay) assert.deepEqual(display, expectedDisplay);
  else expectedDisplay = display;
}
console.log(JSON.stringify({ displayReceiptsMatch: true, variants: names }));
