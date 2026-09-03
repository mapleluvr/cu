import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitActionBytes } from "../src/action-file.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = join(repositoryRoot, "dist", "src", "cli.js");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-init-help-"));
}

function runCli(workspace: string, ...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    encoding: "utf8",
  });
}

function runCliConcurrently(
  workspace: string,
  ...args: string[]
): Promise<{
  status: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: workspace,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectResult);
    child.on("close", (status) => {
      resolveResult({ status, stderr, stdout });
    });
  });
}

test("help --json returns a help receipt without creating workspace state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = runCli(workspace, "help", "--json");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
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
      "clearall",
    ],
  });
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("help topics provide copyable frozen syntax and action-file schema without state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["init", "cu init [--json]", /cu\.init\.result\/v1/],
    ["displays", "cu displays [--json]", /topology-bound/],
    [
      "observe",
      "cu observe <run_id> (--region <normalized-or-pixel-rectangle> [--display <display_id>] | --full-screen <display_id[,display_id...]>) [--ttl <seconds|unlimited>] [--json]",
      /--full-screen requires.*expiresAt is null/s,
    ],
    [
      "act",
      "cu act <run_id> --action-file <path|-> [--json]",
      /completed.*checkpoint.*cu\.error\/v1/s,
    ],
    ["history", "cu history <run_id> [list] [--json]", /diagnosticOnly/],
    ["status", "cu status [run_id] [--json]", /read-only/],
    [
      "clear",
      "cu clear <run_id> <time_end> [--json]",
      /start <= capturedAt < end/,
    ],
    ["clearall", "cu clearall <run_id> [--json]", /run\.json/],
  ];
  for (const [topic, usage, detail] of cases) {
    const result = runCli(workspace, "help", topic);
    assert.equal(result.status, 0, topic);
    assert.equal(result.stderr, "", topic);
    assert.equal(result.stdout.startsWith(`${usage}\n`), true, topic);
    assert.match(result.stdout, detail, topic);
  }

  const actionFile = runCli(workspace, "help", "action-file", "--json");
  assert.equal(actionFile.status, 0);
  assert.equal(actionFile.stderr, "");
  const receipt = JSON.parse(actionFile.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), ["kind", "text", "topic"]);
  assert.equal(receipt.kind, "cu.help.result/v1");
  assert.equal(receipt.topic, "action-file");
  const actionHelp = String(receipt.text);
  assert.match(actionHelp, /"kind": "cu\.action\/v1"/);
  assert.match(actionHelp, /"coordinateSpace": "normalized_999_top_left"/);
  assert.match(actionHelp, /"actions": \[/);
  const exampleStart = actionHelp.indexOf("{");
  const exampleEnd = actionHelp.lastIndexOf("}") + 1;
  assert.ok(exampleStart >= 0 && exampleEnd > exampleStart);
  const admitted = admitActionBytes(
    Buffer.from(actionHelp.slice(exampleStart, exampleEnd), "utf8"),
  );
  assert.equal(admitted.ok, true);
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("public contract action-file example remains directly admissible", () => {
  const contract = readFileSync(
    join(repositoryRoot, "docs", "design", "cli-contract.md"),
    "utf8",
  );
  const actionSection = contract.slice(
    contract.indexOf("The action file is distinct"),
  );
  const example = /```json\r?\n([\s\S]*?)\r?\n```/.exec(actionSection)?.[1];
  assert.notEqual(example, undefined);
  const admitted = admitActionBytes(Buffer.from(example!, "utf8"));
  assert.equal(admitted.ok, true);
});

test("help rejects unknown or extra topics before workspace state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const unknown = runCli(workspace, "help", "unknown", "--json");
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, "");
  assert.deepEqual(JSON.parse(unknown.stdout), {
    kind: "cu.error/v1",
    code: "usage_invalid",
    message: "Invalid command invocation.",
    retryable: false,
  });

  const extra = runCli(workspace, "help", "act", "extra");
  assert.equal(extra.status, 2);
  assert.equal(extra.stdout, "");
  assert.equal(extra.stderr, "Invalid command invocation.\n");
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("init --json creates then validates one immutable workspace record", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const first = runCli(workspace, "init", "--json");

  assert.equal(first.status, 0);
  assert.equal(first.stderr, "");
  assert.deepEqual(JSON.parse(first.stdout), {
    kind: "cu.init.result/v1",
    created: true,
  });

  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const recordText = readFileSync(recordPath, "utf8");
  const record = JSON.parse(recordText) as Record<string, unknown>;
  assert.equal(record.kind, "cu.workspace/v1");
  assert.equal(record.schemaVersion, 1);
  assert.match(String(record.rootFingerprint), /^[a-f0-9]{64}$/);
  assert.match(String(record.createdAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);

  const second = runCli(workspace, "init", "--json");

  assert.equal(second.status, 0);
  assert.equal(second.stderr, "");
  assert.deepEqual(JSON.parse(second.stdout), {
    kind: "cu.init.result/v1",
    created: false,
  });
  assert.equal(readFileSync(recordPath, "utf8"), recordText);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("init --json rejects a malformed workspace record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const originalRecord = "{malformed";
  mkdirSync(stateDirectory);
  writeFileSync(recordPath, originalRecord, "utf8");

  const result = runCli(workspace, "init", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be initialized safely.",
    retryable: false,
  });
  assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("init --json rejects an incompatible workspace schema without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const stateDirectory = join(workspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const originalRecord = `${JSON.stringify({
    kind: "cu.workspace/v1",
    schemaVersion: 2,
    rootFingerprint: "0".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  })}\n`;
  mkdirSync(stateDirectory);
  writeFileSync(recordPath, originalRecord, "utf8");

  const result = runCli(workspace, "init", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be initialized safely.",
    retryable: false,
  });
  assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("init --json rejects a valid record copied from another workspace", (t) => {
  const sourceWorkspace = createWorkspace();
  const targetWorkspace = createWorkspace();
  t.after(() => rmSync(sourceWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(targetWorkspace, { recursive: true, force: true }));

  const sourceInit = runCli(sourceWorkspace, "init", "--json");
  assert.equal(sourceInit.status, 0);
  const originalRecord = readFileSync(
    join(sourceWorkspace, ".cu", "workspace.json"),
    "utf8",
  );

  const stateDirectory = join(targetWorkspace, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  mkdirSync(stateDirectory);
  writeFileSync(recordPath, originalRecord, "utf8");

  const result = runCli(targetWorkspace, "init", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "workspace_invalid",
    message: "Workspace state cannot be initialized safely.",
    retryable: false,
  });
  assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("concurrent init calls create one workspace record without temporary residue", async (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      runCliConcurrently(workspace, "init", "--json"),
    ),
  );

  const receipts = results.map((result) => {
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout) as Record<string, unknown>;
  });
  assert.equal(
    receipts.filter((receipt) => receipt.created === true).length,
    1,
  );
  assert.equal(
    receipts.filter((receipt) => receipt.created === false).length,
    5,
  );

  const stateDirectory = join(workspace, ".cu");
  const record = JSON.parse(
    readFileSync(join(stateDirectory, "workspace.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(record.kind, "cu.workspace/v1");
  assert.equal(record.schemaVersion, 1);
  assert.match(String(record.rootFingerprint), /^[a-f0-9]{64}$/);
  assert.deepEqual(readdirSync(stateDirectory), ["workspace.json"]);
});

test("init --json rejects an unknown option without creating workspace state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = runCli(workspace, "init", "--json", "--unexpected");

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    kind: "cu.error/v1",
    code: "usage_invalid",
    message: "Invalid command invocation.",
    retryable: false,
  });
  assert.equal(existsSync(join(workspace, ".cu")), false);
});
