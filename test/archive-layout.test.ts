import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ArchiveLayoutError,
  prepareArchiveTransactionLayout,
  revalidateArchiveTransactionLayout,
  type ArchiveTransactionLayout
} from "../src/archive-layout.js";
import { publishPreparedArchiveTransaction } from "../src/archive-store.js";
import { ensureRun } from "../src/run.js";
import { acquireRunLock, type RunLock } from "../src/run-lock.js";
import { initializeWorkspace, workspaceFingerprint } from "../src/workspace.js";

const runId = "work-a";
const transactionId = "txn_0123456789abcdef0123456789abcdef";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "cu-archive-layout-"));
}

function preparedTransactionBytes(workspace: string): Buffer {
  const bundle = {
    observationId: "obs_0123456789abcdef0123456789abcdef",
    captureMetadataSha256: "b".repeat(64),
    imageSha256: "c".repeat(64),
    imageByteLength: 12345
  };
  return Buffer.from(`${JSON.stringify({
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: workspaceFingerprint(workspace),
    transactionId,
    operation: "publish",
    state: "prepared",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    priorLive: null,
    movedBundles: [],
    historyEvents: [],
    payload: {
      newBundle: bundle,
      newLiveRecordSha256: "d".repeat(64),
      replacesObservationId: null,
      resolvesEffect: null
    }
  })}\n`);
}

function captureArchiveLayoutError(operation: () => unknown): ArchiveLayoutError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ArchiveLayoutError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected ArchiveLayoutError");
}

function runLockLossDuringLayoutCreation(
  workspace: string,
  phase: "archive" | "transaction" | "staging"
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const archiveDirectory = resolve(join(workspace, ".cu", "work-a", "@archive"));
    const transactionDirectory = resolve(join(archiveDirectory, ${JSON.stringify(transactionId)}));
    const triggerDirectory = {
      archive: archiveDirectory,
      transaction: transactionDirectory,
      staging: resolve(join(transactionDirectory, "staging"))
    }[process.env.CU_TEST_PHASE];
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalMkdir = fs.mkdirSync.bind(fs);
    let injected = false;
    fs.mkdirSync = (path, ...args) => {
      const result = originalMkdir(path, ...args);
      if (!injected && resolve(String(path)).toLowerCase() === triggerDirectory.toLowerCase()) {
        fs.writeFileSync(ownerPath, "{}\\n");
        injected = true;
      }
      return result;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    const entries = fs.existsSync(archiveDirectory) ? fs.readdirSync(archiveDirectory) : [];
    const transactionEntries = fs.existsSync(transactionDirectory)
      ? fs.readdirSync(transactionDirectory)
      : [];
    process.stdout.write(JSON.stringify({
      injected,
      rejected,
      message,
      entries,
      transactionEntries
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_PHASE: phase
    },
    encoding: "utf8"
  });
}

function runLockLossBeforeFirstLayoutWrite(
  workspace: string
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const archiveDirectory = resolve(join(workspace, ".cu", "work-a", "@archive"));
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalLstat = fs.lstatSync.bind(fs);
    let ownerLstats = 0;
    let injected = false;
    fs.lstatSync = (path, ...args) => {
      const status = originalLstat(path, ...args);
      if (resolve(String(path)).toLowerCase() === ownerPath.toLowerCase()) {
        ownerLstats += 1;
        if (!injected && ownerLstats === 3) {
          fs.writeFileSync(ownerPath, "{}\\n");
          injected = true;
        }
      }
      return status;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    process.stdout.write(JSON.stringify({
      injected,
      ownerLstats,
      rejected,
      message,
      archiveExists: fs.existsSync(archiveDirectory)
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: { ...process.env, CU_TEST_WORKSPACE: workspace },
    encoding: "utf8"
  });
}

function runParentReplacementDuringLayoutCreation(
  workspace: string,
  phase: "archive" | "transaction-before-staging" | "transaction-before-trash"
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const archiveDirectory = resolve(join(workspace, ".cu", "work-a", "@archive"));
    const transactionDirectory = resolve(join(archiveDirectory, ${JSON.stringify(transactionId)}));
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const phase = process.env.CU_TEST_PHASE;
    const triggerClose = {
      archive: 4,
      "transaction-before-staging": 5,
      "transaction-before-trash": 6
    }[phase];
    const target = phase === "archive" ? archiveDirectory : transactionDirectory;
    const displaced = target + ".displaced";
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    let ownerCloses = 0;
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
      if (path?.toLowerCase() === ownerPath.toLowerCase()) {
        ownerCloses += 1;
        if (!injected && ownerCloses === triggerClose) {
          fs.renameSync(target, displaced);
          fs.mkdirSync(target);
          injected = true;
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    const replacementEntries = fs.existsSync(target) ? fs.readdirSync(target) : [];
    const displacedEntries = fs.existsSync(displaced) ? fs.readdirSync(displaced) : [];
    process.stdout.write(JSON.stringify({
      injected,
      ownerCloses,
      rejected,
      message,
      replacementEntries,
      displacedEntries
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_PHASE: phase
    },
    encoding: "utf8"
  });
}

function runInitialTransactionReplacementDuringLayout(
  workspace: string
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = resolve(join(workspace, ".cu", "work-a"));
    const recordPath = resolve(join(runDirectory, "archive-transaction.json"));
    const displaced = recordPath + ".displaced";
    const archiveDirectory = resolve(join(runDirectory, "@archive"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    const originalLstat = fs.lstatSync.bind(fs);
    let recordCloses = 0;
    let armed = false;
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
      if (path?.toLowerCase() === recordPath.toLowerCase()) {
        recordCloses += 1;
        if (recordCloses === 1) armed = true;
      }
      return result;
    };
    fs.lstatSync = (path, ...args) => {
      const status = originalLstat(path, ...args);
      if (
        armed &&
        !injected &&
        resolve(String(path)).toLowerCase() === runDirectory.toLowerCase()
      ) {
        fs.renameSync(recordPath, displaced);
        fs.writeFileSync(recordPath, fs.readFileSync(displaced));
        armed = false;
        injected = true;
      }
      return status;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    const current = fs.lstatSync(recordPath, { bigint: true });
    const prior = fs.lstatSync(displaced, { bigint: true });
    process.stdout.write(JSON.stringify({
      injected,
      recordCloses,
      rejected,
      message,
      sameIdentity: current.ino === prior.ino && current.birthtimeNs === prior.birthtimeNs,
      sameBytes: fs.readFileSync(recordPath).equals(fs.readFileSync(displaced)),
      archiveExists: fs.existsSync(archiveDirectory)
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: { ...process.env, CU_TEST_WORKSPACE: workspace },
    encoding: "utf8"
  });
}

function runTransactionReplacementAfterPreflight(
  workspace: string,
  mode: "empty" | "unknown"
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const transactionDirectory = resolve(join(
      workspace,
      ".cu",
      "work-a",
      "@archive",
      ${JSON.stringify(transactionId)}
    ));
    const displaced = transactionDirectory + ".displaced";
    const mode = process.env.CU_TEST_MODE;
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalReaddir = fs.readdirSync.bind(fs);
    let injected = false;
    fs.readdirSync = (path, ...args) => {
      const entries = originalReaddir(path, ...args);
      if (
        !injected &&
        resolve(String(path)).toLowerCase() === transactionDirectory.toLowerCase()
      ) {
        fs.renameSync(transactionDirectory, displaced);
        fs.mkdirSync(transactionDirectory);
        if (mode === "unknown") {
          fs.writeFileSync(join(transactionDirectory, "unexpected"), "foreign");
        }
        injected = true;
      }
      return entries;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    process.stdout.write(JSON.stringify({
      injected,
      rejected,
      message,
      replacementEntries: fs.readdirSync(transactionDirectory),
      displacedEntries: fs.readdirSync(displaced)
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_MODE: mode
    },
    encoding: "utf8"
  });
}

function runTerminalLayoutDrift(
  workspace: string,
  operation: "prepare" | "revalidate",
  drift: "namespace" | "staging"
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const runDirectory = resolve(join(workspace, ".cu", "work-a"));
    const recordPath = resolve(join(runDirectory, "archive-transaction.json"));
    const transactionDirectory = resolve(join(
      runDirectory,
      "@archive",
      ${JSON.stringify(transactionId)}
    ));
    const stagingDirectory = resolve(join(transactionDirectory, "staging"));
    const displaced = stagingDirectory + ".displaced";
    const operation = process.env.CU_TEST_OPERATION;
    const drift = process.env.CU_TEST_DRIFT;
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    let recordCloses = 0;
    let armed = operation === "prepare";
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
      if (path?.toLowerCase() === recordPath.toLowerCase()) {
        recordCloses += 1;
        const trigger = operation === "prepare" ? 5 : 2;
        if (armed && !injected && recordCloses === trigger) {
          if (drift === "namespace") {
            fs.writeFileSync(join(transactionDirectory, "unexpected"), "foreign");
          } else {
            fs.renameSync(stagingDirectory, displaced);
            fs.mkdirSync(stagingDirectory);
            fs.writeFileSync(join(stagingDirectory, "replacement"), "replacement");
          }
          injected = true;
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const {
      ArchiveLayoutError,
      prepareArchiveTransactionLayout,
      revalidateArchiveTransactionLayout
    } = await import(${JSON.stringify(archiveLayoutUrl)});
    let layout;
    let rejected = false;
    let message = null;
    try {
      layout = prepareArchiveTransactionLayout(lock, workspace, "work-a");
      if (operation === "revalidate") {
        recordCloses = 0;
        armed = true;
        revalidateArchiveTransactionLayout(layout, lock, workspace, "work-a");
      }
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    process.stdout.write(JSON.stringify({
      injected,
      recordCloses,
      rejected,
      message,
      transactionEntries: fs.readdirSync(transactionDirectory),
      replacementEvidence: fs.existsSync(join(stagingDirectory, "replacement")),
      displacedExists: fs.existsSync(displaced)
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_OPERATION: operation,
      CU_TEST_DRIFT: drift
    },
    encoding: "utf8"
  });
}

function runNamespaceDriftBeforeChildCreation(
  workspace: string,
  phase: "archive" | "transaction-before-staging" | "transaction-before-trash"
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const archiveDirectory = resolve(join(workspace, ".cu", "work-a", "@archive"));
    const transactionDirectory = resolve(join(archiveDirectory, ${JSON.stringify(transactionId)}));
    const ownerPath = resolve(join(workspace, ".cu", "@locks", "work-a", "owner.json"));
    const phase = process.env.CU_TEST_PHASE;
    const triggerClose = {
      archive: 4,
      "transaction-before-staging": 5,
      "transaction-before-trash": 6
    }[phase];
    const target = phase === "archive" ? archiveDirectory : transactionDirectory;
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalOpen = fs.openSync.bind(fs);
    const originalClose = fs.closeSync.bind(fs);
    const descriptors = new Map();
    let ownerCloses = 0;
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
      if (path?.toLowerCase() === ownerPath.toLowerCase()) {
        ownerCloses += 1;
        if (!injected && ownerCloses === triggerClose) {
          fs.writeFileSync(join(target, "unexpected"), "foreign");
          injected = true;
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    process.stdout.write(JSON.stringify({
      injected,
      ownerCloses,
      rejected,
      message,
      archiveEntries: fs.readdirSync(archiveDirectory),
      transactionEntries: fs.existsSync(transactionDirectory)
        ? fs.readdirSync(transactionDirectory)
        : []
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CU_TEST_WORKSPACE: workspace,
      CU_TEST_PHASE: phase
    },
    encoding: "utf8"
  });
}

function runArchivePreflightCanonicalizationUncertainty(
  workspace: string
): ReturnType<typeof spawnSync> {
  const archiveLayoutUrl = pathToFileURL(
    join(repositoryRoot, "dist", "src", "archive-layout.js")
  ).href;
  const runLockUrl = pathToFileURL(join(repositoryRoot, "dist", "src", "run-lock.js")).href;
  const program = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve } from "node:path";
    const workspace = fs.realpathSync.native(process.env.CU_TEST_WORKSPACE);
    const archiveDirectory = resolve(join(workspace, ".cu", "work-a", "@archive"));
    const { acquireRunLock } = await import(${JSON.stringify(runLockUrl)});
    const lock = acquireRunLock(workspace, "work-a");
    const originalRealpath = fs.realpathSync.bind(fs);
    const originalNative = fs.realpathSync.native.bind(fs.realpathSync);
    let injected = false;
    const replacementRealpath = (path, ...args) => originalRealpath(path, ...args);
    replacementRealpath.native = (path, ...args) => {
      if (!injected && resolve(String(path)).toLowerCase() === archiveDirectory.toLowerCase()) {
        injected = true;
        const error = new Error("injected canonicalization uncertainty");
        error.code = "ENOENT";
        throw error;
      }
      return originalNative(path, ...args);
    };
    fs.realpathSync = replacementRealpath;
    syncBuiltinESMExports();
    const { ArchiveLayoutError, prepareArchiveTransactionLayout } = await import(
      ${JSON.stringify(archiveLayoutUrl)}
    );
    let rejected = false;
    let message = null;
    try {
      prepareArchiveTransactionLayout(lock, workspace, "work-a");
    } catch (error) {
      rejected = error instanceof ArchiveLayoutError;
      message = error instanceof Error ? error.message : null;
    }
    process.stdout.write(JSON.stringify({
      injected,
      rejected,
      message,
      entries: fs.readdirSync(archiveDirectory)
    }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: repositoryRoot,
    env: { ...process.env, CU_TEST_WORKSPACE: workspace },
    encoding: "utf8"
  });
}

function assertDirectDirectory(path: string): void {
  const status = lstatSync(path);
  assert.equal(status.isDirectory(), true);
  assert.equal(status.isSymbolicLink(), false);
  assert.equal(realpathSync.native(path).toLowerCase(), path.toLowerCase());
}

test("requires an exact active lock and prepared transaction before namespace creation", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
  const archiveDirectory = join(runDirectory, "@archive");
  const forged = Object.freeze({}) as RunLock;

  const forgedError = captureArchiveLayoutError(() =>
    prepareArchiveTransactionLayout(forged, workspace, runId)
  );
  assert.equal(forgedError.message, "");
  assert.equal(existsSync(archiveDirectory), false);

  const lock = acquireRunLock(workspace, runId);
  const missingError = captureArchiveLayoutError(() =>
    prepareArchiveTransactionLayout(lock, workspace, runId)
  );
  assert.equal(missingError.message, "");
  assert.equal(existsSync(archiveDirectory), false);

  const nonPrepared = JSON.parse(
    preparedTransactionBytes(workspace).toString("utf8")
  ) as Record<string, unknown>;
  nonPrepared.state = "assets_staged";
  nonPrepared.updatedAt = "2026-07-24T00:00:01.000Z";
  writeFileSync(
    join(runDirectory, "archive-transaction.json"),
    `${JSON.stringify(nonPrepared)}\n`
  );
  const stateError = captureArchiveLayoutError(() =>
    prepareArchiveTransactionLayout(lock, workspace, runId)
  );
  assert.equal(stateError.message, "");
  assert.equal(existsSync(archiveDirectory), false);
  lock.release();
});

for (const junction of ["archive", "transaction", "staging", "trash"] as const) {
  test(`rejects a ${junction} directory junction without following it`, (t) => {
    const workspace = createWorkspace();
    const outside = createWorkspace();
    t.after(() => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    const archiveDirectory = join(runDirectory, "@archive");
    const transactionDirectory = join(archiveDirectory, transactionId);
    const target =
      junction === "archive"
        ? archiveDirectory
        : junction === "transaction"
          ? transactionDirectory
          : join(transactionDirectory, junction);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target, "junction");

    const error = captureArchiveLayoutError(() =>
      prepareArchiveTransactionLayout(lock, workspace, runId)
    );

    assert.equal(error.message, "");
    assert.deepEqual(readdirSync(outside), []);
    if (junction === "staging") {
      assert.equal(existsSync(join(transactionDirectory, "trash")), false);
    }
    if (junction === "trash") {
      assert.equal(existsSync(join(transactionDirectory, "staging")), false);
    }
    lock.release();
  });
}

test("retains the initial transaction witness across layout preparation", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  lock.release();

  const result = runInitialTransactionReplacementDuringLayout(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    injected: boolean;
    recordCloses: number;
    rejected: boolean;
    message: string | null;
    sameIdentity: boolean;
    sameBytes: boolean;
    archiveExists: boolean;
  };
  assert.equal(output.injected, true, JSON.stringify(output));
  assert.equal(output.sameIdentity, false, JSON.stringify(output));
  assert.equal(output.sameBytes, true, JSON.stringify(output));
  assert.equal(output.rejected, true, JSON.stringify(output));
  assert.equal(output.message, "");
  assert.equal(output.archiveExists, false, JSON.stringify(output));
});

test("does not downgrade existing archive canonicalization uncertainty to absence", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  lock.release();
  const archiveDirectory = join(
    realpathSync.native(join(workspace, ".cu", runId)),
    "@archive"
  );
  mkdirSync(archiveDirectory);

  const result = runArchivePreflightCanonicalizationUncertainty(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    injected: boolean;
    rejected: boolean;
    message: string | null;
    entries: string[];
  };
  assert.equal(output.injected, true, JSON.stringify(output));
  assert.equal(output.rejected, true, JSON.stringify(output));
  assert.equal(output.message, "");
  assert.deepEqual(output.entries, []);
});

test("rejects an unknown archive namespace without creating the active transaction layout", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const archiveDirectory = join(runDirectory, "@archive");
  mkdirSync(join(archiveDirectory, "txn_f123456789abcdef0123456789abcdef"), {
    recursive: true
  });
  const before = readdirSync(archiveDirectory);

  const error = captureArchiveLayoutError(() =>
    prepareArchiveTransactionLayout(lock, workspace, runId)
  );

  assert.equal(error.message, "");
  assert.deepEqual(readdirSync(archiveDirectory), before);
  assert.equal(existsSync(join(archiveDirectory, transactionId)), false);
});

for (const mode of ["empty", "unknown"] as const) {
  test(`retains the preflight transaction identity across a ${mode} replacement`, (t) => {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    lock.release();
    const transactionDirectory = join(
      realpathSync.native(join(workspace, ".cu", runId)),
      "@archive",
      transactionId
    );
    mkdirSync(transactionDirectory, { recursive: true });

    const result = runTransactionReplacementAfterPreflight(workspace, mode);

    assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
    const output = JSON.parse(String(result.stdout)) as {
      injected: boolean;
      rejected: boolean;
      message: string | null;
      replacementEntries: string[];
      displacedEntries: string[];
    };
    assert.equal(output.injected, true, JSON.stringify(output));
    assert.equal(output.rejected, true, JSON.stringify(output));
    assert.equal(output.message, "");
    assert.deepEqual(
      output.replacementEntries,
      mode === "unknown" ? ["unexpected"] : []
    );
    assert.deepEqual(output.displacedEntries, []);
  });
}

test("rejects unknown transaction-private entries before completing a partial layout", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const transactionDirectory = join(runDirectory, "@archive", transactionId);
  mkdirSync(join(transactionDirectory, "unexpected"), { recursive: true });
  const before = readdirSync(transactionDirectory);

  const error = captureArchiveLayoutError(() =>
    prepareArchiveTransactionLayout(lock, workspace, runId)
  );

  assert.equal(error.message, "");
  assert.deepEqual(readdirSync(transactionDirectory), before);
  assert.equal(existsSync(join(transactionDirectory, "staging")), false);
  assert.equal(existsSync(join(transactionDirectory, "trash")), false);
});

for (const occupied of ["staging", "trash"] as const) {
  test(`preserves nonempty ${occupied} evidence without completing its sibling`, (t) => {
    const workspace = createWorkspace();
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
    const lock = acquireRunLock(workspace, runId);
    t.after(() => {
      try {
        lock.release();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    const transactionDirectory = join(runDirectory, "@archive", transactionId);
    const occupiedDirectory = join(transactionDirectory, occupied);
    const sibling = occupied === "staging" ? "trash" : "staging";
    mkdirSync(occupiedDirectory, { recursive: true });
    const evidencePath = join(occupiedDirectory, "evidence.bin");
    writeFileSync(evidencePath, "partial evidence");

    const error = captureArchiveLayoutError(() =>
      prepareArchiveTransactionLayout(lock, workspace, runId)
    );

    assert.equal(error.message, "");
    assert.deepEqual(readdirSync(transactionDirectory), [occupied]);
    assert.equal(readFileSync(evidencePath, "utf8"), "partial evidence");
    assert.equal(existsSync(join(transactionDirectory, sibling)), false);
  });
}

test("does not create the archive namespace after initial lock authority is lost", (t) => {
  const workspace = createWorkspace();
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  lock.release();

  const result = runLockLossBeforeFirstLayoutWrite(workspace);

  assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
  const output = JSON.parse(String(result.stdout)) as {
    injected: boolean;
    ownerLstats: number;
    rejected: boolean;
    message: string | null;
    archiveExists: boolean;
  };
  assert.equal(output.injected, true, JSON.stringify(output));
  assert.equal(output.rejected, true, JSON.stringify(output));
  assert.equal(output.message, "");
  assert.equal(output.archiveExists, false, JSON.stringify(output));
});

for (const scenario of [
  {
    phase: "archive",
    archiveEntries: [] as string[],
    transactionEntries: [] as string[]
  },
  {
    phase: "transaction",
    archiveEntries: [transactionId],
    transactionEntries: [] as string[]
  },
  {
    phase: "staging",
    archiveEntries: [transactionId],
    transactionEntries: ["staging"]
  }
] as const) {
  test(`stops layout creation when the run lock is lost after ${scenario.phase}`, (t) => {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    lock.release();

    const result = runLockLossDuringLayoutCreation(workspace, scenario.phase);

    assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
    const output = JSON.parse(String(result.stdout)) as {
      injected: boolean;
      rejected: boolean;
      message: string | null;
      entries: string[];
      transactionEntries: string[];
    };
    assert.equal(output.injected, true);
    assert.equal(output.rejected, true);
    assert.equal(output.message, "");
    assert.deepEqual(output.entries, scenario.archiveEntries);
    assert.deepEqual(output.transactionEntries, scenario.transactionEntries);
  });
}

for (const scenario of [
  {
    phase: "archive",
    archiveEntries: ["unexpected"],
    transactionEntries: [] as string[]
  },
  {
    phase: "transaction-before-staging",
    archiveEntries: [transactionId],
    transactionEntries: ["unexpected"]
  },
  {
    phase: "transaction-before-trash",
    archiveEntries: [transactionId],
    transactionEntries: ["staging", "unexpected"]
  }
] as const) {
  test(`does not complete a child after ${scenario.phase} namespace drift`, (t) => {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    lock.release();

    const result = runNamespaceDriftBeforeChildCreation(workspace, scenario.phase);

    assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
    const output = JSON.parse(String(result.stdout)) as {
      injected: boolean;
      ownerCloses: number;
      rejected: boolean;
      message: string | null;
      archiveEntries: string[];
      transactionEntries: string[];
    };
    assert.equal(output.injected, true, JSON.stringify(output));
    assert.equal(output.rejected, true, JSON.stringify(output));
    assert.equal(output.message, "");
    assert.deepEqual(output.archiveEntries.sort(), [...scenario.archiveEntries].sort());
    assert.deepEqual(
      output.transactionEntries.sort(),
      [...scenario.transactionEntries].sort()
    );
  });
}

for (const scenario of [
  { phase: "archive", displacedEntries: [] as string[] },
  { phase: "transaction-before-staging", displacedEntries: [] as string[] },
  { phase: "transaction-before-trash", displacedEntries: ["staging"] }
] as const) {
  test(`does not create a child under a replaced ${scenario.phase} parent`, (t) => {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    lock.release();

    const result = runParentReplacementDuringLayoutCreation(workspace, scenario.phase);

    assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
    const output = JSON.parse(String(result.stdout)) as {
      injected: boolean;
      ownerCloses: number;
      rejected: boolean;
      message: string | null;
      replacementEntries: string[];
      displacedEntries: string[];
    };
    assert.equal(output.injected, true, JSON.stringify(output));
    assert.equal(output.rejected, true);
    assert.equal(output.message, "");
    assert.deepEqual(output.replacementEntries, []);
    assert.deepEqual(output.displacedEntries.sort(), scenario.displacedEntries);
  });
}

test("idempotently completes an empty partial private layout", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const transactionDirectory = join(runDirectory, "@archive", transactionId);
  const stagingDirectory = join(transactionDirectory, "staging");
  mkdirSync(stagingDirectory, { recursive: true });
  const stagingBefore = lstatSync(stagingDirectory, { bigint: true });

  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);

  const stagingAfter = lstatSync(stagingDirectory, { bigint: true });
  assert.equal(stagingAfter.ino, stagingBefore.ino);
  assert.equal(stagingAfter.birthtimeNs, stagingBefore.birthtimeNs);
  assert.deepEqual(readdirSync(transactionDirectory).sort(), ["staging", "trash"]);
  assert.doesNotThrow(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );
});

test("rejects forged, released, and cross-workspace layout capabilities", (t) => {
  const workspace = createWorkspace();
  const otherWorkspace = createWorkspace();
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherWorkspace, { recursive: true, force: true });
  });
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  let lock = acquireRunLock(workspace, runId);
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);
  const forged = Object.freeze({}) as ArchiveTransactionLayout;
  const forgedError = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(forged, lock, workspace, runId)
  );
  assert.equal(forgedError.message, "");

  initializeWorkspace(otherWorkspace);
  ensureRun(otherWorkspace, runId);
  const otherLock = acquireRunLock(otherWorkspace, runId);
  const crossWorkspaceError = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(layout, otherLock, otherWorkspace, runId)
  );
  assert.equal(crossWorkspaceError.message, "");
  otherLock.release();

  lock.release();
  const releasedError = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );
  assert.equal(releasedError.message, "");
});

for (const scenario of [
  { operation: "prepare", drift: "namespace" },
  { operation: "revalidate", drift: "staging" }
] as const) {
  test(`terminally rejects ${scenario.drift} drift during ${scenario.operation}`, (t) => {
    const workspace = createWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initializeWorkspace(workspace);
    ensureRun(workspace, runId);
    const lock = acquireRunLock(workspace, runId);
    publishPreparedArchiveTransaction(
      lock,
      workspace,
      runId,
      preparedTransactionBytes(workspace)
    );
    lock.release();

    const result = runTerminalLayoutDrift(
      workspace,
      scenario.operation,
      scenario.drift
    );

    assert.equal(result.status, 0, `${String(result.stdout)} ${String(result.stderr)}`);
    const output = JSON.parse(String(result.stdout)) as {
      injected: boolean;
      recordCloses: number;
      rejected: boolean;
      message: string | null;
      transactionEntries: string[];
      replacementEvidence: boolean;
      displacedExists: boolean;
    };
    assert.equal(output.injected, true, JSON.stringify(output));
    assert.equal(output.rejected, true, JSON.stringify(output));
    assert.equal(output.message, "");
    if (scenario.drift === "namespace") {
      assert.deepEqual(output.transactionEntries.sort(), ["staging", "trash", "unexpected"]);
    } else {
      assert.equal(output.replacementEvidence, true);
      assert.equal(output.displacedExists, true);
    }
  });
}

test("rejects retained directory replacement without deleting replacement evidence", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);
  const stagingDirectory = join(
    realpathSync.native(join(workspace, ".cu", runId)),
    "@archive",
    transactionId,
    "staging"
  );
  const displaced = `${stagingDirectory}.displaced`;
  const before = lstatSync(stagingDirectory, { bigint: true });
  writeFileSync(join(stagingDirectory, "owned-evidence.bin"), "owned");
  renameSync(stagingDirectory, displaced);
  mkdirSync(stagingDirectory);
  writeFileSync(join(stagingDirectory, "replacement-evidence.bin"), "replacement");

  const error = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );

  const replacement = lstatSync(stagingDirectory, { bigint: true });
  assert.equal(error.message, "");
  assert.equal(
    before.ino === replacement.ino && before.birthtimeNs === replacement.birthtimeNs,
    false
  );
  assert.equal(readFileSync(join(displaced, "owned-evidence.bin"), "utf8"), "owned");
  assert.equal(
    readFileSync(join(stagingDirectory, "replacement-evidence.bin"), "utf8"),
    "replacement"
  );
});

test("rejects archive namespace drift without deleting the foreign entry", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);
  const archiveDirectory = join(
    realpathSync.native(join(workspace, ".cu", runId)),
    "@archive"
  );
  const foreign = "txn_f123456789abcdef0123456789abcdef";
  mkdirSync(join(archiveDirectory, foreign));

  const error = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );

  assert.equal(error.message, "");
  assert.equal(existsSync(join(archiveDirectory, foreign)), true);
});

test("retains layout authority across transaction-private content churn", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    preparedTransactionBytes(workspace)
  );
  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);
  const transactionDirectory = join(
    realpathSync.native(join(workspace, ".cu", runId)),
    "@archive",
    transactionId
  );
  writeFileSync(join(transactionDirectory, "staging", "candidate.bin"), "candidate");
  writeFileSync(join(transactionDirectory, "trash", "moved.bin"), "moved");

  assert.doesNotThrow(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );
});

test("rejects a byte-identical active transaction record replacement", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  const transactionBytes = preparedTransactionBytes(workspace);
  const published = publishPreparedArchiveTransaction(
    lock,
    workspace,
    runId,
    transactionBytes
  );
  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);
  const before = lstatSync(published.recordPath, { bigint: true });
  rmSync(published.recordPath);
  writeFileSync(published.recordPath, transactionBytes);
  const after = lstatSync(published.recordPath, { bigint: true });
  assert.equal(
    before.ino === after.ino && before.birthtimeNs === after.birthtimeNs,
    false
  );

  const error = captureArchiveLayoutError(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );

  assert.equal(error.message, "");
});

test("creates and revalidates one empty private layout for the active prepared transaction", (t) => {
  const workspace = createWorkspace();
  initializeWorkspace(workspace);
  ensureRun(workspace, runId);
  const runDirectory = realpathSync.native(join(workspace, ".cu", runId));
  const runBytes = readFileSync(join(runDirectory, "run.json"));
  const lock = acquireRunLock(workspace, runId);
  t.after(() => {
    try {
      lock.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  const transactionBytes = preparedTransactionBytes(workspace);
  publishPreparedArchiveTransaction(lock, workspace, runId, transactionBytes);

  const layout = prepareArchiveTransactionLayout(lock, workspace, runId);

  assert.equal(Object.isFrozen(layout), true);
  assert.doesNotThrow(() =>
    revalidateArchiveTransactionLayout(layout, lock, workspace, runId)
  );
  const archiveDirectory = join(runDirectory, "@archive");
  const transactionDirectory = join(archiveDirectory, transactionId);
  const stagingDirectory = join(transactionDirectory, "staging");
  const trashDirectory = join(transactionDirectory, "trash");
  for (const path of [archiveDirectory, transactionDirectory, stagingDirectory, trashDirectory]) {
    assertDirectDirectory(path);
  }
  assert.deepEqual(readdirSync(archiveDirectory), [transactionId]);
  assert.deepEqual(readdirSync(transactionDirectory).sort(), ["staging", "trash"]);
  assert.deepEqual(readdirSync(stagingDirectory), []);
  assert.deepEqual(readdirSync(trashDirectory), []);
  assert.deepEqual(readFileSync(join(runDirectory, "run.json")), runBytes);
  assert.deepEqual(
    readFileSync(join(runDirectory, "archive-transaction.json")),
    transactionBytes
  );
  assert.equal(existsSync(join(runDirectory, "live-observation.json")), false);
});
