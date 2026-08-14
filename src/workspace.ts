import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  readStableRegularFile,
  RegularFileAncestorChangedError
} from "./regular-file.js";

export class WorkspaceRecordReadUncertainError extends Error {}

type WorkspaceRecord = {
  kind: "cu.workspace/v1";
  schemaVersion: 1;
  rootFingerprint: string;
  createdAt: string;
};

const workspaceRecordKeys = ["kind", "schemaVersion", "rootFingerprint", "createdAt"];

export function workspaceFingerprint(workspaceRoot: string): string {
  const canonicalRoot = realpathSync.native(resolve(workspaceRoot));
  const normalizedRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return createHash("sha256").update(normalizedRoot, "utf8").digest("hex");
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error("workspace path cannot be inspected");
  }
}

function isWorkspaceRecord(value: unknown, fingerprint: string): value is WorkspaceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === workspaceRecordKeys.length &&
    workspaceRecordKeys.every((key) => Object.hasOwn(record, key)) &&
    record.kind === "cu.workspace/v1" &&
    record.schemaVersion === 1 &&
    record.rootFingerprint === fingerprint &&
    typeof record.createdAt === "string"
  );
}

function validateWorkspaceRecord(
  recordPath: string,
  stateDirectory: string,
  fingerprint: string
): void {
  let bytes: Buffer;
  try {
    bytes = readStableRegularFile(recordPath, [stateDirectory]);
  } catch (error) {
    if (error instanceof RegularFileAncestorChangedError) {
      throw new WorkspaceRecordReadUncertainError();
    }
    throw new Error("workspace record is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("workspace record is invalid");
  }

  if (!isWorkspaceRecord(parsed, fingerprint)) {
    throw new Error("workspace record is incompatible with this directory");
  }
}

function writeAtomicWorkspaceRecord(recordPath: string, record: WorkspaceRecord): boolean {
  const stateDirectory = resolve(recordPath, "..");
  const temporaryPath = join(stateDirectory, `.workspace-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      linkSync(temporaryPath, recordPath);
      return true;
    } catch (error) {
      if (existsSync(recordPath)) {
        return false;
      }
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

export function inspectWorkspace(workspaceRoot: string): { initialized: boolean } {
  const root = realpathSync.native(resolve(workspaceRoot));
  const stateDirectory = join(root, ".cu");

  const stateDirectoryStat = lstatOrUndefined(stateDirectory);
  if (stateDirectoryStat === undefined) {
    return { initialized: false };
  }
  if (!stateDirectoryStat.isDirectory() || stateDirectoryStat.isSymbolicLink()) {
    throw new Error("workspace directory is invalid");
  }

  const recordPath = join(stateDirectory, "workspace.json");
  const recordStat = lstatOrUndefined(recordPath);
  if (recordStat === undefined) {
    throw new Error("workspace record is missing");
  }
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw new Error("workspace record is not a regular file");
  }

  validateWorkspaceRecord(recordPath, stateDirectory, workspaceFingerprint(root));
  return { initialized: true };
}

export function initializeWorkspace(workspaceRoot: string): boolean {
  const root = realpathSync.native(resolve(workspaceRoot));
  const stateDirectory = join(root, ".cu");
  const recordPath = join(stateDirectory, "workspace.json");
  const fingerprint = workspaceFingerprint(root);

  const stateDirectoryStat = lstatOrUndefined(stateDirectory);
  if (stateDirectoryStat === undefined) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  } else if (!stateDirectoryStat.isDirectory() || stateDirectoryStat.isSymbolicLink()) {
    throw new Error("workspace directory is invalid");
  }

  const recordStat = lstatOrUndefined(recordPath);
  if (recordStat !== undefined) {
    if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
      throw new Error("workspace record is not a regular file");
    }
    validateWorkspaceRecord(recordPath, stateDirectory, fingerprint);
    return false;
  }

  const created = writeAtomicWorkspaceRecord(recordPath, {
    kind: "cu.workspace/v1",
    schemaVersion: 1,
    rootFingerprint: fingerprint,
    createdAt: new Date().toISOString()
  });

  if (!created) {
    validateWorkspaceRecord(recordPath, stateDirectory, fingerprint);
  }

  return created;
}
