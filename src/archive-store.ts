import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseArchiveTransactionBytes,
  type ArchiveTransaction
} from "./archive-transaction.js";
import {
  ControlRecordPublicationUncertainError,
  discardStagedControlRecord,
  publishStagedControlRecordCreateOnce,
  stageValidatedControlRecord,
  type ControlRecordIdentity,
  type StagedControlRecord
} from "./control-write.js";
import { isRunId } from "./identifiers.js";
import {
  captureStableAncestorBaseline,
  readStableOptionalRegularFileWithWitnessAgainstBaseline,
  revalidateStableAncestorIdentitiesAgainstBaseline,
  type StableAncestorBaseline,
  type StableRegularFileWitness
} from "./regular-file.js";
import { inspectRun } from "./run.js";
import { revalidateRunLock, type RunLock } from "./run-lock.js";
import { inspectWorkspace } from "./workspace.js";

export class ArchiveStoreError extends Error {}
export class ArchiveStorePublicationUncertainError extends ArchiveStoreError {}

export interface WitnessedArchiveTransaction {
  readonly transaction: ArchiveTransaction;
  readonly recordPath: string;
  readonly ancestors: readonly string[];
  readonly witness: StableRegularFileWitness;
}

export interface PublishedArchiveTransaction extends WitnessedArchiveTransaction {
  readonly identity: ControlRecordIdentity;
}

type ArchiveTransactionInspection = {
  root: string;
  run: NonNullable<ReturnType<typeof inspectRun>>;
  recordPath: string;
  ancestors: readonly string[];
  baseline: StableAncestorBaseline;
  admitted: WitnessedArchiveTransaction | undefined;
};

function inspectArchiveTransactionEntry(
  workspaceRoot: string,
  runId: string
): ArchiveTransactionInspection {
  try {
    if (!isRunId(runId)) {
      throw new ArchiveStoreError();
    }

    const root = realpathSync.native(resolve(workspaceRoot));
    const stateDirectory = join(root, ".cu");
    const runDirectory = join(stateDirectory, runId);
    const recordPath = join(runDirectory, "archive-transaction.json");
    const ancestors = Object.freeze([stateDirectory, runDirectory]);
    const baseline = captureStableAncestorBaseline(recordPath, ancestors);

    if (!inspectWorkspace(root).initialized) {
      throw new ArchiveStoreError();
    }

    const run = inspectRun(root, runId);
    if (run === undefined || run.runId !== runId) {
      throw new ArchiveStoreError();
    }

    const present = readStableOptionalRegularFileWithWitnessAgainstBaseline(
      recordPath,
      ancestors,
      baseline
    );
    if (present === undefined) {
      return { root, run, recordPath, ancestors, baseline, admitted: undefined };
    }

    const transaction = parseArchiveTransactionBytes(present.bytes, {
      runId: run.runId,
      workspaceFingerprint: run.workspaceFingerprint
    });
    return {
      root,
      run,
      recordPath,
      ancestors,
      baseline,
      admitted: Object.freeze({
        transaction,
        recordPath,
        ancestors,
        witness: present.witness
      })
    };
  } catch {
    throw new ArchiveStoreError();
  }
}

export function inspectArchiveTransactionWithWitness(
  workspaceRoot: string,
  runId: string
): WitnessedArchiveTransaction | undefined {
  return inspectArchiveTransactionEntry(workspaceRoot, runId).admitted;
}

export function inspectArchiveTransaction(
  workspaceRoot: string,
  runId: string
): ArchiveTransaction | undefined {
  return inspectArchiveTransactionWithWitness(workspaceRoot, runId)?.transaction;
}

function discardArchiveStage(staged: StagedControlRecord): void {
  try {
    discardStagedControlRecord(staged);
  } catch {
    throw new ArchiveStoreError();
  }
}

export function publishPreparedArchiveTransaction(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  bytes: Uint8Array
): PublishedArchiveTransaction {
  try {
    revalidateRunLock(lock, workspaceRoot, runId);
  } catch {
    throw new ArchiveStoreError();
  }
  const inspection = inspectArchiveTransactionEntry(workspaceRoot, runId);
  if (inspection.admitted !== undefined) {
    throw new ArchiveStoreError();
  }
  const { root, run, recordPath, ancestors, baseline } = inspection;
  const runDirectory = ancestors[ancestors.length - 1]!;
  const candidateBytes = Buffer.from(bytes);
  const admit = (candidate: Uint8Array) => {
    const transaction = parseArchiveTransactionBytes(candidate, {
      runId: run.runId,
      workspaceFingerprint: run.workspaceFingerprint
    });
    if (transaction.state !== "prepared") {
      throw new ArchiveStoreError();
    }
    return transaction;
  };
  let transaction: ArchiveTransaction;
  try {
    transaction = admit(candidateBytes);
  } catch (error) {
    if (error instanceof ArchiveStoreError) {
      throw error;
    }
    throw new ArchiveStoreError();
  }
  try {
    if (
      readStableOptionalRegularFileWithWitnessAgainstBaseline(
        recordPath,
        ancestors,
        baseline
      ) !== undefined
    ) {
      throw new ArchiveStoreError();
    }
  } catch {
    throw new ArchiveStoreError();
  }
  try {
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
  } catch {
    throw new ArchiveStoreError();
  }
  let staged: StagedControlRecord;
  try {
    staged = stageValidatedControlRecord(
      recordPath,
      runDirectory,
      ancestors,
      candidateBytes,
      (candidate) => {
        admit(candidate);
      }
    );
  } catch {
    throw new ArchiveStoreError();
  }
  try {
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
    revalidateRunLock(lock, root, runId);
  } catch {
    discardArchiveStage(staged);
    throw new ArchiveStoreError();
  }
  let activeTransaction: WitnessedArchiveTransaction | undefined;
  try {
    activeTransaction = inspectArchiveTransactionWithWitness(root, runId);
  } catch {
    discardArchiveStage(staged);
    throw new ArchiveStoreError();
  }
  if (activeTransaction !== undefined) {
    discardArchiveStage(staged);
    throw new ArchiveStoreError();
  }
  try {
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
    revalidateRunLock(lock, root, runId);
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
  } catch {
    discardArchiveStage(staged);
    throw new ArchiveStoreError();
  }
  let published;
  try {
    published = publishStagedControlRecordCreateOnce(
      recordPath,
      runDirectory,
      ancestors,
      staged
    );
  } catch (error) {
    if (error instanceof ControlRecordPublicationUncertainError) {
      throw new ArchiveStorePublicationUncertainError();
    }
    throw new ArchiveStoreError();
  }
  if (published === undefined) {
    throw new ArchiveStorePublicationUncertainError();
  }
  try {
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
    revalidateRunLock(lock, root, runId);
    revalidateStableAncestorIdentitiesAgainstBaseline(recordPath, ancestors, baseline);
  } catch {
    throw new ArchiveStorePublicationUncertainError();
  }
  return Object.freeze({
    transaction,
    recordPath,
    ancestors: Object.freeze([...ancestors]),
    identity: published.identity,
    witness: published.witness
  });
}
