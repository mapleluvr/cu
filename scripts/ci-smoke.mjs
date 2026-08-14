import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function expectedCompiledFiles(sourceRoot, outputRoot) {
  return listFiles(sourceRoot)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => resolve(outputRoot, relative(sourceRoot, path).replace(/\.ts$/u, ".js")))
    .sort();
}

function actualCompiledFiles(outputRoot) {
  return listFiles(outputRoot)
    .filter((path) => path.endsWith(".js"))
    .map((path) => resolve(path))
    .sort();
}

assert.deepEqual(
  actualCompiledFiles(resolve(repositoryRoot, "dist", "src")),
  expectedCompiledFiles(resolve(repositoryRoot, "src"), resolve(repositoryRoot, "dist", "src")),
  "dist/src must exactly match the current TypeScript source set"
);
assert.deepEqual(
  actualCompiledFiles(resolve(repositoryRoot, "dist", "test")),
  expectedCompiledFiles(resolve(repositoryRoot, "test"), resolve(repositoryRoot, "dist", "test")),
  "dist/test must exactly match the current TypeScript test set"
);

for (const helper of ["windows-capture.ps1", "windows-input.ps1"]) {
  assert.deepEqual(
    readFileSync(resolve(repositoryRoot, "dist", "helper", helper)),
    readFileSync(resolve(repositoryRoot, "src", "helper", helper)),
    `${helper} must byte-match its reviewed source asset`
  );
}

const workspace = mkdtempSync(join(tmpdir(), "cu-ci-smoke-"));
try {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "dist", "src", "cli.js"), "help", "--json"],
    { cwd: workspace, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.help.result/v1",
    topics: [
      "init",
      "displays",
      "observe",
      "act",
      "action-file",
      "history",
      "status",
      "clear",
      "clearall"
    ]
  });
  assert.equal(existsSync(resolve(workspace, ".cu")), false);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write("CI smoke passed\n");
