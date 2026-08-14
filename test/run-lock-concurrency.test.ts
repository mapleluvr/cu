import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireRunLock, RunLockBusyError } from "../src/run-lock.js";
import { initializeWorkspace } from "../src/workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createWorkspace(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "cu-run-lock-concurrency-")));
}

function runLockRootReplacementAcrossEpermRetry(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockRoot = resolve(join(workspace, ".cu", "@locks"));
    const movedLockRoot = resolve(join(workspace, ".cu", "@locks-moved"));
    const lockDirectory = resolve(join(lockRoot, "work-a"));
    const normalizedLockDirectory = lockDirectory.toLowerCase();
    const originalMkdir = fs.mkdirSync.bind(fs);
    const originalLstat = fs.lstatSync.bind(fs);
    let injectedEperm = false;
    let replaced = false;
    fs.mkdirSync = (path, ...args) => {
      if (!injectedEperm && resolve(String(path)).toLowerCase() === normalizedLockDirectory) {
        injectedEperm = true;
        throw Object.assign(new Error("injected transient lock deletion race"), { code: "EPERM" });
      }
      return originalMkdir(path, ...args);
    };
    fs.lstatSync = (path, ...args) => {
      try {
        return originalLstat(path, ...args);
      } catch (error) {
        if (
          !replaced &&
          injectedEperm &&
          error?.code === "ENOENT" &&
          resolve(String(path)).toLowerCase() === normalizedLockDirectory
        ) {
          fs.renameSync(lockRoot, movedLockRoot);
          originalMkdir(lockRoot);
          replaced = true;
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write("unexpected-success");
      process.exitCode = 23;
    } catch {
      const rejectedBeforeWrite =
        replaced &&
        !fs.existsSync(join(lockRoot, "work-a")) &&
        !fs.existsSync(join(movedLockRoot, "work-a"));
      process.stdout.write(rejectedBeforeWrite ? "rejected-lock-root-replacement" : "left-retry-residue");
      process.exitCode = rejectedBeforeWrite ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

function runPostCreateLockDirectoryEperm(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockDirectory = resolve(join(workspace, ".cu", "@locks", "work-a"));
    const normalizedLockDirectory = lockDirectory.toLowerCase();
    const ownerPath = join(lockDirectory, "owner.json");
    const originalLstat = fs.lstatSync.bind(fs);
    let injected = 0;
    fs.lstatSync = (path, ...args) => {
      if (injected === 0 && resolve(String(path)).toLowerCase() === normalizedLockDirectory) {
        injected += 1;
        throw Object.assign(new Error("injected post-create admission failure"), { code: "EPERM" });
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock, RunLockBusyError } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write("unexpected-success");
      process.exitCode = 23;
    } catch (error) {
      const preserved =
        error?.code === "EPERM" &&
        !(error instanceof RunLockBusyError) &&
        injected === 1 &&
        fs.existsSync(lockDirectory) &&
        !fs.existsSync(ownerPath);
      process.stdout.write(preserved ? "preserved-post-create-eperm" : "unexpected-rejection");
      process.exitCode = preserved ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

function runTransientLockDirectoryEperm(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockDirectory = resolve(join(workspace, ".cu", "@locks", "work-a")).toLowerCase();
    const originalMkdir = fs.mkdirSync.bind(fs);
    let attacked = false;
    fs.mkdirSync = (path, ...args) => {
      if (!attacked && resolve(String(path)).toLowerCase() === lockDirectory) {
        attacked = true;
        throw Object.assign(new Error("injected transient lock deletion race"), { code: "EPERM" });
      }
      return originalMkdir(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    try {
      const lock = acquireRunLock(workspace, "work-a");
      lock.release();
      process.stdout.write(attacked ? "retried-transient-eperm" : "attack-not-reached");
      process.exitCode = attacked ? 0 : 23;
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          attacked,
          name: error?.constructor?.name ?? null,
          code: error?.code ?? null,
          message: error?.message ?? null
        })
      );
      process.exitCode = 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

function runPersistentLockDirectoryEperm(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockDirectory = resolve(join(workspace, ".cu", "@locks", "work-a")).toLowerCase();
    const originalMkdir = fs.mkdirSync.bind(fs);
    let attempts = 0;
    fs.mkdirSync = (path, ...args) => {
      if (resolve(String(path)).toLowerCase() === lockDirectory) {
        attempts += 1;
        throw Object.assign(new Error("injected persistent permission failure"), { code: "EPERM" });
      }
      return originalMkdir(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock, RunLockBusyError } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write("unexpected-success");
      process.exitCode = 23;
    } catch (error) {
      const preserved =
        error?.code === "EPERM" &&
        !(error instanceof RunLockBusyError) &&
        attempts > 1;
      process.stdout.write(preserved ? "preserved-persistent-eperm" : "unexpected-rejection");
      process.exitCode = preserved ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

function runPersistentWorkspaceSiblingChurn(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const stateDirectory = join(workspace, ".cu");
    const workspaceRecordPath = resolve(join(stateDirectory, "workspace.json")).toLowerCase();
    const churnPath = join(stateDirectory, "@persistent-admission-churn");
    const originalOpen = fs.openSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    let workspaceDescriptor;
    let workspaceFstatCount = 0;
    let attacks = 0;
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      if (resolve(String(path)).toLowerCase() === workspaceRecordPath) {
        workspaceDescriptor = descriptor;
        workspaceFstatCount = 0;
      }
      return descriptor;
    };
    fs.fstatSync = (descriptor, ...args) => {
      const stat = originalFstat(descriptor, ...args);
      if (descriptor === workspaceDescriptor && ++workspaceFstatCount === 2) {
        fs.mkdirSync(churnPath);
        fs.rmdirSync(churnPath);
        attacks += 1;
      }
      return stat;
    };
    syncBuiltinESMExports();
    const { acquireRunLock, RunLockBusyError } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write("unexpected-success");
      process.exitCode = 23;
    } catch (error) {
      const bounded = error instanceof RunLockBusyError && attacks === 16;
      process.stdout.write(bounded ? "bounded-persistent-churn" : "unexpected-rejection");
      process.exitCode = bounded ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

function runWorkspaceSiblingChurnDuringAdmission(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const stateDirectory = join(workspace, ".cu");
    const workspaceRecordPath = resolve(join(stateDirectory, "workspace.json")).toLowerCase();
    const churnPath = join(stateDirectory, "@admission-churn");
    const originalOpen = fs.openSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    let workspaceDescriptor;
    let workspaceFstatCount = 0;
    let attacked = false;
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      if (resolve(String(path)).toLowerCase() === workspaceRecordPath) {
        workspaceDescriptor = descriptor;
      }
      return descriptor;
    };
    fs.fstatSync = (descriptor, ...args) => {
      const stat = originalFstat(descriptor, ...args);
      if (
        !attacked &&
        descriptor === workspaceDescriptor &&
        ++workspaceFstatCount === 2
      ) {
        fs.mkdirSync(churnPath);
        fs.rmdirSync(churnPath);
        attacked = true;
      }
      return stat;
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    try {
      const lock = acquireRunLock(workspace, "work-a");
      lock.release();
      process.stdout.write(attacked ? "retried-sibling-churn" : "attack-not-reached");
      process.exitCode = attacked ? 0 : 23;
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          attacked,
          name: error?.constructor?.name ?? null,
          message: error?.message ?? null
        })
      );
      process.exitCode = 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, CU_TEST_WORKSPACE: workspace }
  });
}

test("run lock revalidates its lock namespace before an EPERM retry", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runLockRootReplacementAcrossEpermRetry(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-lock-root-replacement");
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
  assert.equal(existsSync(join(workspace, ".cu", "@locks-moved", "work-a")), false);
});

test("run lock preserves a post-create lock-directory admission EPERM", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");

  const result = runPostCreateLockDirectoryEperm(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "preserved-post-create-eperm");
  assert.equal(existsSync(lockDirectory), true);
  assert.equal(existsSync(join(lockDirectory, "owner.json")), false);
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
});

test("run lock retries a transient Windows lock-directory EPERM", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runTransientLockDirectoryEperm(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "retried-transient-eperm");
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("run lock preserves a persistent lock-directory EPERM", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runPersistentLockDirectoryEperm(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "preserved-persistent-eperm");
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("run lock bounds persistent workspace sibling-churn retries without writing", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const recordPath = join(workspace, ".cu", "workspace.json");
  const original = readFileSync(recordPath);

  const result = runPersistentWorkspaceSiblingChurn(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "bounded-persistent-churn");
  assert.deepEqual(readFileSync(recordPath), original);
  assert.equal(existsSync(join(workspace, ".cu", "@locks")), false);
});

test("run lock retries workspace admission after same-directory sibling churn", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runWorkspaceSiblingChurnDuringAdmission(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "retried-sibling-churn");
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("run lock does not retry or downgrade malformed workspace bytes to busy", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const recordPath = join(workspace, ".cu", "workspace.json");
  writeFileSync(recordPath, "{malformed\n");
  const original = readFileSync(recordPath);

  assert.throws(
    () => acquireRunLock(workspace, "work-a"),
    (error: unknown) => {
      assert.equal(error instanceof RunLockBusyError, false);
      assert.equal((error as Error).message, "workspace record is invalid");
      return true;
    }
  );
  assert.deepEqual(readFileSync(recordPath), original);
  assert.equal(existsSync(join(workspace, ".cu", "@locks")), false);
});
