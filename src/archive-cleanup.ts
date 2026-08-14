import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { inspectUnresolvedEffect } from "./effect-store.js";
import {
  clearObservationArchiveAll,
  clearObservationArchiveRange,
  inspectObservationArchiveReadSnapshot,
  recoverObservationArchive,
  ObservationArchivePublicationUncertainError
} from "./observation-archive.js";
import {
  captureStableAncestorBaseline,
  readStableOptionalRegularFileWithWitnessAgainstBaseline
} from "./regular-file.js";
import { revalidateRunLock, type RunLock } from "./run-lock.js";

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ArchiveCleanupError extends Error {
  constructor() {
    super("");
  }
}

export class ArchiveCleanupPublicationUncertainError extends ArchiveCleanupError {}

export type ClearRangeOptions = Readonly<{
  timeStart?: string;
  timeEnd: string;
}>;

export type ClearRangeResult = Readonly<{
  kind: "cu.clear.result/v1";
  runId: string;
  clearedCount: number;
  invalidatedCurrent: boolean;
}>;

export type ClearAllResult = Readonly<{
  kind: "cu.clearall.result/v1";
  runId: string;
  clearedCount: number;
}>;

function timestampValue(value: string): number {
  if (!timestampPattern.test(value)) {
    throw new ArchiveCleanupError();
  }
  try {
    if (new Date(value).toISOString() !== value) {
      throw new ArchiveCleanupError();
    }
    return new Date(value).getTime();
  } catch {
    throw new ArchiveCleanupError();
  }
}

function rangeValues(options: ClearRangeOptions): { start: number | null; end: number } {
  const end = timestampValue(options.timeEnd);
  const start = options.timeStart === undefined ? null : timestampValue(options.timeStart);
  if (start !== null && start >= end) {
    throw new ArchiveCleanupError();
  }
  return { start, end };
}

async function requireCleanupPreflight(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
) {
  try {
    const root = realpathSync.native(resolve(workspaceRoot));
    revalidateRunLock(lock, root, runId);
    const effectJournalPath = join(root, ".cu", runId, "effect-journal.json");
    const effectAncestors = [join(root, ".cu"), join(root, ".cu", runId)];
    const effectBaseline = captureStableAncestorBaseline(effectJournalPath, effectAncestors);
    const effectJournal = readStableOptionalRegularFileWithWitnessAgainstBaseline(
      effectJournalPath,
      effectAncestors,
      effectBaseline
    );
    if (effectJournal !== undefined) {
      throw new ArchiveCleanupError();
    }
    await recoverObservationArchive(lock, root, runId);
    if (inspectUnresolvedEffect(lock, root, runId) !== undefined) {
      throw new ArchiveCleanupError();
    }
    revalidateRunLock(lock, root, runId);
    const snapshot = await inspectObservationArchiveReadSnapshot(root, runId);
    revalidateRunLock(lock, root, runId);
    return { root, snapshot };
  } catch (error) {
    if (error instanceof ArchiveCleanupError) {
      throw error;
    }
    throw new ArchiveCleanupError();
  }
}

export async function clearRangeObservations(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  options: ClearRangeOptions
): Promise<ClearRangeResult> {
  const range = rangeValues(options);
  const { snapshot } = await requireCleanupPreflight(lock, workspaceRoot, runId);
  const selected = snapshot.retained.filter((entry) => {
    const capturedAt = new Date(entry.capturedAt).getTime();
    return capturedAt < range.end && (range.start === null || capturedAt >= range.start);
  });
  if (selected.length === 0) {
    return Object.freeze({
      kind: "cu.clear.result/v1",
      runId,
      clearedCount: 0,
      invalidatedCurrent: false
    });
  }
  try {
    const result = await clearObservationArchiveRange(
      lock,
      workspaceRoot,
      runId,
      options.timeStart ?? null,
      options.timeEnd
    );
    return Object.freeze({
      kind: "cu.clear.result/v1",
      runId,
      clearedCount: result.clearedCount,
      invalidatedCurrent: result.invalidatedCurrent
    });
  } catch (error) {
    if (error instanceof ObservationArchivePublicationUncertainError) {
      throw new ArchiveCleanupPublicationUncertainError();
    }
    throw new ArchiveCleanupError();
  }
}

export async function clearAllObservations(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): Promise<ClearAllResult> {
  await requireCleanupPreflight(lock, workspaceRoot, runId);
  try {
    const result = await clearObservationArchiveAll(lock, workspaceRoot, runId);
    return Object.freeze({
      kind: "cu.clearall.result/v1",
      runId,
      clearedCount: result.clearedCount
    });
  } catch (error) {
    if (error instanceof ObservationArchivePublicationUncertainError) {
      throw new ArchiveCleanupPublicationUncertainError();
    }
    throw new ArchiveCleanupError();
  }
}
