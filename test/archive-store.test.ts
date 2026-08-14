import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ArchiveStoreError,
  ArchiveStorePublicationUncertainError,
  inspectArchiveTransaction,
  inspectArchiveTransactionWithWitness,
  publishPreparedArchiveTransaction
} from "../src/archive-store.js";
import {
  RegularFileError,
  revalidateStableRegularFileWitness
} from "../src/regular-file.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock, type RunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const runId = "work-a";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-archive-store-"));
}

function prepareRun(workspace: string): string {
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  return join(workspace, ".cu", runId);
}

function captureArchiveStoreError(operation: () => unknown): ArchiveStoreError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ArchiveStoreError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected ArchiveStoreError");
}

function writeRunWithoutWorkspaceRecord(workspace: string): { runDirectory: string; recordPath: string; bytes: string } {
  const runDirectory = join(workspace, ".cu", runId);
  const recordPath = join(runDirectory, "run.json");
  const bytes = `${JSON.stringify({
    kind: "cu.run/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace),
    profile: "autonomous",
    lifecycle: "ready",
    createdAt: "2026-07-24T00:00:00.000Z"
  })}\n`;
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(recordPath, bytes, "utf8");
  return { runDirectory, recordPath, bytes };
}

function archiveTransaction(workspace: string): Record<string, unknown> {
  const oldBundle = {
    observationId: "obs_1123456789abcdef0123456789abcdef",
    captureMetadataSha256: "b".repeat(64),
    imageSha256: "c".repeat(64),
    imageByteLength: 12345
  };
  return {
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace),
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    operation: "publish",
    state: "prepared",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    priorLive: null,
    movedBundles: [oldBundle],
    historyEvents: [],
    payload: {
      newBundle: {
        observationId: "obs_0123456789abcdef0123456789abcdef",
        captureMetadataSha256: "d".repeat(64),
        imageSha256: "e".repeat(64),
        imageByteLength: 23456
      },
      newLiveRecordSha256: "f".repeat(64),
      replacesObservationId: null,
      resolvesEffect: null
    }
  };
}

function writeArchiveTransaction(workspace: string, transaction: Record<string, unknown>): { path: string; bytes: string } {
  const path = join(workspace, ".cu", runId, "archive-transaction.json");
  const bytes = `${JSON.stringify(transaction)}\n`;
  writeFileSync(path, bytes, "utf8");
  return { path, bytes };
}

function runLockLossDuringArchivePublication(
  workspace: string,
  candidateBytes: Buffer,
  phase: "after-stage" | "after-absence" | "after-cutover"
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const originalLstat = fs.lstatSync.bind(fs);
    const descriptors = new Map();
    const phase = process.env.CU_TEST_PHASE;
    let injected = false;
    const loseLock = () => {
      fs.writeFileSync(ownerPath, "{}\\n");
      injected = true;
    };
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      descriptors.set(descriptor, resolve(String(path)));
      return descriptor;
    };
    fs.closeSync = (descriptor) => {
      const path = descriptors.get(descriptor);
      descriptors.delete(descriptor);
      const result = originalClose(descriptor);
      if (
        phase === "after-stage" &&
        !injected &&
        path !== undefined &&
        dirname(path).toLowerCase() === runDirectory.toLowerCase() &&
        basename(path).startsWith("@tmp-")
      ) {
        loseLock();
      }
      return result;
    };
    fs.lstatSync = (path, ...args) => {
      try {
        const result = originalLstat(path, ...args);
        if (
          phase === "after-cutover" &&
          !injected &&
          resolve(String(path)).toLowerCase() === target.toLowerCase() &&
          !fs.readdirSync(runDirectory).some((name) => name.startsWith("@tmp-"))
        ) {
          loseLock();
        }
        return result;
      } catch (error) {
        if (
          phase === "after-absence" &&
          !injected &&
          error?.code === "ENOENT" &&
          resolve(String(path)).toLowerCase() === target.toLowerCase() &&
          fs.readdirSync(runDirectory).some((name) => name.startsWith("@tmp-"))
        ) {
          loseLock();
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const {
      ArchiveStoreError,
      ArchiveStorePublicationUncertainError,
      publishPreparedArchiveTransaction
    } = await import(${JSON.stringify(archiveStoreUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let rejected = false;
    let uncertain = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      rejected = error instanceof ArchiveStoreError && error.message === "";
      uncertain = error instanceof ArchiveStorePublicationUncertainError && error.message === "";
    }
    try { lock.release(); } catch {}
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const result = { injected, targetExists: fs.existsSync(target), temporaryNames, rejected, uncertain };
    process.stdout.write(JSON.stringify(result));
    const expectedTarget = phase === "after-cutover";
    const expectedUncertain = phase === "after-cutover";
    process.exitCode =
      injected &&
      result.targetExists === expectedTarget &&
      temporaryNames.length === 0 &&
      rejected &&
      uncertain === expectedUncertain
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64"),
      CU_TEST_PHASE: phase
    }
  });
}

function runArchiveRunDirectoryReplacementAfterAbsenceCycle(
  workspace: string,
  candidateBytes: Buffer,
  absenceCycle: 1 | 2 | 3
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const transactionPath = resolve(join(runDirectory, "archive-transaction.json"));
    const originalDirectory = join(dirname(workspace), basename(workspace) + "-original-run");
    const replacementDirectory = join(dirname(workspace), basename(workspace) + "-replacement-run");
    fs.rmSync(originalDirectory, { recursive: true, force: true });
    fs.rmSync(replacementDirectory, { recursive: true, force: true });
    fs.mkdirSync(replacementDirectory);
    fs.copyFileSync(join(runDirectory, "run.json"), join(replacementDirectory, "run.json"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalLstat = fs.lstatSync.bind(fs);
    const desiredAbsenceCycle = Number(process.env.CU_TEST_ABSENCE_CYCLE);
    let targetMissingCount = 0;
    let runSnapshotsAfterMissing = 0;
    let replaced = false;
    fs.lstatSync = (path, ...args) => {
      const resolved = resolve(String(path));
      try {
        const result = originalLstat(path, ...args);
        if (
          targetMissingCount === desiredAbsenceCycle &&
          !replaced &&
          resolved.toLowerCase() === runDirectory.toLowerCase()
        ) {
          runSnapshotsAfterMissing += 1;
          if (runSnapshotsAfterMissing === 2) {
            fs.renameSync(runDirectory, originalDirectory);
            fs.renameSync(replacementDirectory, runDirectory);
            replaced = true;
          }
        }
        return result;
      } catch (error) {
        if (
          resolved.toLowerCase() === transactionPath.toLowerCase() &&
          error?.code === "ENOENT"
        ) {
          targetMissingCount += 1;
          runSnapshotsAfterMissing = 0;
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { ArchiveStoreError, publishPreparedArchiveTransaction } = await import(${JSON.stringify(archiveStoreUrl)});
    let rejected = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      rejected = error instanceof ArchiveStoreError && error.message === "";
    }
    const targetExists = fs.existsSync(transactionPath);
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const displacedTemporaryNames = fs.readdirSync(originalDirectory).filter((name) => name.startsWith("@tmp-"));
    fs.rmSync(runDirectory, { recursive: true, force: true });
    fs.renameSync(originalDirectory, runDirectory);
    fs.rmSync(replacementDirectory, { recursive: true, force: true });
    try { lock.release(); } catch {}
    const result = {
      desiredAbsenceCycle,
      replaced,
      targetMissingCount,
      runSnapshotsAfterMissing,
      rejected,
      targetExists,
      temporaryNames,
      displacedTemporaryNames
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode =
      replaced &&
      targetMissingCount === desiredAbsenceCycle &&
      runSnapshotsAfterMissing === 2 &&
      rejected &&
      !targetExists &&
      temporaryNames.length === 0 &&
      displacedTemporaryNames.length === (desiredAbsenceCycle === 3 ? 1 : 0)
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64"),
      CU_TEST_ABSENCE_CYCLE: String(absenceCycle)
    }
  });
}

function runArchiveRunDirectoryReplacementAfterControlSuccess(
  workspace: string,
  candidateBytes: Buffer
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const originalDirectory = join(dirname(workspace), basename(workspace) + "-published-run");
    const replacementDirectory = join(dirname(workspace), basename(workspace) + "-post-publish-run");
    fs.rmSync(originalDirectory, { recursive: true, force: true });
    fs.rmSync(replacementDirectory, { recursive: true, force: true });
    fs.mkdirSync(replacementDirectory);
    fs.copyFileSync(join(runDirectory, "run.json"), join(replacementDirectory, "run.json"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalLstat = fs.lstatSync.bind(fs);
    let successfulTargetLstats = 0;
    let replaced = false;
    fs.lstatSync = (path, ...args) => {
      const result = originalLstat(path, ...args);
      if (
        !replaced &&
        resolve(String(path)).toLowerCase() === target.toLowerCase()
      ) {
        successfulTargetLstats += 1;
        if (successfulTargetLstats === 7) {
          fs.renameSync(runDirectory, originalDirectory);
          fs.renameSync(replacementDirectory, runDirectory);
          replaced = true;
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const {
      ArchiveStorePublicationUncertainError,
      publishPreparedArchiveTransaction
    } = await import(${JSON.stringify(archiveStoreUrl)});
    let uncertain = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      uncertain = error instanceof ArchiveStorePublicationUncertainError && error.message === "";
    }
    const replacementTargetExists = fs.existsSync(target);
    const displacedTarget = join(originalDirectory, "archive-transaction.json");
    const displacedTargetExists = fs.existsSync(displacedTarget);
    const displacedBytesMatch =
      displacedTargetExists &&
      fs.readFileSync(displacedTarget).equals(Buffer.from(process.env.CU_TEST_CANDIDATE, "base64"));
    const replacementNames = fs.readdirSync(runDirectory).sort();
    fs.rmSync(runDirectory, { recursive: true, force: true });
    fs.renameSync(originalDirectory, runDirectory);
    fs.rmSync(replacementDirectory, { recursive: true, force: true });
    try { lock.release(); } catch {}
    const result = {
      replaced,
      successfulTargetLstats,
      uncertain,
      replacementTargetExists,
      displacedTargetExists,
      displacedBytesMatch,
      replacementNames
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode =
      replaced &&
      successfulTargetLstats === 7 &&
      uncertain &&
      !replacementTargetExists &&
      displacedTargetExists &&
      displacedBytesMatch &&
      replacementNames.length === 1 &&
      replacementNames[0] === "run.json"
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64")
    }
  });
}

function runStagedArchiveReplacementBeforeLink(
  workspace: string,
  candidateBytes: Buffer
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    let stagePresentOwnerReads = 0;
    let injected = false;
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      descriptors.set(descriptor, resolve(String(path)));
      return descriptor;
    };
    fs.closeSync = (descriptor) => {
      const path = descriptors.get(descriptor);
      descriptors.delete(descriptor);
      const result = originalClose(descriptor);
      const stageName = fs.readdirSync(runDirectory).find((name) => name.startsWith("@tmp-"));
      if (
        !injected &&
        path?.toLowerCase() === ownerPath.toLowerCase() &&
        stageName !== undefined
      ) {
        stagePresentOwnerReads += 1;
        if (stagePresentOwnerReads === 2) {
          const stagePath = join(runDirectory, stageName);
          fs.rmSync(stagePath);
          fs.writeFileSync(stagePath, "replacement stage bytes\\n");
          injected = true;
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const { ArchiveStoreError, publishPreparedArchiveTransaction } = await import(${JSON.stringify(archiveStoreUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let rejected = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      rejected = error instanceof ArchiveStoreError && error.message === "";
    } finally {
      lock.release();
    }
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const replacementPreserved =
      temporaryNames.length === 1 &&
      fs.readFileSync(join(runDirectory, temporaryNames[0]), "utf8") === "replacement stage bytes\\n";
    const result = {
      injected,
      stagePresentOwnerReads,
      rejected,
      targetExists: fs.existsSync(target),
      temporaryCount: temporaryNames.length,
      replacementPreserved
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode =
      injected &&
      stagePresentOwnerReads === 2 &&
      rejected &&
      !result.targetExists &&
      temporaryNames.length === 1 &&
      replacementPreserved
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64")
    }
  });
}

function runArchiveStageOpenFailure(
  workspace: string,
  candidateBytes: Buffer
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const originalOpen = fs.openSync.bind(fs);
    let injected = false;
    fs.openSync = (path, ...args) => {
      const resolved = resolve(String(path));
      if (
        !injected &&
        dirname(resolved).toLowerCase() === runDirectory.toLowerCase() &&
        basename(resolved).startsWith("@tmp-")
      ) {
        injected = true;
        throw Object.assign(new Error("private stage path must not escape"), { code: "EACCES" });
      }
      return originalOpen(path, ...args);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const { ArchiveStoreError, publishPreparedArchiveTransaction } = await import(${JSON.stringify(archiveStoreUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let rejected = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      rejected =
        error instanceof ArchiveStoreError &&
        error.message === "" &&
        !String(error.stack).includes("private stage path must not escape");
    } finally {
      lock.release();
    }
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const result = { injected, rejected, targetExists: fs.existsSync(target), temporaryNames };
    process.stdout.write(JSON.stringify(result));
    process.exitCode = injected && rejected && !result.targetExists && temporaryNames.length === 0 ? 0 : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64")
    }
  });
}

function runArchiveLinkSideEffectThenThrow(
  workspace: string,
  candidateBytes: Buffer
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const originalLink = fs.linkSync.bind(fs);
    let injected = false;
    fs.linkSync = (existing, destination) => {
      if (!injected && resolve(String(destination)).toLowerCase() === target.toLowerCase()) {
        originalLink(existing, destination);
        injected = true;
        throw Object.assign(new Error("injected post-link failure"), { code: "EPERM" });
      }
      return originalLink(existing, destination);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const {
      ArchiveStorePublicationUncertainError,
      publishPreparedArchiveTransaction
    } = await import(${JSON.stringify(archiveStoreUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let uncertain = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      uncertain = error instanceof ArchiveStorePublicationUncertainError && error.message === "";
    } finally {
      lock.release();
    }
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const targetStat = fs.lstatSync(target, { bigint: true });
    const temporaryStat = temporaryNames.length === 1
      ? fs.lstatSync(join(runDirectory, temporaryNames[0]), { bigint: true })
      : undefined;
    const sameInode =
      temporaryStat !== undefined &&
      targetStat.dev === temporaryStat.dev &&
      targetStat.ino === temporaryStat.ino &&
      targetStat.birthtimeNs === temporaryStat.birthtimeNs;
    const exactBytes = fs.readFileSync(target).equals(Buffer.from(process.env.CU_TEST_CANDIDATE, "base64"));
    const result = { injected, uncertain, temporaryCount: temporaryNames.length, sameInode, exactBytes };
    process.stdout.write(JSON.stringify(result));
    process.exitCode = injected && uncertain && temporaryNames.length === 1 && sameInode && exactBytes ? 0 : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64")
    }
  });
}

function runWinnerRacingArchivePublication(
  workspace: string,
  candidateBytes: Buffer,
  winnerBytes: Buffer,
  phase:
    | "after-stage"
    | "after-absence-with-stage-replacement"
    | "at-link"
    | "at-link-with-stage-replacement"
): ReturnType<typeof spawnSync> {
  const archiveStoreUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "archive-store.js")).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname, join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = fs.realpathSync.native(join(workspace, ".cu", "work-a"));
    const target = resolve(join(runDirectory, "archive-transaction.json"));
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const originalLstat = fs.lstatSync.bind(fs);
    const originalLink = fs.linkSync.bind(fs);
    const descriptors = new Map();
    const phase = process.env.CU_TEST_PHASE;
    let injected = false;
    let targetLinkAttempts = 0;
    fs.openSync = (path, ...args) => {
      const descriptor = originalOpen(path, ...args);
      descriptors.set(descriptor, resolve(String(path)));
      return descriptor;
    };
    fs.closeSync = (descriptor) => {
      const path = descriptors.get(descriptor);
      descriptors.delete(descriptor);
      const result = originalClose(descriptor);
      if (
        phase === "after-stage" &&
        !injected &&
        path !== undefined &&
        dirname(path).toLowerCase() === runDirectory.toLowerCase() &&
        basename(path).startsWith("@tmp-")
      ) {
        fs.writeFileSync(target, Buffer.from(process.env.CU_TEST_WINNER, "base64"));
        injected = true;
      }
      return result;
    };
    fs.lstatSync = (path, ...args) => {
      try {
        return originalLstat(path, ...args);
      } catch (error) {
        const stageName = fs.readdirSync(runDirectory).find((name) => name.startsWith("@tmp-"));
        if (
          phase === "after-absence-with-stage-replacement" &&
          !injected &&
          resolve(String(path)).toLowerCase() === target.toLowerCase() &&
          stageName !== undefined &&
          error?.code === "ENOENT"
        ) {
          fs.writeFileSync(target, Buffer.from(process.env.CU_TEST_WINNER, "base64"));
          const stagePath = join(runDirectory, stageName);
          fs.rmSync(stagePath);
          fs.writeFileSync(stagePath, "replacement stage bytes\\n");
          injected = true;
        }
        throw error;
      }
    };
    fs.linkSync = (existing, destination) => {
      if (resolve(String(destination)).toLowerCase() === target.toLowerCase()) {
        targetLinkAttempts += 1;
        if ((phase === "at-link" || phase === "at-link-with-stage-replacement") && !injected) {
          fs.writeFileSync(target, Buffer.from(process.env.CU_TEST_WINNER, "base64"));
          if (phase === "at-link-with-stage-replacement") {
            fs.rmSync(existing);
            fs.writeFileSync(existing, "replacement stage bytes\\n");
          }
          injected = true;
        }
      }
      return originalLink(existing, destination);
    };
    syncBuiltinESMExports();
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const {
      ArchiveStoreError,
      ArchiveStorePublicationUncertainError,
      publishPreparedArchiveTransaction
    } = await import(${JSON.stringify(archiveStoreUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    let rejected = false;
    let uncertain = false;
    try {
      publishPreparedArchiveTransaction(
        lock,
        workspace,
        "work-a",
        Buffer.from(process.env.CU_TEST_CANDIDATE, "base64")
      );
    } catch (error) {
      rejected = error instanceof ArchiveStoreError && error.message === "";
      uncertain = error instanceof ArchiveStorePublicationUncertainError && error.message === "";
    } finally {
      lock.release();
    }
    const temporaryNames = fs.readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-"));
    const winnerMatches = fs.readFileSync(target).equals(Buffer.from(process.env.CU_TEST_WINNER, "base64"));
    const replacementPreserved =
      temporaryNames.length === 1 &&
      fs.readFileSync(join(runDirectory, temporaryNames[0]), "utf8") === "replacement stage bytes\\n";
    const result = {
      injected,
      targetLinkAttempts,
      temporaryNames,
      winnerMatches,
      replacementPreserved,
      rejected,
      uncertain
    };
    process.stdout.write(JSON.stringify(result));
    const expectedLinkAttempts = phase.startsWith("at-link") ? 1 : 0;
    const expectedTemporaryCount =
      phase === "after-absence-with-stage-replacement" ||
      phase === "at-link-with-stage-replacement"
        ? 1
        : 0;
    const expectedUncertain = phase.startsWith("at-link");
    process.exitCode =
      injected &&
      targetLinkAttempts === expectedLinkAttempts &&
      temporaryNames.length === expectedTemporaryCount &&
      replacementPreserved === (expectedTemporaryCount === 1) &&
      winnerMatches &&
      rejected &&
      uncertain === expectedUncertain
        ? 0
        : 24;
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_CANDIDATE: candidateBytes.toString("base64"),
      CU_TEST_WINNER: winnerBytes.toString("base64"),
      CU_TEST_PHASE: phase
    }
  });
}

test("publishes one prepared archive transaction under an exact held run lock", (t) => {
  const workspace = createWorkspace();
  const runDirectory = prepareRun(workspace);
  const recordPath = join(runDirectory, "archive-transaction.json");
  const runRecordPath = join(runDirectory, "run.json");
  const runRecordBytes = readFileSync(runRecordPath);
  const bytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    lock.release();
    rmSync(workspace, { recursive: true, force: true });
  });

  const published = publishPreparedArchiveTransaction(lock, workspace, runId, bytes);

  assert.equal(published.transaction.state, "prepared");
  assert.equal(published.transaction.transactionId, "txn_0123456789abcdef0123456789abcdef");
  assert.equal(published.recordPath, realpathSync.native(recordPath));
  assert.deepEqual(readFileSync(recordPath), bytes);
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Object.isFrozen(published.identity), true);
  assert.equal(Object.isFrozen(published.ancestors), true);
  assert.doesNotThrow(() =>
    revalidateStableRegularFileWitness(
      published.recordPath,
      published.ancestors,
      published.witness
    )
  );
  assert.deepEqual(readFileSync(runRecordPath), runRecordBytes);
  assert.deepEqual(readdirSync(runDirectory).sort(), ["archive-transaction.json", "run.json"]);
});

test("revalidates the held run lock after staging before publication", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runLockLossDuringArchivePublication(workspace, candidateBytes, "after-stage");

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetExists: false,
    temporaryNames: [],
    rejected: true,
    uncertain: false
  });
});

test("revalidates the held run lock after post-stage absence before linking", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runLockLossDuringArchivePublication(workspace, candidateBytes, "after-absence");

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetExists: false,
    temporaryNames: [],
    rejected: true,
    uncertain: false
  });
});

test("classifies lock loss after archive installation as publication uncertainty", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runLockLossDuringArchivePublication(workspace, candidateBytes, "after-cutover");

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetExists: true,
    temporaryNames: [],
    rejected: true,
    uncertain: true
  });
});

test("cleans its owned stage when post-stage archive admission fails", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const malformedWinner = Buffer.from('{"private":"untrusted archive text"');

  const result = runWinnerRacingArchivePublication(
    workspace,
    candidateBytes,
    malformedWinner,
    "after-stage"
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetLinkAttempts: 0,
    temporaryNames: [],
    winnerMatches: true,
    replacementPreserved: false,
    rejected: true,
    uncertain: false
  });
});

test("rechecks archive absence after staging before attempting the target link", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const winnerBytes = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    transactionId: "txn_1123456789abcdef0123456789abcdef"
  })}\n`);

  const result = runWinnerRacingArchivePublication(
    workspace,
    candidateBytes,
    winnerBytes,
    "after-stage"
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetLinkAttempts: 0,
    temporaryNames: [],
    winnerMatches: true,
    replacementPreserved: false,
    rejected: true,
    uncertain: false
  });
});

test("preserves a replaced staged path when winner cleanup is uncertain", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const winnerBytes = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    transactionId: "txn_3123456789abcdef0123456789abcdef"
  })}\n`);

  const result = runWinnerRacingArchivePublication(
    workspace,
    candidateBytes,
    winnerBytes,
    "after-absence-with-stage-replacement"
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    injected: boolean;
    targetLinkAttempts: number;
    temporaryNames: string[];
    winnerMatches: boolean;
    replacementPreserved: boolean;
    rejected: boolean;
    uncertain: boolean;
  };
  assert.equal(output.injected, true);
  assert.equal(output.targetLinkAttempts, 0);
  assert.equal(output.temporaryNames.length, 1);
  assert.equal(output.winnerMatches, true);
  assert.equal(output.replacementPreserved, true);
  assert.equal(output.rejected, true);
  assert.equal(output.uncertain, false);
});

test("binds initial stable absence to the same run directory used for staging", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveRunDirectoryReplacementAfterAbsenceCycle(
    workspace,
    candidateBytes,
    1
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    desiredAbsenceCycle: 1,
    replaced: true,
    targetMissingCount: 1,
    runSnapshotsAfterMissing: 2,
    rejected: true,
    targetExists: false,
    temporaryNames: [],
    displacedTemporaryNames: []
  });
});

test("retains the admitted run identity after final pre-stage absence", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveRunDirectoryReplacementAfterAbsenceCycle(
    workspace,
    candidateBytes,
    2
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    desiredAbsenceCycle: 2,
    replaced: true,
    targetMissingCount: 2,
    runSnapshotsAfterMissing: 2,
    rejected: true,
    targetExists: false,
    temporaryNames: [],
    displacedTemporaryNames: []
  });
});

test("rejects run-directory replacement after post-stage absence without following cleanup", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveRunDirectoryReplacementAfterAbsenceCycle(
    workspace,
    candidateBytes,
    3
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    desiredAbsenceCycle: number;
    replaced: boolean;
    targetMissingCount: number;
    runSnapshotsAfterMissing: number;
    rejected: boolean;
    targetExists: boolean;
    temporaryNames: string[];
    displacedTemporaryNames: string[];
  };
  assert.equal(output.desiredAbsenceCycle, 3);
  assert.equal(output.replaced, true);
  assert.equal(output.targetMissingCount, 3);
  assert.equal(output.runSnapshotsAfterMissing, 2);
  assert.equal(output.rejected, true);
  assert.equal(output.targetExists, false);
  assert.deepEqual(output.temporaryNames, []);
  assert.equal(output.displacedTemporaryNames.length, 1);
});

test("classifies run-directory replacement after control publication as uncertainty", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveRunDirectoryReplacementAfterControlSuccess(
    workspace,
    candidateBytes
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    replaced: true,
    successfulTargetLstats: 7,
    uncertain: true,
    replacementTargetExists: false,
    displacedTargetExists: true,
    displacedBytesMatch: true,
    replacementNames: ["run.json"]
  });
});

test("contains pre-link staged-identity rejection and preserves replacement evidence", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runStagedArchiveReplacementBeforeLink(workspace, candidateBytes);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    stagePresentOwnerReads: 2,
    rejected: true,
    targetExists: false,
    temporaryCount: 1,
    replacementPreserved: true
  });
});

test("contains archive staging failures without disclosing filesystem details", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveStageOpenFailure(workspace, candidateBytes);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    rejected: true,
    targetExists: false,
    temporaryNames: []
  });
});

test("maps post-link control uncertainty without rolling back archive evidence", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const result = runArchiveLinkSideEffectThenThrow(workspace, candidateBytes);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    uncertain: true,
    temporaryCount: 1,
    sameInode: true,
    exactBytes: true
  });
});

test("classifies an EEXIST race after final absence as publication uncertainty", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const winnerBytes = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    transactionId: "txn_2123456789abcdef0123456789abcdef"
  })}\n`);

  const result = runWinnerRacingArchivePublication(
    workspace,
    candidateBytes,
    winnerBytes,
    "at-link"
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  assert.deepEqual(JSON.parse(String(result.stdout)), {
    injected: true,
    targetLinkAttempts: 1,
    temporaryNames: [],
    winnerMatches: true,
    replacementPreserved: false,
    rejected: true,
    uncertain: true
  });
});

test("preserves EEXIST publication uncertainty when staged cleanup loses identity", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const candidateBytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const winnerBytes = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    transactionId: "txn_4123456789abcdef0123456789abcdef"
  })}\n`);

  const result = runWinnerRacingArchivePublication(
    workspace,
    candidateBytes,
    winnerBytes,
    "at-link-with-stage-replacement"
  );

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    injected: boolean;
    targetLinkAttempts: number;
    temporaryNames: string[];
    winnerMatches: boolean;
    replacementPreserved: boolean;
    rejected: boolean;
    uncertain: boolean;
  };
  assert.equal(output.injected, true);
  assert.equal(output.targetLinkAttempts, 1);
  assert.equal(output.temporaryNames.length, 1);
  assert.equal(output.winnerMatches, true);
  assert.equal(output.replacementPreserved, true);
  assert.equal(output.rejected, true);
  assert.equal(output.uncertain, true);
});

test("rejects an active archive transaction before creating a staged sibling", (t) => {
  const workspace = createWorkspace();
  const runDirectory = prepareRun(workspace);
  const winner = writeArchiveTransaction(workspace, archiveTransaction(workspace));
  const candidate = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    transactionId: "txn_1123456789abcdef0123456789abcdef"
  })}\n`);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    lock.release();
    rmSync(workspace, { recursive: true, force: true });
  });
  const before = lstatSync(runDirectory, { bigint: true });

  const error = captureArchiveStoreError(() =>
    publishPreparedArchiveTransaction(lock, workspace, runId, candidate)
  );

  const after = lstatSync(runDirectory, { bigint: true });
  assert.equal(error.message, "");
  assert.equal(readFileSync(winner.path, "utf8"), winner.bytes);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(readdirSync(runDirectory).sort(), ["archive-transaction.json", "run.json"]);
});

test("requires the exact active run-lock binding before archive staging", (t) => {
  const workspace = createWorkspace();
  const otherWorkspace = createWorkspace();
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  });
  const runDirectory = prepareRun(workspace);
  prepareRun(otherWorkspace);
  ensureRun(workspace, "work-b");
  const recordPath = join(runDirectory, "archive-transaction.json");
  const bytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);

  const released = acquireRunLock(workspace, runId);
  released.release();
  const crossRun = acquireRunLock(workspace, "work-b");
  const crossWorkspace = acquireRunLock(otherWorkspace, runId);
  try {
    const cases: Array<{ label: string; lock: RunLock; workspace: string; runId: string }> = [
      { label: "released", lock: released, workspace, runId },
      { label: "cross-run", lock: crossRun, workspace, runId },
      { label: "cross-workspace", lock: crossWorkspace, workspace, runId }
    ];
    for (const candidate of cases) {
      const error = captureArchiveStoreError(() =>
        publishPreparedArchiveTransaction(
          candidate.lock,
          candidate.workspace,
          candidate.runId,
          bytes
        )
      );
      assert.equal(error.message, "", candidate.label);
    }
  } finally {
    crossRun.release();
    crossWorkspace.release();
  }

  assert.equal(existsSync(recordPath), false);
  assert.deepEqual(
    readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-")),
    []
  );
});

test("contains a forged run-lock rejection before archive staging", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runDirectory = prepareRun(workspace);
  const recordPath = join(runDirectory, "archive-transaction.json");
  const bytes = Buffer.from(`${JSON.stringify(archiveTransaction(workspace))}\n`);
  const forged = Object.freeze({}) as RunLock;

  const error = captureArchiveStoreError(() =>
    publishPreparedArchiveTransaction(forged, workspace, runId, bytes)
  );

  assert.equal(error.message, "");
  assert.equal(existsSync(recordPath), false);
  assert.deepEqual(
    readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-")),
    []
  );
});

test("contains invalid prepared transaction bytes before archive staging", (t) => {
  const cases = [
    {
      label: "malformed",
      bytes: Buffer.from('{"private":"raw transaction text"')
    },
    {
      label: "foreign",
      bytes: (workspace: string) => Buffer.from(`${JSON.stringify({
        ...archiveTransaction(workspace),
        workspaceFingerprint: "0".repeat(64)
      })}\n`)
    },
    {
      label: "oversized",
      bytes: Buffer.alloc(65_537, 0x20)
    }
  ];

  for (const candidate of cases) {
    const workspace = createWorkspace();
    const runDirectory = prepareRun(workspace);
    const recordPath = join(runDirectory, "archive-transaction.json");
    const lock = acquireRunLock(workspace, runId);
    const bytes = typeof candidate.bytes === "function"
      ? candidate.bytes(workspace)
      : candidate.bytes;
    try {
      const error = captureArchiveStoreError(() =>
        publishPreparedArchiveTransaction(lock, workspace, runId, bytes)
      );
      assert.equal(error.message, "", candidate.label);
      assert.doesNotMatch(error.message, /raw transaction text/, candidate.label);
      assert.equal(existsSync(recordPath), false, candidate.label);
      assert.deepEqual(
        readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-")),
        [],
        candidate.label
      );
    } finally {
      lock.release();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("rejects a non-prepared first archive transaction without residue", (t) => {
  const workspace = createWorkspace();
  const runDirectory = prepareRun(workspace);
  const recordPath = join(runDirectory, "archive-transaction.json");
  const runRecordPath = join(runDirectory, "run.json");
  const runRecordBytes = readFileSync(runRecordPath);
  const bytes = Buffer.from(`${JSON.stringify({
    ...archiveTransaction(workspace),
    state: "assets_staged"
  })}\n`);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    lock.release();
    rmSync(workspace, { recursive: true, force: true });
  });

  const error = captureArchiveStoreError(() =>
    publishPreparedArchiveTransaction(lock, workspace, runId, bytes)
  );

  assert.equal(error.message, "");
  assert.equal(existsSync(recordPath), false);
  assert.deepEqual(readFileSync(runRecordPath), runRecordBytes);
  assert.deepEqual(
    readdirSync(runDirectory).filter((name) => name.startsWith("@tmp-")),
    []
  );
});

test("inspectArchiveTransaction returns undefined only for a stable absent leaf under an admitted run", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runDirectory = prepareRun(workspace);
  const transactionPath = join(runDirectory, "archive-transaction.json");
  const before = readdirSync(runDirectory).sort();

  assert.equal(inspectArchiveTransaction(workspace, runId), undefined);
  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual(readdirSync(runDirectory).sort(), before);
});

test("inspectArchiveTransaction requires a valid workspace record even when a run record is valid", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const { runDirectory, recordPath, bytes } = writeRunWithoutWorkspaceRecord(workspace);

  const error = captureArchiveStoreError(() => inspectArchiveTransaction(workspace, runId));

  assert.equal(error.message, "");
  assert.equal(existsSync(join(workspace, ".cu", "workspace.json")), false);
  assert.equal(readFileSync(recordPath, "utf8"), bytes);
  assert.deepEqual(readdirSync(runDirectory), ["run.json"]);
});

test("inspectArchiveTransaction returns one normalized transaction bound to the admitted run", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runDirectory = prepareRun(workspace);
  const { path, bytes } = writeArchiveTransaction(workspace, archiveTransaction(workspace));

  const transaction = inspectArchiveTransaction(workspace, runId);

  if (transaction === undefined) {
    assert.fail("expected admitted archive transaction");
  }
  assert.equal(transaction.operation, "publish");
  assert.equal(transaction.transactionId, "txn_0123456789abcdef0123456789abcdef");
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.deepEqual(readdirSync(runDirectory).sort(), ["archive-transaction.json", "run.json"]);
});

test("inspectArchiveTransactionWithWitness returns the descriptor witness for the admitted transaction", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const { path } = writeArchiveTransaction(workspace, archiveTransaction(workspace));

  const admitted = inspectArchiveTransactionWithWitness(workspace, runId);

  if (admitted === undefined) {
    assert.fail("expected witnessed archive transaction");
  }
  assert.equal(admitted.transaction.transactionId, "txn_0123456789abcdef0123456789abcdef");
  const canonicalWorkspace = realpathSync.native(workspace);
  assert.equal(admitted.recordPath, realpathSync.native(path));
  assert.deepEqual(admitted.ancestors, [
    join(canonicalWorkspace, ".cu"),
    join(canonicalWorkspace, ".cu", runId)
  ]);
  assert.doesNotThrow(() =>
    revalidateStableRegularFileWitness(
      admitted.recordPath,
      admitted.ancestors,
      admitted.witness
    )
  );
});

test("witnessed archive admission rejects a byte-identical replacement leaf", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareRun(workspace);
  const { path, bytes } = writeArchiveTransaction(workspace, archiveTransaction(workspace));
  const admitted = inspectArchiveTransactionWithWitness(workspace, runId);
  if (admitted === undefined) {
    assert.fail("expected witnessed archive transaction");
  }

  rmSync(path);
  writeFileSync(path, bytes, "utf8");

  assert.throws(
    () => revalidateStableRegularFileWitness(
      admitted.recordPath,
      admitted.ancestors,
      admitted.witness
    ),
    RegularFileError
  );
  assert.equal(readFileSync(path, "utf8"), bytes);
});

test("inspectArchiveTransaction rejects an absent run instead of representing it as an absent transaction", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  const stateDirectory = join(workspace, ".cu");
  const before = readdirSync(stateDirectory).sort();

  const error = captureArchiveStoreError(() => inspectArchiveTransaction(workspace, runId));

  assert.equal(error.message, "");
  assert.deepEqual(readdirSync(stateDirectory).sort(), before);
  assert.equal(existsSync(join(stateDirectory, runId)), false);
});

test("inspectArchiveTransaction rejects an invalid run ID before it creates workspace state", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const error = captureArchiveStoreError(() => inspectArchiveTransaction(workspace, "../escape"));

  assert.equal(error.message, "");
  assert.equal(existsSync(join(workspace, ".cu")), false);
});

test("inspectArchiveTransaction contains malformed and foreign candidate records without disclosure or repair", (t) => {
  const cases = [
    {
      label: "malformed",
      write(workspace: string) {
        const path = join(workspace, ".cu", runId, "archive-transaction.json");
        const bytes = '{"rawTypedText":"private keyboard input"';
        writeFileSync(path, bytes, "utf8");
        return { path, bytes };
      }
    },
    {
      label: "foreign binding",
      write(workspace: string) {
        return writeArchiveTransaction(workspace, {
          ...archiveTransaction(workspace),
          workspaceFingerprint: "0".repeat(64)
        });
      }
    }
  ];

  for (const candidate of cases) {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    prepareRun(workspace);
    const { path, bytes } = candidate.write(workspace);

    const error = captureArchiveStoreError(() => inspectArchiveTransaction(workspace, runId));

    assert.equal(error.message, "", candidate.label);
    assert.doesNotMatch(error.message, /private keyboard input/, candidate.label);
    assert.equal(readFileSync(path, "utf8"), bytes, candidate.label);
  }
});

test("inspectArchiveTransaction rejects oversized and nonregular transaction leaves without repair", (t) => {
  const oversizedWorkspace = createWorkspace();
  t.after(() => rmSync(oversizedWorkspace, { recursive: true, force: true }));
  prepareRun(oversizedWorkspace);
  const oversizedPath = join(oversizedWorkspace, ".cu", runId, "archive-transaction.json");
  const oversizedBytes = `${JSON.stringify(archiveTransaction(oversizedWorkspace))}${" ".repeat(65_536)}`;
  assert.ok(Buffer.byteLength(oversizedBytes, "utf8") > 65_536);
  writeFileSync(oversizedPath, oversizedBytes, "utf8");

  const oversizedError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(oversizedWorkspace, runId)
  );

  assert.equal(oversizedError.message, "");
  assert.equal(readFileSync(oversizedPath, "utf8"), oversizedBytes);

  const nonregularWorkspace = createWorkspace();
  t.after(() => rmSync(nonregularWorkspace, { recursive: true, force: true }));
  const runDirectory = prepareRun(nonregularWorkspace);
  const nonregularPath = join(runDirectory, "archive-transaction.json");
  mkdirSync(nonregularPath);

  const nonregularError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(nonregularWorkspace, runId)
  );

  assert.equal(nonregularError.message, "");
  assert.deepEqual(readdirSync(nonregularPath), []);
});

test("inspectArchiveTransaction rejects workspace and run junctions without following them", (t) => {
  const runJunctionWorkspace = createWorkspace();
  const runJunctionOutside = createWorkspace();
  t.after(() => rmSync(runJunctionWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(runJunctionOutside, { recursive: true, force: true }));
  const runDirectory = prepareRun(runJunctionWorkspace);
  rmSync(runDirectory, { recursive: true, force: true });
  symlinkSync(runJunctionOutside, runDirectory, "junction");

  const runJunctionError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(runJunctionWorkspace, runId)
  );

  assert.equal(runJunctionError.message, "");
  assert.deepEqual(readdirSync(runJunctionOutside), []);

  const stateJunctionWorkspace = createWorkspace();
  const stateJunctionOutside = createWorkspace();
  t.after(() => rmSync(stateJunctionWorkspace, { recursive: true, force: true }));
  t.after(() => rmSync(stateJunctionOutside, { recursive: true, force: true }));
  initializeWorkspace(stateJunctionWorkspace);
  const stateDirectory = join(stateJunctionWorkspace, ".cu");
  rmSync(stateDirectory, { recursive: true, force: true });
  symlinkSync(stateJunctionOutside, stateDirectory, "junction");

  const stateJunctionError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(stateJunctionWorkspace, runId)
  );

  assert.equal(stateJunctionError.message, "");
  assert.deepEqual(readdirSync(stateJunctionOutside), []);
});

test("inspectArchiveTransaction rejects uninitialized and malformed workspace state without repair", (t) => {
  const uninitializedWorkspace = createWorkspace();
  t.after(() => rmSync(uninitializedWorkspace, { recursive: true, force: true }));

  const uninitializedError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(uninitializedWorkspace, runId)
  );

  assert.equal(uninitializedError.message, "");
  assert.equal(existsSync(join(uninitializedWorkspace, ".cu")), false);

  const malformedWorkspace = createWorkspace();
  t.after(() => rmSync(malformedWorkspace, { recursive: true, force: true }));
  prepareRun(malformedWorkspace);
  const workspaceRecordPath = join(malformedWorkspace, ".cu", "workspace.json");
  const malformedBytes = "{malformed workspace";
  writeFileSync(workspaceRecordPath, malformedBytes, "utf8");

  const malformedError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(malformedWorkspace, runId)
  );

  assert.equal(malformedError.message, "");
  assert.equal(readFileSync(workspaceRecordPath, "utf8"), malformedBytes);
});

test("inspectArchiveTransaction rejects incomplete and malformed run state without repair", (t) => {
  const incompleteWorkspace = createWorkspace();
  t.after(() => rmSync(incompleteWorkspace, { recursive: true, force: true }));
  initializeWorkspace(incompleteWorkspace);
  const incompleteRunDirectory = join(incompleteWorkspace, ".cu", runId);
  mkdirSync(incompleteRunDirectory);

  const incompleteError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(incompleteWorkspace, runId)
  );

  assert.equal(incompleteError.message, "");
  assert.deepEqual(readdirSync(incompleteRunDirectory), []);

  const malformedWorkspace = createWorkspace();
  t.after(() => rmSync(malformedWorkspace, { recursive: true, force: true }));
  const malformedRunDirectory = prepareRun(malformedWorkspace);
  const runRecordPath = join(malformedRunDirectory, "run.json");
  const malformedBytes = "{malformed run";
  writeFileSync(runRecordPath, malformedBytes, "utf8");

  const malformedError = captureArchiveStoreError(() =>
    inspectArchiveTransaction(malformedWorkspace, runId)
  );

  assert.equal(malformedError.message, "");
  assert.equal(readFileSync(runRecordPath, "utf8"), malformedBytes);
});
