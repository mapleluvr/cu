import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ControlRecordReplacementUncertainError,
  discardStagedControlRecord,
  publishStagedControlRecordCreateOnce,
  replaceWitnessedControlRecord,
  stageValidatedControlRecord,
  writeCreateOnceRecord,
  writeCreateOnceRecordWithIdentity,
  type StagedControlRecord
} from "../src/control-write.js";
import {
  MAX_CONTROL_RECORD_BYTES,
  readStableRegularFileWithWitness,
  revalidateStableRegularFileWitness
} from "../src/regular-file.js";
import { ensureRun, inspectRun } from "../src/run.js";
import {
  acquireRunLock,
  revalidateRunLock,
  RunLockBusyError,
  type RunLock
} from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockWorkerPath = join(repositoryRoot, "dist", "test", "support", "run-lock-worker.js");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-run-store-"));
}

async function waitForWorkerAcquisition(child: ReturnType<typeof spawn>): Promise<void> {
  const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
  assert.equal(chunk.toString("utf8"), "acquired\n");
}

function assertPreCutoverFailure(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.equal(error instanceof ControlRecordReplacementUncertainError, false);
    return true;
  });
}

function runCreateOnceConflictWithCleanupLoss(
  parentDirectory: string
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const parentDirectory = fs.realpathSync.native(process.env.CU_TEST_PARENT_DIRECTORY);
    const target = resolve(join(parentDirectory, "record.json"));
    const originalLink = fs.linkSync.bind(fs);
    let injected = false;
    fs.linkSync = (existing, destination) => {
      if (!injected && resolve(String(destination)).toLowerCase() === target.toLowerCase()) {
        fs.writeFileSync(target, "winner\\n");
        fs.rmSync(existing);
        fs.writeFileSync(existing, "replacement stage\\n");
        injected = true;
      }
      return originalLink(existing, destination);
    };
    syncBuiltinESMExports();
    const {
      ControlRecordPublicationUncertainError,
      publishStagedControlRecordCreateOnce,
      stageValidatedControlRecord
    } = await import(${JSON.stringify(controlWriteUrl)});
    const staged = stageValidatedControlRecord(
      target,
      parentDirectory,
      [parentDirectory],
      Buffer.from("candidate\\n"),
      () => {}
    );
    let uncertain = false;
    try {
      publishStagedControlRecordCreateOnce(target, parentDirectory, [parentDirectory], staged);
    } catch (error) {
      uncertain = error instanceof ControlRecordPublicationUncertainError && error.message === "";
    }
    const temporaryNames = fs.readdirSync(parentDirectory).filter((name) => name.startsWith("@tmp-"));
    const replacementPreserved =
      temporaryNames.length === 1 &&
      fs.readFileSync(join(parentDirectory, temporaryNames[0]), "utf8") === "replacement stage\\n";
    const result = {
      injected,
      uncertain,
      winnerPreserved: fs.readFileSync(target, "utf8") === "winner\\n",
      temporaryCount: temporaryNames.length,
      replacementPreserved
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode =
      injected &&
      uncertain &&
      result.winnerPreserved &&
      temporaryNames.length === 1 &&
      replacementPreserved
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_PARENT_DIRECTORY: parentDirectory
    }
  });
}

function runStagedWriteFailure(
  parentDirectory: string,
  phase: "partial-write" | "fsync"
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const parentDirectory = fs.realpathSync.native(process.env.CU_TEST_PARENT_DIRECTORY);
    const target = join(parentDirectory, "record.json");
    const phase = process.env.CU_TEST_PHASE;
    const originalWrite = fs.writeFileSync.bind(fs);
    const originalFsync = fs.fsyncSync.bind(fs);
    let injected = false;
    fs.writeFileSync = (path, contents, ...args) => {
      if (phase === "partial-write" && !injected && typeof path === "number") {
        originalWrite(path, Buffer.from("partial"));
        injected = true;
        throw Object.assign(new Error("injected partial write"), { code: "EIO" });
      }
      return originalWrite(path, contents, ...args);
    };
    fs.fsyncSync = (descriptor) => {
      const result = originalFsync(descriptor);
      if (phase === "fsync" && !injected) {
        injected = true;
        throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
      }
      return result;
    };
    syncBuiltinESMExports();
    const { stageValidatedControlRecord } = await import(${JSON.stringify(controlWriteUrl)});
    let rejected = false;
    try {
      stageValidatedControlRecord(
        target,
        parentDirectory,
        [parentDirectory],
        Buffer.from("complete\\n"),
        () => {}
      );
    } catch {
      rejected = true;
    }
    const temporaryNames = fs.readdirSync(parentDirectory).filter((name) => name.startsWith("@tmp-"));
    const result = { phase, injected, rejected, targetExists: fs.existsSync(target), temporaryNames };
    process.stdout.write(JSON.stringify(result));
    process.exitCode =
      injected && rejected && !result.targetExists && temporaryNames.length === 0 ? 0 : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_PARENT_DIRECTORY: parentDirectory,
      CU_TEST_PHASE: phase
    }
  });
}

function runCreateOnceWriteFailure(
  parentDirectory: string,
  phase: "partial-write" | "fsync" | "partial-write-replaced"
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const parentDirectory = fs.realpathSync.native(process.env.CU_TEST_PARENT_DIRECTORY);
    const target = join(parentDirectory, "record.json");
    const phase = process.env.CU_TEST_PHASE;
    const originalWrite = fs.writeFileSync.bind(fs);
    const originalFsync = fs.fsyncSync.bind(fs);
    let injected = false;
    fs.writeFileSync = (path, contents, ...args) => {
      if ((phase === "partial-write" || phase === "partial-write-replaced") &&
          !injected && typeof path === "number") {
        originalWrite(path, Buffer.from("partial"));
        if (phase === "partial-write-replaced") {
          const temporaryName = fs.readdirSync(parentDirectory).find((name) => name.startsWith("@tmp-"));
          const temporaryPath = join(parentDirectory, temporaryName);
          fs.renameSync(temporaryPath, temporaryPath + "-displaced");
          fs.writeFileSync(temporaryPath, "replacement");
        }
        injected = true;
        throw Object.assign(new Error("injected partial write"), { code: "EIO" });
      }
      return originalWrite(path, contents, ...args);
    };
    fs.fsyncSync = (descriptor) => {
      const result = originalFsync(descriptor);
      if (phase === "fsync" && !injected) {
        injected = true;
        throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
      }
      return result;
    };
    syncBuiltinESMExports();
    const { writeCreateOnceRecordWithIdentity } = await import(${JSON.stringify(controlWriteUrl)});
    let rejected = false;
    try {
      writeCreateOnceRecordWithIdentity(target, parentDirectory, Buffer.from("complete\\n"));
    } catch {
      rejected = true;
    }
    const temporary = fs.readdirSync(parentDirectory)
      .filter((name) => name.startsWith("@tmp-"))
      .map((name) => ({ name, contents: fs.readFileSync(join(parentDirectory, name), "utf8") }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const clean = phase !== "partial-write-replaced" && temporary.length === 0;
    const replacementSafe = phase !== "partial-write-replaced" ||
      (temporary.length === 2 &&
       temporary.some((entry) => entry.contents === "partial") &&
       temporary.some((entry) => entry.contents === "replacement"));
    const acceptedCleanup = phase === "partial-write-replaced" ? replacementSafe : clean;
    const result = {
      phase,
      injected,
      rejected,
      targetExists: fs.existsSync(target),
      temporary,
      clean,
      replacementSafe
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode = injected && rejected && !result.targetExists && acceptedCleanup ? 0 : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_PARENT_DIRECTORY: parentDirectory,
      CU_TEST_PHASE: phase
    }
  });
}

function runReplacementCrashWorker(
  recordPath: string,
  parentDirectory: string,
  phase: "pre-cutover" | "post-cutover"
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const regularFileUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "regular-file.js")).href;
  const program = `
    import { stageValidatedControlRecord, replaceWitnessedControlRecord } from ${JSON.stringify(controlWriteUrl)};
    import { readStableRegularFileWithWitness } from ${JSON.stringify(regularFileUrl)};
    const recordPath = process.env.CU_TEST_RECORD_PATH;
    const parentDirectory = process.env.CU_TEST_PARENT_DIRECTORY;
    const phase = process.env.CU_TEST_CRASH_PHASE;
    let validations = 0;
    const staged = stageValidatedControlRecord(
      recordPath,
      parentDirectory,
      [parentDirectory],
      Buffer.from("second\\n"),
      () => {
        validations += 1;
        if (phase === "post-cutover" && validations === 2) process.exit(23);
      }
    );
    const admitted = readStableRegularFileWithWitness(recordPath, [parentDirectory]);
    if (phase === "pre-cutover") process.exit(22);
    replaceWitnessedControlRecord(recordPath, parentDirectory, [parentDirectory], admitted.witness, staged);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_RECORD_PATH: recordPath,
      CU_TEST_PARENT_DIRECTORY: parentDirectory,
      CU_TEST_CRASH_PHASE: phase
    }
  });
}

function runWorkspaceReplacementDuringLockAcquisition(
  workspace: string,
  replacementState: string
): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const replacementState = fs.realpathSync.native(process.env.CU_TEST_REPLACEMENT_STATE);
    const stateDirectory = join(workspace, ".cu");
    const displacedState = join(workspace, ".cu-admitted");
    const workspaceRecord = fs.realpathSync.native(join(stateDirectory, "workspace.json")).toLowerCase();
    const rootPath = resolve(workspace).toLowerCase();
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const originalLstat = fs.lstatSync.bind(fs);
    const originalRename = fs.renameSync.bind(fs);
    const opened = new Map();
    let inspectionComplete = false;
    let attacked = false;
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      opened.set(descriptor, resolve(String(path)).toLowerCase());
      return descriptor;
    };
    fs.closeSync = (descriptor) => {
      const path = opened.get(descriptor);
      opened.delete(descriptor);
      originalClose(descriptor);
      if (path === workspaceRecord) inspectionComplete = true;
    };
    fs.lstatSync = (path, ...args) => {
      if (!attacked && inspectionComplete && resolve(String(path)).toLowerCase() === rootPath) {
        originalRename(stateDirectory, displacedState);
        originalRename(replacementState, stateDirectory);
        attacked = true;
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write(attacked ? "acquired-replacement" : "attack-not-reached");
      process.exitCode = 23;
    } catch {
      process.stdout.write(attacked ? "rejected-replacement" : "attack-not-reached");
      process.exitCode = attacked ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_REPLACEMENT_STATE: replacementState
    }
  });
}

function runOwnerRewriteDuringLockAcquisition(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
    const ownerPath = join(lockDirectory, "owner.json");
    const normalizedLockDirectory = resolve(lockDirectory).toLowerCase();
    const originalLstat = fs.lstatSync.bind(fs);
    const originalExists = fs.existsSync.bind(fs);
    const originalRead = fs.readFileSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let attacked = false;
    fs.lstatSync = (path, ...args) => {
      if (
        !attacked &&
        resolve(String(path)).toLowerCase() === normalizedLockDirectory &&
        originalExists(ownerPath)
      ) {
        const original = String(originalRead(ownerPath, "utf8"));
        const rewritten = original.replace(
          '\"schemaVersion\":1',
          '\"schemaVersion\":1,\"schemaVersion\":1'
        );
        if (rewritten === original) throw new Error("owner rewrite fixture did not match");
        originalWrite(ownerPath, rewritten, "utf8");
        attacked = true;
      }
      return originalLstat(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    try {
      acquireRunLock(workspace, "work-a");
      process.stdout.write(attacked ? "acquired-rewritten-owner" : "attack-not-reached");
      process.exitCode = 23;
    } catch {
      process.stdout.write(attacked ? "rejected-rewritten-owner" : "attack-not-reached");
      process.exitCode = attacked ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace
    }
  });
}

function runCreateOnceLinkSideEffectThenThrow(
  workspace: string
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const stateDirectory = join(workspace, ".cu");
    const runDirectory = join(stateDirectory, "work-a");
    const targetPath = join(runDirectory, "link-uncertain.json");
    const normalizedTarget = resolve(targetPath).toLowerCase();
    const candidate = Buffer.from('{"value":3}\\n');
    const originalLink = fs.linkSync.bind(fs);
    let attacked = false;
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (resolve(String(to)).toLowerCase() === normalizedTarget) {
        attacked = true;
        throw new Error("injected post-link failure");
      }
    };
    syncBuiltinESMExports();
    const {
      ControlRecordPublicationUncertainError,
      publishStagedControlRecordCreateOnce,
      stageValidatedControlRecord
    } = await import(${JSON.stringify(controlWriteUrl)});
    const ancestors = [stateDirectory, runDirectory];
    const staged = stageValidatedControlRecord(
      targetPath,
      runDirectory,
      ancestors,
      candidate,
      (bytes) => {
        if (!bytes.equals(candidate)) throw new Error("candidate invalid");
      }
    );
    try {
      publishStagedControlRecordCreateOnce(
        targetPath,
        runDirectory,
        ancestors,
        staged
      );
      process.stdout.write("unexpected-success");
      process.exitCode = 23;
    } catch (error) {
      const classified =
        error instanceof ControlRecordPublicationUncertainError && error.message === "";
      process.stdout.write(
        attacked && classified ? "rejected-post-link-failure" : "unexpected-rejection"
      );
      process.exitCode = attacked && classified ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace
    }
  });
}

function runSemanticRewriteAfterCreateOncePublication(
  workspace: string
): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const stateDirectory = join(workspace, ".cu");
    const runDirectory = join(stateDirectory, "work-a");
    const targetPath = join(runDirectory, "published-semantic.json");
    const normalizedTarget = resolve(targetPath).toLowerCase();
    const candidate = Buffer.from('{"value":2}\\n');
    const altered = Buffer.from('{"value":2 }\\n');
    const originalLink = fs.linkSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let attacked = false;
    fs.linkSync = (from, to) => {
      originalLink(from, to);
      if (resolve(String(to)).toLowerCase() === normalizedTarget) {
        originalWrite(to, altered);
        attacked = true;
      }
    };
    syncBuiltinESMExports();
    const {
      ControlRecordPublicationUncertainError,
      publishStagedControlRecordCreateOnce,
      stageValidatedControlRecord
    } = await import(${JSON.stringify(controlWriteUrl)});
    const ancestors = [stateDirectory, runDirectory];
    const validate = (bytes) => {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value.value !== 2) throw new Error("candidate invalid");
    };
    const staged = stageValidatedControlRecord(
      targetPath,
      runDirectory,
      ancestors,
      candidate,
      validate
    );
    try {
      publishStagedControlRecordCreateOnce(
        targetPath,
        runDirectory,
        ancestors,
        staged
      );
      process.stdout.write(attacked ? "accepted-altered-publication" : "attack-not-reached");
      process.exitCode = 23;
    } catch (error) {
      const classified =
        error instanceof ControlRecordPublicationUncertainError && error.message === "";
      process.stdout.write(
        attacked && classified ? "rejected-altered-publication" : "unexpected-rejection"
      );
      process.exitCode = attacked && classified ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace
    }
  });
}

function runSemanticRewriteAfterReplacement(workspace: string): ReturnType<typeof spawnSync> {
  const controlWriteUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "control-write.js")).href;
  const regularFileUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "regular-file.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const stateDirectory = join(workspace, ".cu");
    const runDirectory = join(stateDirectory, "work-a");
    const targetPath = join(runDirectory, "semantic-record.json");
    const normalizedTarget = resolve(targetPath).toLowerCase();
    const candidate = Buffer.from('{"value":2}\\n');
    const altered = Buffer.from('{"value":2 }\\n');
    const originalRename = fs.renameSync.bind(fs);
    const originalWrite = fs.writeFileSync.bind(fs);
    let attacked = false;
    fs.renameSync = (from, to) => {
      originalRename(from, to);
      if (resolve(String(to)).toLowerCase() === normalizedTarget) {
        originalWrite(to, altered);
        attacked = true;
      }
    };
    syncBuiltinESMExports();
    const {
      ControlRecordReplacementUncertainError,
      replaceWitnessedControlRecord,
      stageValidatedControlRecord
    } = await import(${JSON.stringify(controlWriteUrl)});
    const { readStableRegularFileWithWitness } = await import(${JSON.stringify(regularFileUrl)});
    const ancestors = [stateDirectory, runDirectory];
    const validate = (bytes) => {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value.value !== 2) throw new Error("candidate invalid");
    };
    const staged = stageValidatedControlRecord(
      targetPath,
      runDirectory,
      ancestors,
      candidate,
      validate
    );
    const predecessor = readStableRegularFileWithWitness(targetPath, ancestors);
    try {
      replaceWitnessedControlRecord(
        targetPath,
        runDirectory,
        ancestors,
        predecessor.witness,
        staged
      );
      process.stdout.write(attacked ? "accepted-altered-bytes" : "attack-not-reached");
      process.exitCode = 23;
    } catch (error) {
      const classified = error instanceof ControlRecordReplacementUncertainError;
      process.stdout.write(
        attacked && classified ? "rejected-altered-bytes" : "unexpected-rejection"
      );
      process.exitCode = attacked && classified ? 0 : 24;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace
    }
  });
}

function runReleaseCleanupFailureWorker(workspace: string): ReturnType<typeof spawnSync> {
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
    const ownerPath = join(lockDirectory, "owner.json");
    const normalizedLockDirectory = resolve(lockDirectory).toLowerCase();
    const originalRmdir = fs.rmdirSync.bind(fs);
    let intercepted = false;
    fs.rmdirSync = (path) => {
      if (resolve(String(path)).toLowerCase() === normalizedLockDirectory) {
        intercepted = true;
        const error = new Error("injected rmdir failure");
        error.code = "EACCES";
        throw error;
      }
      originalRmdir(path);
    };
    syncBuiltinESMExports();
    const { acquireRunLock, revalidateRunLock, RunLockBusyError } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let releaseFailed = false;
    try {
      lock.release();
    } catch {
      releaseFailed = true;
    }
    let revalidationRejected = false;
    try {
      revalidateRunLock(lock, workspace, "work-a");
    } catch {
      revalidationRejected = true;
    }
    let secondReleaseRejected = false;
    try {
      lock.release();
    } catch {
      secondReleaseRejected = true;
    }
    let reacquireBusy = false;
    try {
      acquireRunLock(workspace, "work-a");
    } catch (error) {
      reacquireBusy = error instanceof RunLockBusyError;
    }
    const ownerAbsent = !fs.existsSync(ownerPath);
    const directoryEmpty = fs.existsSync(lockDirectory) && fs.readdirSync(lockDirectory).length === 0;
    if (
      intercepted &&
      releaseFailed &&
      revalidationRejected &&
      secondReleaseRejected &&
      reacquireBusy &&
      ownerAbsent &&
      directoryEmpty
    ) {
      process.stdout.write("consumed-after-owner-unlink");
      process.exitCode = 0;
    } else {
      process.stdout.write(JSON.stringify({
        intercepted,
        releaseFailed,
        revalidationRejected,
        secondReleaseRejected,
        reacquireBusy,
        ownerAbsent,
        directoryEmpty
      }));
      process.exitCode = 23;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace
    }
  });
}

function runEnsureWorker(workspace: string, runId: string): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [lockWorkerPath, workspace, runId, "ensure"]);
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
      if (status !== 0 || stderr !== "") {
        rejectResult(new Error(`store worker failed: ${status} ${stderr}`));
        return;
      }
      resolveResult(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

test("ensureRun atomically creates the first strict run record", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const created = ensureRun(workspace, "work-a");
  const recordPath = join(workspace, ".cu", "work-a", "run.json");

  assert.equal(created.created, true);
  assert.deepEqual(Object.keys(created.record).sort(), [
    "createdAt",
    "kind",
    "lifecycle",
    "profile",
    "runId",
    "schemaVersion",
    "workspaceFingerprint"
  ]);
  for (const field of ["pid", "helper", "target", "typed", "capture", "desktop"]) {
    assert.equal(JSON.stringify(created.record).includes(`\"${field}\"`), false);
  }
  assert.equal(created.record.runId, "work-a");
  assert.equal(created.record.profile, "autonomous");
  assert.equal(created.record.lifecycle, "ready");
  assert.equal(inspectRun(workspace, "work-a")?.runId, "work-a");
  assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), created.record);
});

test("ensureRun returns the existing valid record without rewriting it", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const first = ensureRun(workspace, "work-a");
  const recordPath = join(workspace, ".cu", "work-a", "run.json");
  const originalBytes = readFileSync(recordPath, "utf8");
  const second = ensureRun(workspace, "work-a");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.record, first.record);
  assert.equal(readFileSync(recordPath, "utf8"), originalBytes);
});

test("run lock blocks a second owner and clean release removes its directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const first = acquireRunLock(workspace, "work-a");
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
  first.release();

  const second = acquireRunLock(workspace, "work-a");
  second.release();

  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("held run lock capability revalidates its exact workspace and run ownership", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lock = acquireRunLock(workspace, "work-a");
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
  const ownerPath = join(lockDirectory, "owner.json");
  const ownerBytes = readFileSync(ownerPath, "utf8");
  const before = readdirSync(lockDirectory);

  assert.doesNotThrow(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.equal(readFileSync(ownerPath, "utf8"), ownerBytes);
  assert.deepEqual(readdirSync(lockDirectory), before);
  assert.throws(() => revalidateRunLock({ release() {} } as RunLock, workspace, "work-a"));

  lock.release();
  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
});

test("run lock capability rejects cross-run and cross-workspace reuse", (t) => {
  const workspace = createWorkspace();
  const otherWorkspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(otherWorkspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  initializeWorkspace(otherWorkspace);
  const lock = acquireRunLock(workspace, "work-a");

  assert.throws(() => revalidateRunLock(lock, workspace, "work-b"));
  assert.throws(() => revalidateRunLock(lock, otherWorkspace, "work-a"));
  assert.doesNotThrow(() => revalidateRunLock(lock, workspace, "work-a"));

  lock.release();
});

test("held run lock capability survives sibling-run lock churn", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const first = acquireRunLock(workspace, "work-a");

  const sibling = acquireRunLock(workspace, "work-b");
  revalidateRunLock(first, workspace, "work-a");
  sibling.release();
  revalidateRunLock(first, workspace, "work-a");
  first.release();
});

test("run lock acquisition rejects a persistent state replacement after workspace inspection", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const replacementState = join(workspace, "replacement-state");
  mkdirSync(replacementState);

  const result = runWorkspaceReplacementDuringLockAcquisition(workspace, replacementState);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-replacement");
  assert.equal(existsSync(join(workspace, ".cu-admitted", "workspace.json")), true);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a", "owner.json")), false);
});

test("run lock capability rejects a replaced state ancestor even when its lock directory is preserved", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lock = acquireRunLock(workspace, "work-a");
  const stateDirectory = join(workspace, ".cu");
  const displacedState = join(workspace, ".cu-original");
  const originalLockRoot = join(displacedState, "@locks");

  renameSync(stateDirectory, displacedState);
  mkdirSync(stateDirectory);
  renameSync(originalLockRoot, join(stateDirectory, "@locks"));

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.equal(existsSync(join(stateDirectory, "@locks", "work-a", "owner.json")), true);
  assert.equal(existsSync(join(displacedState, "workspace.json")), true);
});

test("run lock capability rejects a replaced lock namespace that preserves its per-run directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lock = acquireRunLock(workspace, "work-a");
  const stateDirectory = join(workspace, ".cu");
  const lockRoot = join(stateDirectory, "@locks");
  const displacedLockRoot = join(stateDirectory, "@locks-original");

  renameSync(lockRoot, displacedLockRoot);
  mkdirSync(lockRoot);
  renameSync(join(displacedLockRoot, "work-a"), join(lockRoot, "work-a"));

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.equal(existsSync(join(lockRoot, "work-a", "owner.json")), true);
});

test("run lock capability rejects a replaced workspace root that preserves its state directory", (t) => {
  const workspace = createWorkspace();
  const displacedWorkspace = `${workspace}-original`;
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(displacedWorkspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lock = acquireRunLock(workspace, "work-a");

  renameSync(workspace, displacedWorkspace);
  mkdirSync(workspace);
  renameSync(join(displacedWorkspace, ".cu"), join(workspace, ".cu"));

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a", "owner.json")), true);
});

test("failed release permanently consumes the run lock capability", (t) => {
  const workspace = createWorkspace();
  const displacedWorkspace = `${workspace}-release-original`;
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(displacedWorkspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lock = acquireRunLock(workspace, "work-a");

  renameSync(workspace, displacedWorkspace);
  mkdirSync(workspace);
  assert.throws(() => lock.release());
  rmSync(workspace, { recursive: true, force: true });
  renameSync(displacedWorkspace, workspace);

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a", "owner.json")), true);
});

test("partial release cleanup permanently consumes the run lock capability", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runReleaseCleanupFailureWorker(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "consumed-after-owner-unlink");
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
  assert.equal(existsSync(join(lockDirectory, "owner.json")), false);
  assert.deepEqual(readdirSync(lockDirectory), []);
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
});

test("run lock never reclaims an ownerless existing lock directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
  mkdirSync(lockDirectory, { recursive: true });

  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
  assert.deepEqual(readdirSync(lockDirectory), []);
});

test("run lock never reclaims a malformed existing owner record", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
  mkdirSync(lockDirectory, { recursive: true });
  const ownerPath = join(lockDirectory, "owner.json");
  writeFileSync(ownerPath, "{malformed", "utf8");

  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
  assert.equal(readFileSync(ownerPath, "utf8"), "{malformed");
});

test("run lock acquisition rejects semantically equivalent owner bytes rewritten before snapshots", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const result = runOwnerRewriteDuringLockAcquisition(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-rewritten-owner");
  const ownerPath = join(workspace, ".cu", "@locks", "work-a", "owner.json");
  assert.equal(existsSync(ownerPath), true);
  assert.match(readFileSync(ownerPath, "utf8"), /\"schemaVersion\":1,\"schemaVersion\":1/);
});

test("run lock persists only a strict workspace-bound owner record while held", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const lock = acquireRunLock(workspace, "work-a");
  const ownerPath = join(workspace, ".cu", "@locks", "work-a", "owner.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;

  assert.deepEqual(Object.keys(owner).sort(), [
    "acquiredAt",
    "kind",
    "ownerId",
    "runId",
    "schemaVersion",
    "workspaceFingerprint"
  ]);
  assert.equal(owner.kind, "cu.run-lock/v1");
  assert.equal(owner.schemaVersion, 1);
  assert.equal(owner.runId, "work-a");
  assert.equal(owner.workspaceFingerprint, workspaceFingerprint(workspace));
  assert.match(String(owner.ownerId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(String(owner.acquiredAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  for (const field of ["pid", "helper", "target", "typed", "capture", "desktop"]) {
    assert.equal(JSON.stringify(owner).includes(`\"${field}\"`), false);
  }
  lock.release();
});

test("ensureRun refuses to write while another owner holds the run lock", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const lock = acquireRunLock(workspace, "work-a");
  assert.throws(() => ensureRun(workspace, "work-a"), RunLockBusyError);
  assert.equal(existsSync(join(workspace, ".cu", "work-a")), false);
  lock.release();

  assert.equal(ensureRun(workspace, "work-a").created, true);
});

test("ensureRun refuses an uninitialized workspace without creating state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  assert.throws(() => ensureRun(workspace, "work-a"));
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("ensureRun rejects a non-directory workspace state path without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const statePath = join(workspace, ".cu");
  writeFileSync(statePath, "not-a-directory", "utf8");

  assert.throws(() => ensureRun(workspace, "work-a"));
  assert.equal(readFileSync(statePath, "utf8"), "not-a-directory");
});

test("ensureRun rejects an incomplete existing run directory without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const runDirectory = join(workspace, ".cu", "work-a");
  mkdirSync(runDirectory);

  assert.throws(() => ensureRun(workspace, "work-a"));
  assert.deepEqual(readdirSync(runDirectory), []);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("ensureRun rejects a malformed existing run record without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const runDirectory = join(workspace, ".cu", "work-a");
  const recordPath = join(runDirectory, "run.json");
  mkdirSync(runDirectory);
  writeFileSync(recordPath, "{malformed", "utf8");

  assert.throws(() => ensureRun(workspace, "work-a"));
  assert.equal(readFileSync(recordPath, "utf8"), "{malformed");
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
});

test("ensureRun rejects a junctioned workspace state directory without writing outside", (t) => {
  const workspace = createWorkspace();
  const outside = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  rmSync(join(workspace, ".cu"), { recursive: true, force: true });
  symlinkSync(outside, join(workspace, ".cu"), "junction");

  assert.throws(() => ensureRun(workspace, "work-a"));
  assert.deepEqual(readdirSync(outside), []);
});

test("run lock rejects a non-directory lock namespace without repair", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockRoot = join(workspace, ".cu", "@locks");
  writeFileSync(lockRoot, "not-a-directory", "utf8");

  assert.throws(() => acquireRunLock(workspace, "work-a"));
  assert.equal(readFileSync(lockRoot, "utf8"), "not-a-directory");
});

test("run lock rejects a junctioned lock namespace without writing outside the workspace", (t) => {
  const workspace = createWorkspace();
  const outside = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  symlinkSync(outside, join(workspace, ".cu", "@locks"), "junction");

  assert.throws(() => acquireRunLock(workspace, "work-a"));
  assert.equal(existsSync(join(outside, "work-a")), false);
});

test("run lock never reclaims a non-directory per-run lock path", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockRoot = join(workspace, ".cu", "@locks");
  const lockPath = join(lockRoot, "work-a");
  mkdirSync(lockRoot);
  writeFileSync(lockPath, "not-a-directory", "utf8");

  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
  assert.equal(readFileSync(lockPath, "utf8"), "not-a-directory");
});

test("run lock never follows a junctioned per-run lock directory", (t) => {
  const workspace = createWorkspace();
  const outside = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const lockRoot = join(workspace, ".cu", "@locks");
  mkdirSync(lockRoot);
  symlinkSync(outside, join(lockRoot, "work-a"), "junction");

  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
  assert.equal(existsSync(join(outside, "owner.json")), false);
});

test("run lock release refuses a replaced owner record without deleting it", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const lock = acquireRunLock(workspace, "work-a");
  const ownerPath = join(workspace, ".cu", "@locks", "work-a", "owner.json");
  const replacement = "{replaced";
  writeFileSync(ownerPath, replacement, "utf8");

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.throws(() => lock.release());
  assert.equal(readFileSync(ownerPath, "utf8"), replacement);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), true);
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
});

test("run lock release rejects a byte-identical replacement owner file", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const lock = acquireRunLock(workspace, "work-a");
  const lockDirectory = join(workspace, ".cu", "@locks", "work-a");
  const ownerPath = join(lockDirectory, "owner.json");
  const originalOwnerPath = join(lockDirectory, "owner-original.json");
  const ownerBytes = readFileSync(ownerPath, "utf8");
  renameSync(ownerPath, originalOwnerPath);
  writeFileSync(ownerPath, ownerBytes, "utf8");

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.throws(() => lock.release());
  assert.equal(readFileSync(ownerPath, "utf8"), ownerBytes);
  assert.equal(readFileSync(originalOwnerPath, "utf8"), ownerBytes);
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
});

test("run lock release rejects a byte-identical replacement directory", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const lock = acquireRunLock(workspace, "work-a");
  const lockRoot = join(workspace, ".cu", "@locks");
  const lockDirectory = join(lockRoot, "work-a");
  const originalDirectory = join(lockRoot, "work-a-original");
  const ownerPath = join(lockDirectory, "owner.json");
  const ownerBytes = readFileSync(ownerPath, "utf8");
  renameSync(lockDirectory, originalDirectory);
  mkdirSync(lockDirectory);
  writeFileSync(ownerPath, ownerBytes, "utf8");

  assert.throws(() => revalidateRunLock(lock, workspace, "work-a"));
  assert.throws(() => lock.release());
  assert.equal(readFileSync(ownerPath, "utf8"), ownerBytes);
  assert.equal(readFileSync(join(originalDirectory, "owner.json"), "utf8"), ownerBytes);
  assert.throws(() => acquireRunLock(workspace, "work-a"), RunLockBusyError);
});

test("witnessed control writer replaces only an admitted existing record after staged validation", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    (bytes: Buffer) => assert.equal(bytes.toString("utf8"), "second\n")
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);

  const identity = replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    admitted.witness,
    staged
  );

  assert.equal(readFileSync(recordPath, "utf8"), "second\n");
  const installed = lstatSync(recordPath, { bigint: true });
  assert.equal(identity.ino, installed.ino);
  assert.equal(identity.birthtimeNs, installed.birthtimeNs);
});

test("witnessed control writer survives Windows filename tunneling across delete and recreate", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");

  for (const [preparedValue, replacementValue] of [
    ["prepared-one\n", "assets-one\n"],
    ["prepared-two\n", "assets-two\n"]
  ] as const) {
    assert.notEqual(
      writeCreateOnceRecordWithIdentity(recordPath, canonicalDirectory, Buffer.from(preparedValue)),
      undefined
    );
    const staged = stageValidatedControlRecord(
      recordPath,
      canonicalDirectory,
      [canonicalDirectory],
      Buffer.from(replacementValue),
      (bytes: Buffer) => assert.equal(bytes.toString("utf8"), replacementValue)
    );
    const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
    const identity = replaceWitnessedControlRecord(
      recordPath,
      canonicalDirectory,
      [canonicalDirectory],
      admitted.witness,
      staged
    );
    const installed = lstatSync(recordPath, { bigint: true });
    assert.equal(identity.dev, installed.dev);
    assert.equal(identity.ino, installed.ino);
    assert.equal(identity.birthtimeNs, installed.birthtimeNs);
    assert.equal(readFileSync(recordPath, "utf8"), replacementValue);
    rmSync(recordPath);
  }
});

test("witnessed control writer rejects a target witness admitted before staging", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staleWitness = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => undefined
  );

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    staleWitness.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  assert.deepEqual(readdirSync(canonicalDirectory), ["record.json"]);
});

test("witnessed control writer rejects a replaced staged file before touching the target", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    (bytes: Buffer) => assert.equal(bytes.toString("utf8"), "second\n")
  );
  const stagedName = readdirSync(canonicalDirectory).find((name) => name.startsWith("@tmp-"));
  if (stagedName === undefined) assert.fail("expected one staged candidate");
  const stagedPath = join(canonicalDirectory, stagedName);
  renameSync(stagedPath, `${stagedPath}-original`);
  writeFileSync(stagedPath, "attack\n", "utf8");
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    admitted.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  assert.equal(readFileSync(stagedPath, "utf8"), "attack\n");
});

test("staged write and fsync failures remove only the inode created by exclusive open", (t) => {
  for (const phase of ["partial-write", "fsync"] as const) {
    const directory = createWorkspace();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const canonicalDirectory = realpathSync.native(directory);

    const result = runStagedWriteFailure(canonicalDirectory, phase);

    assert.equal(result.status, 0, `${phase}: ${String(result.stdout)} ${String(result.stderr)}`);
    assert.deepEqual(JSON.parse(String(result.stdout)), {
      phase,
      injected: true,
      rejected: true,
      targetExists: false,
      temporaryNames: []
    });
  }
});

for (const phase of ["partial-write", "fsync", "partial-write-replaced"] as const) {
  const expectation = phase === "partial-write-replaced"
    ? "retains a persistent replacement visible before cleanup"
    : "removes its still-matching exclusive-open inode";
  test(`create-once ${phase} failure ${expectation}`, (t) => {
    const directory = createWorkspace();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const canonicalDirectory = realpathSync.native(directory);

    const result = runCreateOnceWriteFailure(canonicalDirectory, phase);

    assert.equal(result.status, 0, `${phase}: ${String(result.stdout)} ${String(result.stderr)}`);
    const parsed = JSON.parse(String(result.stdout)) as {
      phase: string;
      injected: boolean;
      rejected: boolean;
      targetExists: boolean;
      temporary: Array<{ name: string; contents: string }>;
      clean: boolean;
      replacementSafe: boolean;
    };
    assert.equal(parsed.phase, phase);
    assert.equal(parsed.injected, true);
    assert.equal(parsed.rejected, true);
    assert.equal(parsed.targetExists, false);
    assert.equal(parsed.clean, phase !== "partial-write-replaced");
    assert.equal(parsed.replacementSafe, true);
  });
}

test("staged validation failure preserves the target and removes only its owned candidate", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");

  assert.throws(() => stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("invalid\n"),
    () => {
      throw new Error("candidate rejected");
    }
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  assert.deepEqual(readdirSync(canonicalDirectory), ["record.json"]);
});

test("witnessed control writer rejects a replaced old target without repairing it", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  const displacedPath = join(canonicalDirectory, "record-original.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    (bytes: Buffer) => assert.equal(bytes.toString("utf8"), "second\n")
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  renameSync(recordPath, displacedPath);
  writeFileSync(recordPath, "first\n", "utf8");

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    admitted.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  assert.equal(readFileSync(displacedPath, "utf8"), "first\n");
  assert.equal(readdirSync(canonicalDirectory).some((name) => name.startsWith("@tmp-")), false);
});

test("post-cutover validation uncertainty preserves the installed candidate without rollback", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  let validations = 0;
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => {
      validations += 1;
      if (validations === 2) throw new Error("post-cutover proof failed");
    }
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);

  assert.throws(
    () => replaceWitnessedControlRecord(
      recordPath,
      canonicalDirectory,
      [canonicalDirectory],
      admitted.witness,
      staged
    ),
    ControlRecordReplacementUncertainError
  );
  assert.equal(validations, 2);
  assert.equal(readFileSync(recordPath, "utf8"), "second\n");
  assert.deepEqual(readdirSync(canonicalDirectory), ["record.json"]);
});

test("post-cutover validator-side target replacement cannot return success", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  const displacedPath = join(canonicalDirectory, "installed-candidate.json");
  writeFileSync(recordPath, "first\n", "utf8");
  let validations = 0;
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => {
      validations += 1;
      if (validations === 2) {
        renameSync(recordPath, displacedPath);
        writeFileSync(recordPath, "second\n", "utf8");
      }
    }
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);

  assert.throws(
    () => replaceWitnessedControlRecord(
      recordPath,
      canonicalDirectory,
      [canonicalDirectory],
      admitted.witness,
      staged
    ),
    ControlRecordReplacementUncertainError
  );
  assert.equal(readFileSync(recordPath, "utf8"), "second\n");
  assert.equal(readFileSync(displacedPath, "utf8"), "second\n");
  assert.notEqual(lstatSync(recordPath, { bigint: true }).ino, lstatSync(displacedPath, { bigint: true }).ino);
});

test("post-cutover same-inode semantic rewrite cannot return success", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const targetPath = join(workspace, ".cu", "work-a", "semantic-record.json");
  writeFileSync(targetPath, '{"value":1}\n', "utf8");

  const result = runSemanticRewriteAfterReplacement(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-altered-bytes");
  assert.equal(readFileSync(targetPath, "utf8"), '{"value":2 }\n');
});

test("post-cutover cleanup never deletes a candidate moved back to its staging path", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  let validations = 0;
  let stagedPath = "";
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => {
      validations += 1;
      if (validations === 2) {
        renameSync(recordPath, stagedPath);
        throw new Error("post-cutover proof failed");
      }
    }
  );
  const stagedName = readdirSync(canonicalDirectory).find((name) => name.startsWith("@tmp-"));
  if (stagedName === undefined) assert.fail("expected one staged candidate");
  stagedPath = join(canonicalDirectory, stagedName);
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);

  assert.throws(
    () => replaceWitnessedControlRecord(
      recordPath,
      canonicalDirectory,
      [canonicalDirectory],
      admitted.witness,
      staged
    ),
    ControlRecordReplacementUncertainError
  );
  assert.equal(existsSync(recordPath), false);
  assert.equal(readFileSync(stagedPath, "utf8"), "second\n");
});

test("post-cutover parent replacement remains classified as uncertainty", (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalRoot = realpathSync.native(root);
  const parent = join(canonicalRoot, "records");
  const displacedParent = join(canonicalRoot, "records-installed");
  mkdirSync(parent);
  const canonicalParent = realpathSync.native(parent);
  const recordPath = join(canonicalParent, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  let validations = 0;
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalRoot, canonicalParent],
    Buffer.from("second\n"),
    () => {
      validations += 1;
      if (validations === 2) {
        renameSync(parent, displacedParent);
        writeFileSync(parent, "not-a-directory\n", "utf8");
        throw new Error("post-cutover proof failed");
      }
    }
  );
  const admitted = readStableRegularFileWithWitness(
    recordPath,
    [canonicalRoot, canonicalParent]
  );

  assert.throws(
    () => replaceWitnessedControlRecord(
      recordPath,
      canonicalParent,
      [canonicalRoot, canonicalParent],
      admitted.witness,
      staged
    ),
    ControlRecordReplacementUncertainError
  );
  assert.equal(readFileSync(join(displacedParent, "record.json"), "utf8"), "second\n");
});

test("staged control record discard removes only its still-owned temporary inode", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("candidate\n"),
    () => undefined
  );
  assert.equal(readdirSync(canonicalDirectory).filter((name) => name.startsWith("@tmp-")).length, 1);

  discardStagedControlRecord(staged);
  assert.deepEqual(readdirSync(canonicalDirectory), []);
  assert.throws(() => discardStagedControlRecord(staged));
});

test("staged control record discard preserves a replaced temporary path", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("candidate\n"),
    () => undefined
  );
  const stagedName = readdirSync(canonicalDirectory).find((name) => name.startsWith("@tmp-"));
  if (stagedName === undefined) assert.fail("expected one staged candidate");
  const stagedPath = join(canonicalDirectory, stagedName);
  renameSync(stagedPath, `${stagedPath}-original`);
  writeFileSync(stagedPath, "replacement\n", "utf8");

  assert.throws(() => discardStagedControlRecord(staged));
  assert.equal(readFileSync(stagedPath, "utf8"), "replacement\n");
  assert.equal(readFileSync(`${stagedPath}-original`, "utf8"), "candidate\n");
});

test("staged control record is bound to the exact ordered target ancestor chain", (t) => {
  const root = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalRoot = realpathSync.native(root);
  const parent = join(canonicalRoot, "records");
  mkdirSync(parent);
  const canonicalParent = realpathSync.native(parent);
  const recordPath = join(canonicalParent, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalRoot, canonicalParent],
    Buffer.from("second\n"),
    () => undefined
  );
  const shorterAdmission = readStableRegularFileWithWitness(recordPath, [canonicalParent]);

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalParent],
    shorterAdmission.witness,
    staged
  ));
  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalParent, canonicalRoot],
    shorterAdmission.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  discardStagedControlRecord(staged);
});

test("staged control record cannot be reused for another target in the same parent", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const intendedPath = join(canonicalDirectory, "intended.json");
  const otherPath = join(canonicalDirectory, "other.json");
  writeFileSync(intendedPath, "first\n", "utf8");
  writeFileSync(otherPath, "other\n", "utf8");
  const staged = stageValidatedControlRecord(
    intendedPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => undefined
  );
  const other = readStableRegularFileWithWitness(otherPath, [canonicalDirectory]);

  assert.throws(() => replaceWitnessedControlRecord(
    otherPath,
    canonicalDirectory,
    [canonicalDirectory],
    other.witness,
    staged
  ));
  assert.equal(readFileSync(intendedPath, "utf8"), "first\n");
  assert.equal(readFileSync(otherPath, "utf8"), "other\n");
  discardStagedControlRecord(staged);
});

test("witnessed control writer cannot create a missing target", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("candidate\n"),
    () => undefined
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  rmSync(recordPath);

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    admitted.witness,
    staged
  ));
  assert.equal(existsSync(recordPath), false);
  assert.deepEqual(readdirSync(canonicalDirectory), []);
});

test("witnessed control writer rejects forged and consumed staging capabilities", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const firstWitness = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  assert.throws(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    firstWitness.witness,
    {} as StagedControlRecord
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");

  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.from("second\n"),
    () => undefined
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  replaceWitnessedControlRecord(recordPath, canonicalDirectory, [canonicalDirectory], admitted.witness, staged);
  const installed = readStableRegularFileWithWitness(recordPath, [canonicalDirectory]);
  assert.throws(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    installed.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "second\n");
});

test("staging rejects oversized control-record bytes without residue", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);
  const recordPath = join(canonicalDirectory, "record.json");

  assert.throws(() => stageValidatedControlRecord(
    recordPath,
    canonicalDirectory,
    [canonicalDirectory],
    Buffer.alloc(MAX_CONTROL_RECORD_BYTES + 1),
    () => undefined
  ));
  assert.deepEqual(readdirSync(canonicalDirectory), []);
});

test("witnessed control writer rejects a persistent parent replacement without touching the new target", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const parent = join(workspace, "records");
  const displacedParent = join(workspace, "records-original");
  mkdirSync(parent);
  const canonicalParent = realpathSync.native(parent);
  const recordPath = join(canonicalParent, "record.json");
  writeFileSync(recordPath, "first\n", "utf8");
  const staged = stageValidatedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalParent],
    Buffer.from("second\n"),
    () => undefined
  );
  const admitted = readStableRegularFileWithWitness(recordPath, [canonicalParent]);
  renameSync(parent, displacedParent);
  mkdirSync(parent);
  writeFileSync(recordPath, "replacement-parent\n", "utf8");

  assertPreCutoverFailure(() => replaceWitnessedControlRecord(
    recordPath,
    canonicalParent,
    [canonicalParent],
    admitted.witness,
    staged
  ));
  assert.equal(readFileSync(recordPath, "utf8"), "replacement-parent\n");
  assert.equal(readFileSync(join(displacedParent, "record.json"), "utf8"), "first\n");
  assert.equal(readdirSync(displacedParent).some((name) => name.startsWith("@tmp-")), true);
});

test("process exits preserve the correct side of the replacement cutover", (t) => {
  const preDirectory = createWorkspace();
  const postDirectory = createWorkspace();
  t.after(() => rmSync(preDirectory, { recursive: true, force: true }));
  t.after(() => rmSync(postDirectory, { recursive: true, force: true }));
  const canonicalPre = realpathSync.native(preDirectory);
  const canonicalPost = realpathSync.native(postDirectory);
  const preRecord = join(canonicalPre, "record.json");
  const postRecord = join(canonicalPost, "record.json");
  writeFileSync(preRecord, "first\n", "utf8");
  writeFileSync(postRecord, "first\n", "utf8");

  const preResult = runReplacementCrashWorker(preRecord, canonicalPre, "pre-cutover");
  assert.equal(preResult.status, 22, String(preResult.stderr));
  assert.equal(readFileSync(preRecord, "utf8"), "first\n");
  assert.equal(readdirSync(canonicalPre).filter((name) => name.startsWith("@tmp-")).length, 1);

  const postResult = runReplacementCrashWorker(postRecord, canonicalPost, "post-cutover");
  assert.equal(postResult.status, 23, String(postResult.stderr));
  assert.equal(readFileSync(postRecord, "utf8"), "second\n");
  assert.deepEqual(readdirSync(canonicalPost), ["record.json"]);
});

test("staging rejects targets outside its admitted parent and junctioned parents", (t) => {
  const parent = createWorkspace();
  const outside = createWorkspace();
  const root = createWorkspace();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(() => stageValidatedControlRecord(
    join(outside, "escaped.json"),
    parent,
    [parent],
    Buffer.from("candidate\n"),
    () => undefined
  ));
  assert.deepEqual(readdirSync(parent), []);
  assert.deepEqual(readdirSync(outside), []);

  const alias = join(root, "records");
  symlinkSync(outside, alias, "junction");
  assert.throws(() => stageValidatedControlRecord(
    join(alias, "record.json"),
    alias,
    [alias],
    Buffer.from("candidate\n"),
    () => undefined
  ));
  assert.deepEqual(readdirSync(outside), []);
});

test("validated staged control record publishes create once with a final witness", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = realpathSync.native(join(workspace, ".cu", "work-a"));
  const stateDirectory = dirname(runDirectory);
  const recordPath = join(runDirectory, "published.json");
  const ancestors = [stateDirectory, runDirectory];
  const contents = Buffer.from('{"value":1}\n');
  const staged = stageValidatedControlRecord(
    recordPath,
    runDirectory,
    ancestors,
    contents,
    (bytes) => assert.deepEqual(bytes, contents)
  );

  const published = publishStagedControlRecordCreateOnce(
    recordPath,
    runDirectory,
    ancestors,
    staged
  );

  if (published === undefined) assert.fail("expected create-once publication");
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.identity), true);
  assert.deepEqual(readFileSync(recordPath), contents);
  const installed = lstatSync(recordPath, { bigint: true });
  assert.equal(published.identity.dev, installed.dev);
  assert.equal(published.identity.ino, installed.ino);
  assert.equal(published.identity.birthtimeNs, installed.birthtimeNs);
  revalidateStableRegularFileWitness(recordPath, ancestors, published.witness);
  assert.equal(readdirSync(runDirectory).some((name) => name.startsWith("@tmp-")), false);
  assert.throws(() => discardStagedControlRecord(staged));
});

test("create-once EEXIST plus staged cleanup loss remains publication uncertainty", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonicalDirectory = realpathSync.native(directory);

  const result = runCreateOnceConflictWithCleanupLoss(canonicalDirectory);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    uncertain: true,
    winnerPreserved: true,
    temporaryCount: 1,
    replacementPreserved: true
  });
});

test("staged create-once publication rejects cross-target, reordered, and forged capabilities", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = realpathSync.native(join(workspace, ".cu", "work-a"));
  const stateDirectory = dirname(runDirectory);
  const recordPath = join(runDirectory, "bound.json");
  const otherPath = join(runDirectory, "other.json");
  const ancestors = [stateDirectory, runDirectory];
  const staged = stageValidatedControlRecord(
    recordPath,
    runDirectory,
    ancestors,
    Buffer.from("candidate\n"),
    () => undefined
  );

  assert.throws(() =>
    publishStagedControlRecordCreateOnce(otherPath, runDirectory, ancestors, staged)
  );
  assert.throws(() =>
    publishStagedControlRecordCreateOnce(recordPath, runDirectory, [...ancestors].reverse(), staged)
  );
  assert.equal(existsSync(recordPath), false);
  assert.equal(existsSync(otherPath), false);
  discardStagedControlRecord(staged);

  const forged = Object.freeze({}) as StagedControlRecord;
  assert.throws(() =>
    publishStagedControlRecordCreateOnce(recordPath, runDirectory, ancestors, forged)
  );
  assert.equal(existsSync(recordPath), false);
});

test("staged create-once publication rejects a replaced staged path before linking", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = realpathSync.native(join(workspace, ".cu", "work-a"));
  const stateDirectory = dirname(runDirectory);
  const recordPath = join(runDirectory, "prelink.json");
  const ancestors = [stateDirectory, runDirectory];
  const staged = stageValidatedControlRecord(
    recordPath,
    runDirectory,
    ancestors,
    Buffer.from("candidate\n"),
    () => undefined
  );
  const temporaryName = readdirSync(runDirectory).find((name) => name.startsWith("@tmp-"));
  if (temporaryName === undefined) assert.fail("expected staged temporary record");
  const temporaryPath = join(runDirectory, temporaryName);
  rmSync(temporaryPath);
  writeFileSync(temporaryPath, "replacement\n");

  assert.throws(() =>
    publishStagedControlRecordCreateOnce(recordPath, runDirectory, ancestors, staged)
  );
  assert.equal(existsSync(recordPath), false);
  assert.equal(readFileSync(temporaryPath, "utf8"), "replacement\n");
  assert.throws(() => discardStagedControlRecord(staged));
});

test("create-once link side-effect uncertainty preserves both hard-link names", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = join(workspace, ".cu", "work-a");
  const recordPath = join(runDirectory, "link-uncertain.json");

  const result = runCreateOnceLinkSideEffectThenThrow(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-post-link-failure");
  assert.equal(readFileSync(recordPath, "utf8"), '{"value":3}\n');
  const temporaryNames = readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
  assert.equal(temporaryNames.length, 1);
  const installed = lstatSync(recordPath, { bigint: true });
  const staged = lstatSync(join(runDirectory, temporaryNames[0]!), { bigint: true });
  assert.equal(installed.dev, staged.dev);
  assert.equal(installed.ino, staged.ino);
  assert.equal(installed.birthtimeNs, staged.birthtimeNs);
});

test("post-link create-once byte uncertainty preserves the installed evidence", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = join(workspace, ".cu", "work-a");
  const recordPath = join(runDirectory, "published-semantic.json");

  const result = runSemanticRewriteAfterCreateOncePublication(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.equal(result.stdout, "rejected-altered-publication");
  assert.equal(readFileSync(recordPath, "utf8"), '{"value":2 }\n');
  assert.equal(readdirSync(runDirectory).some((name) => name.startsWith("@tmp-")), false);
});

test("validated staged create-once publication preserves an existing winner", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, "work-a");
  const runDirectory = realpathSync.native(join(workspace, ".cu", "work-a"));
  const stateDirectory = dirname(runDirectory);
  const recordPath = join(runDirectory, "winner.json");
  const ancestors = [stateDirectory, runDirectory];
  const winner = Buffer.from('{"value":"winner"}\n');
  const candidate = Buffer.from('{"value":"candidate"}\n');
  writeFileSync(recordPath, winner);
  const staged = stageValidatedControlRecord(
    recordPath,
    runDirectory,
    ancestors,
    candidate,
    (bytes) => assert.deepEqual(bytes, candidate)
  );

  const published = publishStagedControlRecordCreateOnce(
    recordPath,
    runDirectory,
    ancestors,
    staged
  );

  assert.equal(published, undefined);
  assert.deepEqual(readFileSync(recordPath), winner);
  assert.equal(readdirSync(runDirectory).some((name) => name.startsWith("@tmp-")), false);
  assert.throws(() => discardStagedControlRecord(staged));
});

test("create-once control writer publishes one record without rewriting a winner", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const recordPath = join(directory, "record.json");

  assert.equal(writeCreateOnceRecord(recordPath, directory, Buffer.from("first\n")), true);
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
  assert.equal(writeCreateOnceRecord(recordPath, directory, Buffer.from("second\n")), false);
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
});

test("create-once control writer returns the identity of the published file", (t) => {
  const directory = createWorkspace();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const recordPath = join(directory, "record.json");

  const published = writeCreateOnceRecordWithIdentity(recordPath, directory, Buffer.from("first\n"));
  const actual = lstatSync(recordPath, { bigint: true });

  if (published === undefined) {
    assert.fail("expected a published identity");
  }
  assert.equal(published.dev, actual.dev);
  assert.equal(published.ino, actual.ino);
  assert.equal(published.birthtimeNs, actual.birthtimeNs);
  assert.equal(writeCreateOnceRecordWithIdentity(recordPath, directory, Buffer.from("second\n")), undefined);
  assert.equal(readFileSync(recordPath, "utf8"), "first\n");
});

test("create-once control writer rejects a final path outside its admitted parent", (t) => {
  const parent = createWorkspace();
  const outside = createWorkspace();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const escapedPath = join(outside, "escaped.json");

  assert.throws(() => writeCreateOnceRecord(escapedPath, parent, Buffer.from("escaped\n")));
  assert.equal(existsSync(escapedPath), false);
  assert.deepEqual(readdirSync(parent), []);
});

test("create-once control writer rejects a junctioned parent without writing outside", (t) => {
  const root = createWorkspace();
  const outside = createWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const parent = join(root, "records");
  const recordPath = join(parent, "record.json");
  symlinkSync(outside, parent, "junction");

  assert.throws(() => writeCreateOnceRecord(recordPath, parent, Buffer.from("outside\n")));
  assert.equal(existsSync(join(outside, "record.json")), false);
  assert.deepEqual(readdirSync(outside), []);
});

test("create-once control writer rejects a record path routed through a parent alias", (t) => {
  const parent = createWorkspace();
  const aliasRoot = createWorkspace();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  t.after(() => rmSync(aliasRoot, { recursive: true, force: true }));
  const alias = join(aliasRoot, "parent-alias");
  symlinkSync(parent, alias, "junction");

  assert.throws(() => writeCreateOnceRecord(join(alias, "record.json"), parent, Buffer.from("alias\n")));
  assert.deepEqual(readdirSync(parent), []);
});

test("run lock blocks ensureRun across a separate Node process", async (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const child = spawn(process.execPath, [lockWorkerPath, workspace, "work-a"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  await waitForWorkerAcquisition(child);

  assert.throws(() => ensureRun(workspace, "work-a"), RunLockBusyError);
  const closed = once(child, "close");
  child.stdin!.end("release\n");
  const [status] = (await closed) as [number | null];
  assert.equal(status, 0);
  assert.equal(ensureRun(workspace, "work-a").created, true);
});

test("concurrent ensureRun attempts leave one valid record and no per-run lock residue", async (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => runEnsureWorker(workspace, "work-a"))
  );
  const created = results.filter((result) => result.kind === "result" && result.created === true);
  const allowed = results.every(
    (result) =>
      (result.kind === "result" && typeof result.created === "boolean") ||
      (result.kind === "error" && result.name === "RunLockBusyError")
  );
  const runDirectory = join(workspace, ".cu", "work-a");

  assert.equal(allowed, true, JSON.stringify(results));
  assert.equal(created.length, 1, JSON.stringify(results));
  assert.equal(inspectRun(workspace, "work-a")?.runId, "work-a");
  assert.deepEqual(readdirSync(runDirectory), ["run.json"]);
  assert.equal(existsSync(join(workspace, ".cu", "@locks", "work-a")), false);
  assert.deepEqual(readdirSync(join(workspace, ".cu", "@locks")), []);
});
