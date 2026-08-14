import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeCreateOnceRecord } from "./control-write.js";
import { isRunId } from "./identifiers.js";
import { readStableRegularFile } from "./regular-file.js";
import { acquireRunLock } from "./run-lock.js";
import { workspaceFingerprint } from "./workspace.js";

export class RunStateError extends Error {}

export type RunRecord = {
  kind: "cu.run/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  profile: "autonomous";
  lifecycle: "ready";
  createdAt: string;
};

const runRecordKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "profile",
  "lifecycle",
  "createdAt"
];

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new RunStateError("run path cannot be inspected");
  }
}

function isRunRecord(value: unknown): value is RunRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const createdAt = record.createdAt;
  return (
    Object.keys(record).length === runRecordKeys.length &&
    runRecordKeys.every((key) => Object.hasOwn(record, key)) &&
    record.kind === "cu.run/v1" &&
    record.schemaVersion === 1 &&
    typeof record.runId === "string" &&
    typeof record.workspaceFingerprint === "string" &&
    record.profile === "autonomous" &&
    record.lifecycle === "ready" &&
    typeof createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) &&
    new Date(createdAt).toISOString() === createdAt
  );
}

export function ensureRun(
  workspaceRoot: string,
  runId: string
): { created: boolean; record: RunRecord } {
  if (!isRunId(runId)) {
    throw new RunStateError("run ID is invalid");
  }

  const lock = acquireRunLock(workspaceRoot, runId);
  try {
    const existing = inspectRun(workspaceRoot, runId);
    if (existing !== undefined) {
      return { created: false, record: existing };
    }

    const root = realpathSync.native(resolve(workspaceRoot));
    const record: RunRecord = {
      kind: "cu.run/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: workspaceFingerprint(root),
      profile: "autonomous",
      lifecycle: "ready",
      createdAt: new Date().toISOString()
    };
    const runDirectory = join(root, ".cu", runId);
    mkdirSync(runDirectory);
    const recordPath = join(runDirectory, "run.json");
    if (!writeCreateOnceRecord(recordPath, runDirectory, Buffer.from(`${JSON.stringify(record)}\n`))) {
      const raced = inspectRun(workspaceRoot, runId);
      if (raced !== undefined) {
        return { created: false, record: raced };
      }
      throw new RunStateError("run record publication is uncertain");
    }
    const installed = inspectRun(workspaceRoot, runId);
    if (installed === undefined) {
      throw new RunStateError("run record publication is uncertain");
    }
    return { created: true, record: installed };
  } finally {
    lock.release();
  }
}

export function inspectRun(workspaceRoot: string, runId: string): RunRecord | undefined {
  if (!isRunId(runId)) {
    throw new RunStateError("run ID is invalid");
  }

  const root = realpathSync.native(resolve(workspaceRoot));
  const stateDirectory = join(root, ".cu");
  const stateDirectoryStat = lstatOrUndefined(stateDirectory);
  if (
    stateDirectoryStat === undefined ||
    !stateDirectoryStat.isDirectory() ||
    stateDirectoryStat.isSymbolicLink()
  ) {
    throw new RunStateError("workspace state directory is invalid");
  }

  const runDirectory = join(stateDirectory, runId);
  const runDirectoryStat = lstatOrUndefined(runDirectory);
  if (runDirectoryStat === undefined) {
    return undefined;
  }
  if (!runDirectoryStat.isDirectory() || runDirectoryStat.isSymbolicLink()) {
    throw new RunStateError("run directory is invalid");
  }

  const recordPath = join(runDirectory, "run.json");
  const recordStat = lstatOrUndefined(recordPath);
  if (recordStat === undefined) {
    throw new RunStateError("run record is missing");
  }
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw new RunStateError("run record is not a regular file");
  }

  try {
    const parsed: unknown = JSON.parse(
      readStableRegularFile(recordPath, [stateDirectory, runDirectory]).toString("utf8")
    );
    if (
      !isRunRecord(parsed) ||
      parsed.runId !== runId ||
      parsed.workspaceFingerprint !== workspaceFingerprint(root)
    ) {
      throw new RunStateError("run record is invalid");
    }
    return parsed;
  } catch {
    throw new RunStateError("run record is invalid");
  }
}
