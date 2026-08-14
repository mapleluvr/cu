import { lstatSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { join, resolve } from "node:path";

import { inspectArchiveTransaction } from "./archive-store.js";
import { parseEffectJournalBytes } from "./effect-journal.js";
import { isObservationId, isRunId } from "./identifiers.js";
import {
  inspectObservationArchiveReadSnapshot,
  validateObservationArchiveReadSnapshotEffect,
  type ObservationArchiveReadSnapshot
} from "./observation-archive.js";
import { readStableOptionalRegularFile } from "./regular-file.js";
import { inspectRun } from "./run.js";
import { inspectWorkspace } from "./workspace.js";

export class ArchiveQueryError extends Error {
  constructor() {
    super("");
  }
}

export class ArchiveQueryBlockedError extends ArchiveQueryError {}
export class ArchiveQueryEffectJournalInvalidError extends ArchiveQueryError {}

export type HistoryListItem = Readonly<{
  observationId: string;
  capturedAt: string;
  availability: "available" | "unavailable";
  diagnosticOnly: true;
}>;

export type HistoryListResult = Readonly<{
  kind: "cu.history.result/v1";
  runId: string;
  items: readonly HistoryListItem[];
}>;

export type HistoryShowResult = Readonly<{
  kind: "cu.history.result/v1";
  runId: string;
  observationId: string;
  availability: "available" | "unavailable";
  diagnosticOnly: true;
  imagePath?: string;
  coordinateSpace?: "normalized_999_top_left";
  capturedAt?: string;
}>;

export type WorkspaceRunSummary = Readonly<{
  id: string;
  lifecycle: "ready";
  profile: "autonomous";
}>;

export type RunStatusResult = Readonly<{
  id: string;
  exists: boolean;
  lifecycle?: "ready";
  profile?: "autonomous";
  busy?: boolean;
  archive?: Readonly<{
    state: "ready" | "recovery_required";
    retainedBundleCount: number | null;
    committedBytes: number | null;
    maxHistoricalBundles: number;
    maxCommittedBytes: number;
  }>;
  currentObservation?: Readonly<{
    state: "recorded_actionable" | "consumed" | "tombstone" | "unavailable" | "unknown";
  }>;
  effect?: Readonly<{
    state: "none" | "intent" | "partial" | "indeterminate" | "unknown";
  }>;
  history?: Readonly<{
    unavailableEventCount: number | null;
  }>;
}>;

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? value.replaceAll("/", "\\").toLowerCase()
    : value;
  return normalize(left) === normalize(right);
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink;
}

export function listWorkspaceRuns(workspaceRoot: string): readonly WorkspaceRunSummary[] {
  try {
    const root = realpathSync.native(resolve(workspaceRoot));
    if (!inspectWorkspace(root).initialized) {
      return Object.freeze([]);
    }
    const stateDirectory = join(root, ".cu");
    const initialState = lstatSync(stateDirectory, { bigint: true });
    if (
      !initialState.isDirectory() ||
      initialState.isSymbolicLink() ||
      !samePath(realpathSync.native(stateDirectory), stateDirectory)
    ) {
      throw new ArchiveQueryError();
    }
    const initialNames = readdirSync(stateDirectory).sort();
    const summaries: WorkspaceRunSummary[] = [];
    for (const name of initialNames) {
      if (name === "workspace.json") {
        continue;
      }
      if (name === "@locks") {
        const lockRoot = join(stateDirectory, name);
        const lockRootStatus = lstatSync(lockRoot);
        if (
          !lockRootStatus.isDirectory() ||
          lockRootStatus.isSymbolicLink() ||
          !samePath(realpathSync.native(lockRoot), lockRoot)
        ) {
          throw new ArchiveQueryError();
        }
        continue;
      }
      if (!isRunId(name)) {
        throw new ArchiveQueryError();
      }
      const run = inspectRun(root, name);
      if (run === undefined) {
        throw new ArchiveQueryError();
      }
      summaries.push(Object.freeze({
        id: run.runId,
        lifecycle: run.lifecycle,
        profile: run.profile
      }));
    }
    const finalState = lstatSync(stateDirectory, { bigint: true });
    const finalNames = readdirSync(stateDirectory).sort();
    if (
      !finalState.isDirectory() ||
      finalState.isSymbolicLink() ||
      !sameDirectorySnapshot(initialState, finalState) ||
      initialNames.length !== finalNames.length ||
      initialNames.some((name, index) => name !== finalNames[index])
    ) {
      throw new ArchiveQueryError();
    }
    return Object.freeze(summaries.sort((left, right) => left.id.localeCompare(right.id)));
  } catch {
    throw new ArchiveQueryError();
  }
}

function requireRootAndRun(workspaceRoot: string, runId: string): {
  root: string;
  run: NonNullable<ReturnType<typeof inspectRun>>;
  stateDirectory: string;
  runDirectory: string;
  ancestors: readonly string[];
} {
  if (!isRunId(runId)) {
    throw new ArchiveQueryError();
  }
  const root = realpathSync.native(resolve(workspaceRoot));
  const run = inspectRun(root, runId);
  if (run === undefined) {
    throw new ArchiveQueryError();
  }
  const stateDirectory = join(root, ".cu");
  const runDirectory = join(stateDirectory, runId);
  return {
    root,
    run,
    stateDirectory,
    runDirectory,
    ancestors: Object.freeze([stateDirectory, runDirectory])
  };
}

function archiveRecoveryRequired(root: string, runId: string): boolean {
  try {
    return inspectArchiveTransaction(root, runId) !== undefined;
  } catch {
    return true;
  }
}

async function inspectAvailableArchive(
  root: string,
  runId: string
): Promise<ObservationArchiveReadSnapshot> {
  if (archiveRecoveryRequired(root, runId)) {
    throw new ArchiveQueryBlockedError();
  }
  const snapshot = await inspectObservationArchiveReadSnapshot(root, runId);
  if (archiveRecoveryRequired(root, runId)) {
    throw new ArchiveQueryBlockedError();
  }
  return snapshot;
}

function inspectBusy(stateDirectory: string, runId: string): boolean {
  const lockRoot = join(stateDirectory, "@locks");
  const lockDirectory = join(lockRoot, runId);
  try {
    const rootStatus = lstatSync(lockRoot);
    if (
      !rootStatus.isDirectory() ||
      rootStatus.isSymbolicLink() ||
      !samePath(realpathSync.native(lockRoot), lockRoot)
    ) {
      throw new ArchiveQueryError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    const lockStatus = lstatSync(lockDirectory);
    if (
      !lockStatus.isDirectory() ||
      lockStatus.isSymbolicLink() ||
      !samePath(realpathSync.native(lockDirectory), lockDirectory)
    ) {
      throw new ArchiveQueryError();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function listRunHistory(
  workspaceRoot: string,
  runId: string
): Promise<HistoryListResult> {
  try {
    const { root } = requireRootAndRun(workspaceRoot, runId);
    const snapshot = await inspectAvailableArchive(root, runId);
    const items = [...snapshot.history]
      .sort((left, right) => {
        if (left.capturedAt !== right.capturedAt) {
          return left.capturedAt < right.capturedAt ? 1 : -1;
        }
        if (left.observationId === right.observationId) {
          return 0;
        }
        return left.observationId < right.observationId ? 1 : -1;
      })
      .slice(0, 641)
      .map((entry) => Object.freeze({
        observationId: entry.observationId,
        capturedAt: entry.capturedAt,
        availability: entry.availability,
        diagnosticOnly: true as const
      }));
    return Object.freeze({
      kind: "cu.history.result/v1" as const,
      runId,
      items: Object.freeze(items)
    });
  } catch (error) {
    if (error instanceof ArchiveQueryBlockedError) {
      throw error;
    }
    throw new ArchiveQueryError();
  }
}

export async function showRunHistory(
  workspaceRoot: string,
  runId: string,
  observationId: string
): Promise<HistoryShowResult> {
  try {
    if (!isObservationId(observationId)) {
      throw new ArchiveQueryError();
    }
    const { root } = requireRootAndRun(workspaceRoot, runId);
    const snapshot = await inspectAvailableArchive(root, runId);
    const retained = snapshot.retained.find((entry) => entry.observationId === observationId);
    if (retained === undefined) {
      return Object.freeze({
        kind: "cu.history.result/v1" as const,
        runId,
        observationId,
        availability: "unavailable",
        diagnosticOnly: true
      });
    }
    return Object.freeze({
      kind: "cu.history.result/v1" as const,
      runId,
      observationId,
      availability: "available",
      diagnosticOnly: true,
      imagePath: retained.imagePath,
      coordinateSpace: retained.coordinateSpace,
      capturedAt: retained.capturedAt
    });
  } catch (error) {
    if (error instanceof ArchiveQueryBlockedError) {
      throw error;
    }
    throw new ArchiveQueryError();
  }
}

function recoveryRequiredRunStatus(
  runId: string,
  lifecycle: "ready",
  profile: "autonomous",
  busy: boolean
): RunStatusResult {
  return Object.freeze({
    id: runId,
    exists: true,
    lifecycle,
    profile,
    busy,
    archive: Object.freeze({
      state: "recovery_required",
      retainedBundleCount: null,
      committedBytes: null,
      maxHistoricalBundles: 128,
      maxCommittedBytes: 536_870_912
    }),
    currentObservation: Object.freeze({ state: "unknown" }),
    effect: Object.freeze({ state: "unknown" }),
    history: Object.freeze({ unavailableEventCount: null })
  });
}

export async function inspectRunStatus(
  workspaceRoot: string,
  runId: string
): Promise<RunStatusResult> {
  try {
    if (!isRunId(runId)) {
      throw new ArchiveQueryError();
    }
    const root = realpathSync.native(resolve(workspaceRoot));
    const run = inspectRun(root, runId);
    if (run === undefined) {
      return Object.freeze({ id: runId, exists: false });
    }
    const stateDirectory = join(root, ".cu");
    const runDirectory = join(stateDirectory, runId);
    const ancestors = Object.freeze([stateDirectory, runDirectory]);
    const busy = inspectBusy(stateDirectory, runId);
    if (archiveRecoveryRequired(root, runId)) {
      return recoveryRequiredRunStatus(runId, run.lifecycle, run.profile, busy);
    }
    try {
      const snapshot = await inspectObservationArchiveReadSnapshot(root, runId);
      if (archiveRecoveryRequired(root, runId)) {
        return recoveryRequiredRunStatus(runId, run.lifecycle, run.profile, busy);
      }
      const journalBytes = readStableOptionalRegularFile(
        join(runDirectory, "effect-journal.json"),
        ancestors
      );
      let effectState: "none" | "intent" | "partial" | "indeterminate" = "none";
      if (journalBytes !== undefined) {
        try {
          const journal = parseEffectJournalBytes(journalBytes, {
            runId,
            workspaceFingerprint: run.workspaceFingerprint
          });
          validateObservationArchiveReadSnapshotEffect(snapshot, journal);
          effectState = journal.state;
        } catch {
          throw new ArchiveQueryEffectJournalInvalidError();
        }
      }
      if (archiveRecoveryRequired(root, runId)) {
        return recoveryRequiredRunStatus(runId, run.lifecycle, run.profile, busy);
      }
      const unavailableEventCount = snapshot.history.filter(
        (entry) => entry.availability === "unavailable"
      ).length;
      return Object.freeze({
        id: runId,
        exists: true,
        lifecycle: run.lifecycle,
        profile: run.profile,
        busy,
        archive: Object.freeze({
          state: "ready",
          retainedBundleCount: snapshot.retained.length,
          committedBytes: snapshot.retained.reduce((sum, entry) => sum + entry.committedBytes, 0),
          maxHistoricalBundles: snapshot.maxHistoricalBundles,
          maxCommittedBytes: snapshot.maxCommittedBytes
        }),
        currentObservation: Object.freeze({ state: snapshot.currentObservationState }),
        effect: Object.freeze({ state: effectState }),
        history: Object.freeze({ unavailableEventCount })
      });
    } catch (error) {
      if (archiveRecoveryRequired(root, runId)) {
        return recoveryRequiredRunStatus(runId, run.lifecycle, run.profile, busy);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ArchiveQueryEffectJournalInvalidError) {
      throw error;
    }
    throw new ArchiveQueryError();
  }
}
