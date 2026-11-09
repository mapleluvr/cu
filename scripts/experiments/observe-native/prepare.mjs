// Build independent baseline/native copies for the shared observe matrix runner.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [destination, size = "small"] = process.argv.slice(2);
if (!destination || !isAbsolute(destination) || !["small", "large"].includes(size)) throw new Error("Usage: node scripts/experiments/observe-native/prepare.mjs NEW_ABSOLUTE_DIRECTORY [small|large]");
if (existsSync(destination)) throw new Error("Output directory must not exist.");
const { stockPowerShellPath } = await import(pathToFileURL(join(repositoryRoot, "dist/test/support/controlled-window.js")));
const stock = stockPowerShellPath();
mkdirSync(destination, { recursive: true });
const replace = (text, old, next) => { assert.equal(text.split(old).length, 2, `Source adaptation changed: ${old}`); return text.replace(old, next); };
const variants = [];
for (const name of ["ps51", "native"]) {
  const root = join(destination, name);
  mkdirSync(root);
  cpSync(join(repositoryRoot, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(repositoryRoot, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
  cpSync(join(repositoryRoot, "package.json"), join(root, "package.json"));
  if (name === "ps51") {
    const path = join(root, "dist/src/windows-capture.js");
    let source = replace(readFileSync(path, "utf8"), 'new URL("../helper/cu-capture.exe", import.meta.url)', 'new URL("../helper/windows-capture.ps1", import.meta.url)');
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
    source = replace(source, "spawnSync(helperPath, [], {", `spawnSync(${JSON.stringify(stock)}, [...${JSON.stringify(args)}, helperPath], {`);
    writeFileSync(path, source);
  }
  variants.push({ name, root });
}
const fixtureRoot = variants[1].root;
if (size === "large") {
  const fixture = join(fixtureRoot, "test/fixtures/controlled-window/fixture.ps1");
  let source = readFileSync(fixture, "utf8");
  for (const [old, next] of [["Size(400, 300)", "Size(1280, 720)"], ["{ 0 } else { 200 }", "{ 0 } else { 640 }"], ["{ 0 } else { 150 }", "{ 0 } else { 360 }"], ["$x, $y, 200, 150)", "$x, $y, 640, 360)"]]) source = replace(source, old, next);
  writeFileSync(fixture, source);
  const patternPath = join(fixtureRoot, "test/fixtures/controlled-window/pattern.json");
  let pattern;
  try { pattern = JSON.parse(readFileSync(patternPath, "utf8")); }
  catch (cause) { throw new Error("Invalid fixture pattern", { cause }); }
  pattern.width = 1280;
  pattern.height = 720;
  pattern.samples.forEach((point) => { point.x = Math.round(point.x * 1280 / 400); point.y = Math.round(point.y * 720 / 300); });
  writeFileSync(patternPath, `${JSON.stringify(pattern, null, 2)}\n`);
}
writeFileSync(join(destination, "manifest.json"), `${JSON.stringify({ note: "Native vs legacy PowerShell with identical current parent validation and archive code. Fixture changes only in this experiment copy.", fixtureRoot, variants }, null, 2)}\n`);
console.log(join(destination, "manifest.json"));
