import { lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type ControlRecordIdentity,
  writeCreateOnceRecordWithIdentity
} from "./control-write.js";
import { isRunId } from "./identifiers.js";
import { readStableRegularFile } from "./regular-file.js";
import {
  inspectWorkspace,
  workspaceFingerprint,
  WorkspaceRecordReadUncertainError
} from "./workspace.js";

export class RunLockBusyError extends Error {}

const runLockBrand = Symbol("run lock");

export type RunLock = {
  readonly [runLockBrand]: true;
  release(): void;
};

type ActiveRunLock = {
  root: string;
  runId: string;
  validate(): void;
};

const activeRunLocks = new WeakMap<RunLock, ActiveRunLock>();

type RunLockOwner = {
  kind: "cu.run-lock/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  ownerId: string;
  acquiredAt: string;
};

type PathSnapshot = {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  size: bigint;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

const ownerKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "ownerId",
  "acquiredAt"
];

function isMatchingOwner(
  value: unknown,
  runId: string,
  fingerprint: string,
  ownerId: string
): value is RunLockOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === ownerKeys.length &&
    ownerKeys.every((key) => Object.hasOwn(owner, key)) &&
    owner.kind === "cu.run-lock/v1" &&
    owner.schemaVersion === 1 &&
    owner.runId === runId &&
    owner.workspaceFingerprint === fingerprint &&
    owner.ownerId === ownerId &&
    typeof owner.acquiredAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(owner.acquiredAt) &&
    new Date(owner.acquiredAt).toISOString() === owner.acquiredAt
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  return normalize(left) === normalize(right);
}

function projectSnapshot(stat: BigIntStats): PathSnapshot {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink()
  };
}

function snapshotPath(path: string): PathSnapshot {
  return projectSnapshot(lstatSync(path, { bigint: true }));
}

function sameIdentity(
  left: Pick<ControlRecordIdentity, "dev" | "ino" | "birthtimeNs">,
  right: Pick<ControlRecordIdentity, "dev" | "ino" | "birthtimeNs">
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameSnapshot(left: PathSnapshot, right: PathSnapshot): boolean {
  return (
    sameIdentity(left, right) &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size &&
    left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function requireRegularDirectory(path: string): PathSnapshot {
  const snapshot = snapshotPath(path);
  if (
    !snapshot.isDirectory ||
    snapshot.isSymbolicLink ||
    !samePath(realpathSync.native(path), path)
  ) {
    throw new Error("run lock directory is invalid");
  }
  return snapshot;
}

function requireRegularFile(path: string): PathSnapshot {
  const snapshot = snapshotPath(path);
  if (!snapshot.isFile || snapshot.isSymbolicLink || !samePath(realpathSync.native(path), path)) {
    throw new Error("run lock owner is invalid");
  }
  return snapshot;
}

const workspaceAdmissionAttempts = 16;
const lockDirectoryCreationAttempts = 16;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function admitWorkspaceForRunLock(
  root: string,
  stateDirectory: string,
  rootIdentity: PathSnapshot,
  stateDirectoryIdentity: PathSnapshot
): void {
  for (let attempt = 0; attempt < workspaceAdmissionAttempts; attempt += 1) {
    try {
      if (!inspectWorkspace(root).initialized) {
        throw new Error("workspace is not initialized");
      }
      if (
        !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
        !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory))
      ) {
        throw new Error("run lock ownership is uncertain");
      }
      return;
    } catch (error) {
      if (
        !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
        !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory))
      ) {
        throw new Error("run lock ownership is uncertain");
      }
      if (error instanceof WorkspaceRecordReadUncertainError) {
        if (attempt + 1 === workspaceAdmissionAttempts) {
          throw new RunLockBusyError("run lock admission is busy");
        }
        continue;
      }
      throw error;
    }
  }
}

function createRunLockDirectory(
  root: string,
  stateDirectory: string,
  lockRoot: string,
  lockDirectory: string,
  rootIdentity: PathSnapshot,
  stateDirectoryIdentity: PathSnapshot,
  lockRootIdentity: PathSnapshot
): PathSnapshot {
  let lastPermissionError: unknown;
  for (let attempt = 0; attempt < lockDirectoryCreationAttempts; attempt += 1) {
    if (
      !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
      !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory)) ||
      !sameIdentity(lockRootIdentity, requireRegularDirectory(lockRoot))
    ) {
      throw new Error("run lock ownership is uncertain");
    }
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new RunLockBusyError("run lock is busy");
      }
      if (!isErrno(error, "EPERM")) {
        throw error;
      }
      if (
        !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
        !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory)) ||
        !sameIdentity(lockRootIdentity, requireRegularDirectory(lockRoot))
      ) {
        throw new Error("run lock ownership is uncertain");
      }

      let lockPathExists = true;
      try {
        lstatSync(lockDirectory);
      } catch (inspectionError) {
        if (isErrno(inspectionError, "ENOENT")) {
          lockPathExists = false;
        } else {
          throw inspectionError;
        }
      }
      if (lockPathExists) {
        throw new RunLockBusyError("run lock is busy");
      }
      lastPermissionError = error;
      continue;
    }
    return requireRegularDirectory(lockDirectory);
  }
  throw lastPermissionError;
}

export function acquireRunLock(workspaceRoot: string, runId: string): RunLock {
  if (!isRunId(runId)) {
    throw new RunLockBusyError("run ID is invalid");
  }

  const root = realpathSync.native(resolve(workspaceRoot));
  const stateDirectory = join(root, ".cu");
  const rootIdentity = requireRegularDirectory(root);
  const stateDirectoryIdentity = requireRegularDirectory(stateDirectory);
  admitWorkspaceForRunLock(root, stateDirectory, rootIdentity, stateDirectoryIdentity);
  const lockRoot = join(stateDirectory, "@locks");
  const lockDirectory = join(lockRoot, runId);
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockRootIdentity = requireRegularDirectory(lockRoot);

  const acquiredLockDirectoryIdentity = createRunLockDirectory(
    root,
    stateDirectory,
    lockRoot,
    lockDirectory,
    rootIdentity,
    stateDirectoryIdentity,
    lockRootIdentity
  );

  const fingerprint = workspaceFingerprint(root);
  const ownerId = randomUUID();
  const owner: RunLockOwner = {
    kind: "cu.run-lock/v1",
    schemaVersion: 1,
    runId,
    workspaceFingerprint: fingerprint,
    ownerId,
    acquiredAt: new Date().toISOString()
  };
  const ownerPath = join(lockDirectory, "owner.json");
  const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`);
  const publishedOwnerIdentity = writeCreateOnceRecordWithIdentity(
    ownerPath,
    lockDirectory,
    ownerBytes
  );
  if (publishedOwnerIdentity === undefined) {
    throw new Error("run lock ownership is uncertain");
  }
  const lockDirectorySnapshot = requireRegularDirectory(lockDirectory);
  const ownerSnapshot = requireRegularFile(ownerPath);
  if (
    !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
    !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory)) ||
    !sameIdentity(lockRootIdentity, requireRegularDirectory(lockRoot)) ||
    !sameIdentity(acquiredLockDirectoryIdentity, lockDirectorySnapshot) ||
    !sameIdentity(publishedOwnerIdentity, ownerSnapshot) ||
    !sameSnapshot(lockDirectorySnapshot, requireRegularDirectory(lockDirectory))
  ) {
    throw new Error("run lock ownership is uncertain");
  }

  const validate = () => {
    const admittedOwnerBytes = readStableRegularFile(
      ownerPath,
      [stateDirectory, lockRoot, lockDirectory]
    );
    if (!admittedOwnerBytes.equals(ownerBytes)) {
      throw new Error("run lock ownership is uncertain");
    }
    const parsed: unknown = JSON.parse(admittedOwnerBytes.toString("utf8"));
    if (
      !sameIdentity(rootIdentity, requireRegularDirectory(root)) ||
      !sameIdentity(stateDirectoryIdentity, requireRegularDirectory(stateDirectory)) ||
      !sameIdentity(lockRootIdentity, requireRegularDirectory(lockRoot)) ||
      !sameSnapshot(lockDirectorySnapshot, requireRegularDirectory(lockDirectory)) ||
      !sameSnapshot(ownerSnapshot, requireRegularFile(ownerPath)) ||
      !isMatchingOwner(parsed, runId, fingerprint, ownerId)
    ) {
      throw new Error("run lock ownership is uncertain");
    }
  };
  validate();
  let lock!: RunLock;
  lock = Object.freeze({
    [runLockBrand]: true as const,
    release() {
      const active = activeRunLocks.get(lock);
      if (active === undefined) {
        throw new Error("run lock ownership is uncertain");
      }
      activeRunLocks.delete(lock);
      active.validate();
      unlinkSync(ownerPath);
      rmdirSync(lockDirectory);
    }
  });
  activeRunLocks.set(lock, { root, runId, validate });
  return lock;
}

export function revalidateRunLock(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): void {
  const active = activeRunLocks.get(lock);
  if (active === undefined || !isRunId(runId) || active.runId !== runId) {
    throw new Error("run lock ownership is uncertain");
  }
  const root = realpathSync.native(resolve(workspaceRoot));
  if (!samePath(active.root, root)) {
    throw new Error("run lock ownership is uncertain");
  }
  active.validate();
}
