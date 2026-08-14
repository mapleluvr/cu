import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  type BigIntStats
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";

import {
  inspectArchiveTransactionWithWitness,
  type WitnessedArchiveTransaction
} from "./archive-store.js";
import {
  assertStableRegularFileWitnessContinuity,
  captureStableAncestorBaseline,
  revalidateStableAncestorIdentitiesAgainstBaseline,
  revalidateStableRegularFileWitness,
  type StableAncestorBaseline
} from "./regular-file.js";
import { revalidateRunLock, type RunLock } from "./run-lock.js";

export class ArchiveLayoutError extends Error {}

declare const archiveTransactionLayoutBrand: unique symbol;
export type ArchiveTransactionLayout = {
  readonly [archiveTransactionLayoutBrand]: true;
};

type DirectoryIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

type ArchiveLayoutData = {
  root: string;
  runId: string;
  transaction: WitnessedArchiveTransaction["transaction"];
  witness: WitnessedArchiveTransaction["witness"];
  recordPath: string;
  ancestors: readonly string[];
  baseline: StableAncestorBaseline;
  directories: readonly DirectoryIdentity[];
};

const archiveLayouts = new WeakMap<object, ArchiveLayoutData>();

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function identityFromStatus(
  expected: string,
  status: BigIntStats
): DirectoryIdentity {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ArchiveLayoutError();
  }
  const canonical = realpathSync.native(expected);
  if (!samePath(canonical, expected)) {
    throw new ArchiveLayoutError();
  }
  return {
    path: expected,
    dev: status.dev,
    ino: status.ino,
    birthtimeNs: status.birthtimeNs
  };
}

function directoryIdentity(path: string): DirectoryIdentity {
  const expected = resolve(path);
  return identityFromStatus(expected, lstatSync(expected, { bigint: true }));
}

function optionalDirectoryIdentity(path: string): DirectoryIdentity | undefined {
  const expected = resolve(path);
  let status: BigIntStats;
  try {
    status = lstatSync(expected, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return identityFromStatus(expected, status);
}

function sameIdentity(identity: DirectoryIdentity, status: BigIntStats): boolean {
  return (
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    status.dev === identity.dev &&
    status.ino === identity.ino &&
    status.birthtimeNs === identity.birthtimeNs
  );
}

type DirectoryPreflight = {
  identity: DirectoryIdentity | undefined;
  entries: readonly string[];
};

type TransactionDirectoryPreflight = DirectoryPreflight & {
  staging: DirectoryIdentity | undefined;
  trash: DirectoryIdentity | undefined;
};

function admitChildDirectory(
  path: string,
  parent: DirectoryIdentity,
  expected: DirectoryIdentity | undefined
): DirectoryIdentity {
  revalidateDirectories([parent]);
  if (!samePath(dirname(path), parent.path)) {
    throw new ArchiveLayoutError();
  }
  if (expected !== undefined) {
    if (!samePath(expected.path, resolve(path))) {
      throw new ArchiveLayoutError();
    }
    revalidateDirectories([expected]);
    return expected;
  }
  mkdirSync(path);
  return directoryIdentity(path);
}

function preflightArchiveNamespace(
  path: string,
  transactionId: string
): DirectoryPreflight {
  const identity = optionalDirectoryIdentity(path);
  if (identity === undefined) {
    return { identity: undefined, entries: Object.freeze([]) };
  }
  const entries = readdirSync(path).sort();
  if (
    entries.length > 1 ||
    (entries.length === 1 && entries[0] !== transactionId)
  ) {
    throw new ArchiveLayoutError();
  }
  return { identity, entries: Object.freeze(entries) };
}

function preflightTransactionDirectory(path: string): TransactionDirectoryPreflight {
  const identity = optionalDirectoryIdentity(path);
  if (identity === undefined) {
    return {
      identity: undefined,
      entries: Object.freeze([]),
      staging: undefined,
      trash: undefined
    };
  }
  const allowed = new Set(["staging", "trash"]);
  const entries = readdirSync(path).sort();
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new ArchiveLayoutError();
  }
  const staging = entries.includes("staging")
    ? directoryIdentity(join(path, "staging"))
    : undefined;
  const trash = entries.includes("trash")
    ? directoryIdentity(join(path, "trash"))
    : undefined;
  for (const child of [staging, trash]) {
    if (child !== undefined) {
      requireEntries(child.path, []);
    }
  }
  return {
    identity,
    entries: Object.freeze(entries),
    staging,
    trash
  };
}

function requireEntries(path: string, expected: readonly string[]): void {
  const actual = readdirSync(path).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new ArchiveLayoutError();
  }
}

function revalidateDirectories(directories: readonly DirectoryIdentity[]): void {
  for (const identity of directories) {
    const status = lstatSync(identity.path, { bigint: true });
    if (!sameIdentity(identity, status)) {
      throw new ArchiveLayoutError();
    }
    if (!samePath(realpathSync.native(identity.path), identity.path)) {
      throw new ArchiveLayoutError();
    }
  }
}

function revalidateEmptyTransactionState(
  transaction: DirectoryIdentity,
  children: readonly DirectoryIdentity[]
): void {
  revalidateDirectories([transaction, ...children]);
  requireEntries(
    transaction.path,
    children.map((child) => child.path.slice(transaction.path.length + 1))
  );
  for (const child of children) {
    requireEntries(child.path, []);
  }
}

function revalidateLayoutNamespace(
  directories: readonly DirectoryIdentity[],
  transactionId: string
): void {
  revalidateDirectories(directories);
  requireEntries(directories[2]!.path, [transactionId]);
  requireEntries(directories[3]!.path, ["staging", "trash"]);
  revalidateDirectories(directories);
}

function requirePreparedTransaction(
  workspaceRoot: string,
  runId: string
): WitnessedArchiveTransaction {
  const active = inspectArchiveTransactionWithWitness(workspaceRoot, runId);
  if (active === undefined || active.transaction.state !== "prepared") {
    throw new ArchiveLayoutError();
  }
  return active;
}

function requireSamePreparedTransaction(
  workspaceRoot: string,
  runId: string,
  expected: WitnessedArchiveTransaction["transaction"]
): WitnessedArchiveTransaction {
  const active = requirePreparedTransaction(workspaceRoot, runId);
  if (!isDeepStrictEqual(active.transaction, expected)) {
    throw new ArchiveLayoutError();
  }
  return active;
}

function inspectLayout(
  root: string,
  runId: string,
  transactionId: string
): {
  recordPath: string;
  ancestors: readonly string[];
  baseline: StableAncestorBaseline;
  paths: readonly string[];
} {
  const stateDirectory = join(root, ".cu");
  const runDirectory = join(stateDirectory, runId);
  const recordPath = join(runDirectory, "archive-transaction.json");
  const ancestors = Object.freeze([stateDirectory, runDirectory]);
  const baseline = captureStableAncestorBaseline(recordPath, ancestors);
  const archiveDirectory = join(runDirectory, "@archive");
  const transactionDirectory = join(archiveDirectory, transactionId);
  const stagingDirectory = join(transactionDirectory, "staging");
  const trashDirectory = join(transactionDirectory, "trash");
  return {
    recordPath,
    ancestors,
    baseline,
    paths: Object.freeze([
      stateDirectory,
      runDirectory,
      archiveDirectory,
      transactionDirectory,
      stagingDirectory,
      trashDirectory
    ])
  };
}

export function prepareArchiveTransactionLayout(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): ArchiveTransactionLayout {
  try {
    revalidateRunLock(lock, workspaceRoot, runId);
    const root = realpathSync.native(resolve(workspaceRoot));
    const initialActive = requirePreparedTransaction(root, runId);
    const transaction = initialActive.transaction;
    const inspected = inspectLayout(root, runId, transaction.transactionId);
    revalidateStableAncestorIdentitiesAgainstBaseline(
      inspected.recordPath,
      inspected.ancestors,
      inspected.baseline
    );

    const stateIdentity = directoryIdentity(inspected.paths[0]!);
    const runIdentity = directoryIdentity(inspected.paths[1]!);
    const revalidateCreationAuthority = () => {
      revalidateStableAncestorIdentitiesAgainstBaseline(
        inspected.recordPath,
        inspected.ancestors,
        inspected.baseline
      );
      revalidateRunLock(lock, root, runId);
      revalidateStableAncestorIdentitiesAgainstBaseline(
        inspected.recordPath,
        inspected.ancestors,
        inspected.baseline
      );
    };
    const archivePreflight = preflightArchiveNamespace(
      inspected.paths[2]!,
      transaction.transactionId
    );
    const transactionPreflight = preflightTransactionDirectory(inspected.paths[3]!);
    revalidateCreationAuthority();
    revalidateStableRegularFileWitness(
      initialActive.recordPath,
      initialActive.ancestors,
      initialActive.witness
    );
    revalidateCreationAuthority();
    const archiveIdentity = admitChildDirectory(
      inspected.paths[2]!,
      runIdentity,
      archivePreflight.identity
    );
    requireEntries(archiveIdentity.path, archivePreflight.entries);
    revalidateCreationAuthority();
    revalidateDirectories([archiveIdentity]);
    requireEntries(archiveIdentity.path, archivePreflight.entries);
    const transactionIdentity = admitChildDirectory(
      inspected.paths[3]!,
      archiveIdentity,
      transactionPreflight.identity
    );
    requireEntries(archiveIdentity.path, [transaction.transactionId]);
    const initialChildren = [
      transactionPreflight.staging,
      transactionPreflight.trash
    ].filter((child): child is DirectoryIdentity => child !== undefined);
    revalidateEmptyTransactionState(transactionIdentity, initialChildren);
    revalidateCreationAuthority();
    revalidateEmptyTransactionState(transactionIdentity, initialChildren);
    const stagingIdentity = admitChildDirectory(
      inspected.paths[4]!,
      transactionIdentity,
      transactionPreflight.staging
    );
    const afterStaging = transactionPreflight.trash === undefined
      ? [stagingIdentity]
      : [stagingIdentity, transactionPreflight.trash];
    revalidateEmptyTransactionState(transactionIdentity, afterStaging);
    revalidateCreationAuthority();
    revalidateEmptyTransactionState(transactionIdentity, afterStaging);
    const trashIdentity = admitChildDirectory(
      inspected.paths[5]!,
      transactionIdentity,
      transactionPreflight.trash
    );
    const directories: DirectoryIdentity[] = [
      stateIdentity,
      runIdentity,
      archiveIdentity,
      transactionIdentity,
      stagingIdentity,
      trashIdentity
    ];

    requireEntries(inspected.paths[4]!, []);
    requireEntries(inspected.paths[5]!, []);
    revalidateLayoutNamespace(directories, transaction.transactionId);
    revalidateStableAncestorIdentitiesAgainstBaseline(
      inspected.recordPath,
      inspected.ancestors,
      inspected.baseline
    );
    revalidateRunLock(lock, root, runId);
    const active = requireSamePreparedTransaction(root, runId, transaction);
    assertStableRegularFileWitnessContinuity(
      inspected.recordPath,
      inspected.ancestors,
      initialActive.witness,
      active.witness
    );
    revalidateDirectories(directories);
    revalidateStableRegularFileWitness(
      active.recordPath,
      active.ancestors,
      active.witness
    );
    revalidateRunLock(lock, root, runId);
    revalidateStableRegularFileWitness(
      active.recordPath,
      active.ancestors,
      active.witness
    );
    revalidateLayoutNamespace(directories, transaction.transactionId);

    const layout = Object.freeze({}) as ArchiveTransactionLayout;
    archiveLayouts.set(layout, {
      root,
      runId,
      transaction,
      witness: active.witness,
      recordPath: inspected.recordPath,
      ancestors: inspected.ancestors,
      baseline: inspected.baseline,
      directories: Object.freeze(directories.map((identity) => Object.freeze({ ...identity })))
    });
    return layout;
  } catch {
    throw new ArchiveLayoutError();
  }
}

export type ArchiveTransactionLayoutPaths = Readonly<{
  root: string;
  runId: string;
  transaction: WitnessedArchiveTransaction["transaction"];
  recordPath: string;
  ancestors: readonly string[];
  archiveDirectory: string;
  transactionDirectory: string;
  stagingDirectory: string;
  trashDirectory: string;
  capturesDirectory: string;
  liveObservationPath: string;
  historyPath: string;
}>;

export function inspectArchiveTransactionLayout(
  layout: ArchiveTransactionLayout,
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): ArchiveTransactionLayoutPaths {
  revalidateArchiveTransactionLayout(layout, lock, workspaceRoot, runId);
  const data = archiveLayouts.get(layout);
  if (data === undefined) {
    throw new ArchiveLayoutError();
  }
  const runDirectory = data.directories[1]!.path;
  const transactionDirectory = data.directories[3]!.path;
  return Object.freeze({
    root: data.root,
    runId: data.runId,
    transaction: data.transaction,
    recordPath: data.recordPath,
    ancestors: Object.freeze([...data.ancestors]),
    archiveDirectory: data.directories[2]!.path,
    transactionDirectory,
    stagingDirectory: data.directories[4]!.path,
    trashDirectory: data.directories[5]!.path,
    capturesDirectory: join(runDirectory, "captures"),
    liveObservationPath: join(runDirectory, "live-observation.json"),
    historyPath: join(runDirectory, "history.ndjson")
  });
}

export function revalidateArchiveTransactionLayout(
  layout: ArchiveTransactionLayout,
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): void {
  try {
    const data = archiveLayouts.get(layout);
    if (data === undefined) {
      throw new ArchiveLayoutError();
    }
    const root = realpathSync.native(resolve(workspaceRoot));
    if (!samePath(root, data.root) || runId !== data.runId) {
      throw new ArchiveLayoutError();
    }
    revalidateRunLock(lock, root, runId);
    revalidateStableAncestorIdentitiesAgainstBaseline(
      data.recordPath,
      data.ancestors,
      data.baseline
    );
    revalidateLayoutNamespace(data.directories, data.transaction.transactionId);
    revalidateStableRegularFileWitness(
      data.recordPath,
      data.ancestors,
      data.witness
    );
    revalidateDirectories(data.directories);
    revalidateRunLock(lock, root, runId);
    revalidateStableRegularFileWitness(
      data.recordPath,
      data.ancestors,
      data.witness
    );
    revalidateLayoutNamespace(data.directories, data.transaction.transactionId);
  } catch {
    throw new ArchiveLayoutError();
  }
}
