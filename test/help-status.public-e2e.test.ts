import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function quoteForCmd(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function runNpm(cwd: string, args: readonly string[]) {
  if (process.platform !== "win32") {
    return spawnSync("npm", args, { cwd, encoding: "utf8", shell: false });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `npm ${args.map(quoteForCmd).join(" ")}`],
    { cwd, encoding: "utf8", windowsHide: true }
  );
}

function runInstalledCli(cliPath: string, workspace: string, args: readonly string[]) {
  if (process.platform !== "win32") {
    return spawnSync(cliPath, args, { cwd: workspace, encoding: "utf8", shell: false });
  }
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `${quoteForCmd(cliPath)} ${args.map(quoteForCmd).join(" ")}`],
    {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true
    }
  );
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      if (lstatSync(path).isDirectory()) {
        snapshot[`${relative}/`] = "";
        walk(path, relative);
      } else {
        snapshot[relative] = readFileSync(path).toString("hex");
      }
    }
  };
  walk(root, "");
  return snapshot;
}

test(
  "installed CLI exposes topic help and useful read-only human status",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "cu-help-status-public-e2e-"));
    const packDirectory = join(root, "pack");
    const installDirectory = join(root, "install");
    const workspace = join(root, "workspace");
    for (const path of [packDirectory, installDirectory, workspace]) {
      mkdirSync(path, { recursive: true });
    }
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const packed = runNpm(repositoryRoot, ["pack", "--pack-destination", packDirectory]);
    assert.equal(packed.status, 0, packed.stderr);
    const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const installed = runNpm(installDirectory, [
      "install", "--ignore-scripts", "--no-audit", "--no-fund",
      join(packDirectory, tarballs[0]!)
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    const cliPath = join(installDirectory, "node_modules", ".bin", "cu.cmd");
    assert.equal(existsSync(cliPath), true);

    const topics = runInstalledCli(cliPath, workspace, ["help", "--json"]);
    assert.equal(topics.status, 0, topics.stderr);
    assert.deepEqual(JSON.parse(topics.stdout), {
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
    assert.equal(existsSync(join(workspace, ".cu")), false);

    const actionFile = runInstalledCli(cliPath, workspace, ["help", "action-file"]);
    assert.equal(actionFile.status, 0, actionFile.stderr);
    assert.equal(actionFile.stderr, "");
    assert.match(actionFile.stdout, /"kind": "cu\.action\/v1"/);
    assert.match(actionFile.stdout, /"coordinateSpace": "normalized_999_top_left"/);
    assert.equal(existsSync(join(workspace, ".cu")), false);

    const unknown = runInstalledCli(cliPath, workspace, ["help", "unknown", "--json"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, "");
    assert.deepEqual(JSON.parse(unknown.stdout), {
      kind: "cu.error/v1",
      code: "usage_invalid",
      message: "Invalid command invocation.",
      retryable: false
    });
    assert.equal(existsSync(join(workspace, ".cu")), false);

    const initialized = runInstalledCli(cliPath, workspace, ["init", "--json"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const workspaceRecord = JSON.parse(
      readFileSync(join(workspace, ".cu", "workspace.json"), "utf8")
    ) as { rootFingerprint: string };
    const runDirectory = join(workspace, ".cu", "work-a");
    mkdirSync(runDirectory);
    writeFileSync(join(runDirectory, "run.json"), `${JSON.stringify({
      kind: "cu.run/v1",
      schemaVersion: 1,
      runId: "work-a",
      workspaceFingerprint: workspaceRecord.rootFingerprint,
      profile: "autonomous",
      lifecycle: "ready",
      createdAt: "2026-07-27T00:00:00.000Z"
    })}\n`, "utf8");
    const beforeStatus = snapshotTree(join(workspace, ".cu"));

    const status = runInstalledCli(cliPath, workspace, ["status", "work-a"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stderr, "");
    assert.equal(
      status.stdout,
      [
        "workspace: initialized",
        "run: work-a",
        "lifecycle: ready",
        "profile: autonomous",
        "busy: no",
        "archive: ready",
        "retained bundles: 0",
        "committed bytes: 0 / 536870912",
        "historical bundle limit: 128",
        "current observation: unavailable",
        "effect: none",
        "unavailable history events: 0",
        ""
      ].join("\n")
    );
    assert.deepEqual(snapshotTree(join(workspace, ".cu")), beforeStatus);
  }
);
