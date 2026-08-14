import {
  closeSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  readStableRegularFileWithWitness,
  revalidateStableRegularFileWitness,
  type StableRegularFileWitness
} from "./regular-file.js";

export class ControlRecordPublicationUncertainError extends Error {}
export class ControlRecordReplacementUncertainError extends Error {}

export type ControlRecordIdentity = {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

const stagedControlRecordBrand = Symbol("staged control record");

export type StagedControlRecord = {
  readonly [stagedControlRecordBrand]: true;
};

export type WitnessedControlRecordPublication = {
  readonly identity: ControlRecordIdentity;
  readonly witness: StableRegularFileWitness;
};

type StagedControlRecordData = {
  path: string;
  targetPath: string;
  parent: string;
  ancestors: readonly string[];
  identity: ControlRecordIdentity;
  witness: StableRegularFileWitness;
  bytes: Buffer;
  validate: (bytes: Buffer) => void;
};

const stagedControlRecords = new WeakMap<StagedControlRecord, StagedControlRecordData>();

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  return normalize(left) === normalize(right);
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => samePath(path, right[index]!));
}

function identityOf(stat: BigIntStats): ControlRecordIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs
  };
}

function isSameIdentity(left: ControlRecordIdentity, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isSameFileId(left: ControlRecordIdentity, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertAdmittedParent(recordPath: string, parentDirectory: string): string {
  const requestedParent = resolve(parentDirectory);
  const requestedRecordParent = dirname(resolve(recordPath));
  const parentStat = lstatSync(requestedParent);
  const recordParentStat = lstatSync(requestedRecordParent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !recordParentStat.isDirectory() ||
    recordParentStat.isSymbolicLink()
  ) {
    throw new Error("control record parent is invalid");
  }
  const canonicalParent = realpathSync.native(requestedParent);
  const canonicalRecordParent = realpathSync.native(requestedRecordParent);
  if (!samePath(canonicalRecordParent, canonicalParent)) {
    throw new Error("control record is not a direct child of its parent");
  }
  return canonicalParent;
}

function removeOwnedTemporary(
  path: string,
  identity: ControlRecordIdentity | undefined
): "absent" | "removed" | "mismatch" {
  if (identity === undefined) return "absent";
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !isSameIdentity(identity, current)) {
      return "mismatch";
    }
    rmSync(path);
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export function writeCreateOnceRecord(
  recordPath: string,
  parentDirectory: string,
  contents: Uint8Array
): boolean {
  return writeCreateOnceRecordWithIdentity(recordPath, parentDirectory, contents) !== undefined;
}

export function writeCreateOnceRecordWithIdentity(
  recordPath: string,
  parentDirectory: string,
  contents: Uint8Array
): ControlRecordIdentity | undefined {
  const canonicalParent = assertAdmittedParent(recordPath, parentDirectory);
  const temporaryPath = join(canonicalParent, `@tmp-${randomUUID()}`);
  let descriptor: number | undefined;
  let temporaryIdentity: ControlRecordIdentity | undefined;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryIdentity = identityOf(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      linkSync(temporaryPath, recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return undefined;
      }
      throw error;
    }

    const installed = lstatSync(recordPath, { bigint: true });
    if (!installed.isFile() || installed.isSymbolicLink() || !isSameIdentity(temporaryIdentity, installed)) {
      throw new Error("control record publication is uncertain");
    }
    return temporaryIdentity;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    removeOwnedTemporary(temporaryPath, temporaryIdentity);
  }
}

export function stageValidatedControlRecord(
  recordPath: string,
  parentDirectory: string,
  ancestors: readonly string[],
  contents: Uint8Array,
  validate: (bytes: Buffer) => void
): StagedControlRecord {
  const canonicalParent = assertAdmittedParent(recordPath, parentDirectory);
  const temporaryPath = join(canonicalParent, `@tmp-${randomUUID()}`);
  let descriptor: number | undefined;
  let identity: ControlRecordIdentity | undefined;
  let prepared = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    identity = identityOf(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const admitted = readStableRegularFileWithWitness(temporaryPath, ancestors);
    validate(admitted.bytes);
    const staged = Object.freeze({ [stagedControlRecordBrand]: true }) as StagedControlRecord;
    stagedControlRecords.set(staged, {
      path: temporaryPath,
      targetPath: resolve(recordPath),
      parent: canonicalParent,
      ancestors: [...ancestors],
      identity,
      witness: admitted.witness,
      bytes: Buffer.from(admitted.bytes),
      validate
    });
    prepared = true;
    return staged;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!prepared) removeOwnedTemporary(temporaryPath, identity);
  }
}

export function discardStagedControlRecord(staged: StagedControlRecord): void {
  const prepared = stagedControlRecords.get(staged);
  if (prepared === undefined) {
    throw new Error("control record staging is invalid");
  }
  try {
    if (removeOwnedTemporary(prepared.path, prepared.identity) === "mismatch") {
      throw new Error("control record staging cleanup is uncertain");
    }
  } finally {
    stagedControlRecords.delete(staged);
  }
}

export function publishStagedControlRecordCreateOnce(
  recordPath: string,
  parentDirectory: string,
  ancestors: readonly string[],
  staged: StagedControlRecord
): WitnessedControlRecordPublication | undefined {
  const canonicalParent = assertAdmittedParent(recordPath, parentDirectory);
  const prepared = stagedControlRecords.get(staged);
  if (
    prepared === undefined ||
    !samePath(prepared.targetPath, resolve(recordPath)) ||
    !samePath(prepared.parent, canonicalParent) ||
    !samePathList(prepared.ancestors, ancestors)
  ) {
    throw new Error("control record staging is invalid");
  }

  let publicationAttempted = false;
  let conflictObserved = false;
  try {
    revalidateStableRegularFileWitness(prepared.path, prepared.ancestors, prepared.witness);
    publicationAttempted = true;
    try {
      linkSync(prepared.path, recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        publicationAttempted = false;
        conflictObserved = true;
        return undefined;
      }
      throw error;
    }

    const installed = lstatSync(recordPath, { bigint: true });
    if (!installed.isFile() || installed.isSymbolicLink() || !isSameIdentity(prepared.identity, installed)) {
      throw new Error("control record publication is uncertain");
    }
    if (removeOwnedTemporary(prepared.path, prepared.identity) !== "removed") {
      throw new Error("control record publication is uncertain");
    }

    const admitted = readStableRegularFileWithWitness(recordPath, ancestors);
    const afterRead = lstatSync(recordPath, { bigint: true });
    if (
      !afterRead.isFile() ||
      afterRead.isSymbolicLink() ||
      !isSameIdentity(prepared.identity, afterRead) ||
      !admitted.bytes.equals(prepared.bytes)
    ) {
      throw new Error("control record publication is uncertain");
    }
    prepared.validate(admitted.bytes);
    revalidateStableRegularFileWitness(recordPath, ancestors, admitted.witness);
    const final = lstatSync(recordPath, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || !isSameIdentity(prepared.identity, final)) {
      throw new Error("control record publication is uncertain");
    }
    const identity = Object.freeze({ ...prepared.identity });
    return Object.freeze({ identity, witness: admitted.witness });
  } catch (error) {
    if (publicationAttempted) {
      throw new ControlRecordPublicationUncertainError();
    }
    throw error;
  } finally {
    stagedControlRecords.delete(staged);
    if (!publicationAttempted) {
      try {
        if (removeOwnedTemporary(prepared.path, prepared.identity) === "mismatch") {
          if (conflictObserved) {
            throw new ControlRecordPublicationUncertainError();
          }
          throw new Error("control record staging cleanup is uncertain");
        }
      } catch (error) {
        if (conflictObserved && !(error instanceof ControlRecordPublicationUncertainError)) {
          throw new ControlRecordPublicationUncertainError();
        }
        throw error;
      }
    }
  }
}

export function replaceWitnessedControlRecord(
  recordPath: string,
  parentDirectory: string,
  ancestors: readonly string[],
  witness: StableRegularFileWitness,
  staged: StagedControlRecord
): ControlRecordIdentity {
  const canonicalParent = assertAdmittedParent(recordPath, parentDirectory);
  const prepared = stagedControlRecords.get(staged);
  if (
    prepared === undefined ||
    !samePath(prepared.targetPath, resolve(recordPath)) ||
    !samePath(prepared.parent, canonicalParent) ||
    !samePathList(prepared.ancestors, ancestors)
  ) {
    throw new Error("control record staging is invalid");
  }
  let cutoverAttempted = false;
  try {
    revalidateStableRegularFileWitness(prepared.path, prepared.ancestors, prepared.witness);
    revalidateStableRegularFileWitness(recordPath, ancestors, witness);
    cutoverAttempted = true;
    renameSync(prepared.path, recordPath);
    const installed = lstatSync(recordPath, { bigint: true });
    if (!installed.isFile() || installed.isSymbolicLink() || !isSameFileId(prepared.identity, installed)) {
      throw new Error("control record replacement is uncertain");
    }
    const installedIdentity = identityOf(installed);
    const admitted = readStableRegularFileWithWitness(recordPath, ancestors);
    const afterRead = lstatSync(recordPath, { bigint: true });
    if (
      !afterRead.isFile() ||
      afterRead.isSymbolicLink() ||
      !isSameIdentity(installedIdentity, afterRead) ||
      !admitted.bytes.equals(prepared.bytes)
    ) {
      throw new Error("control record replacement is uncertain");
    }
    prepared.validate(admitted.bytes);
    revalidateStableRegularFileWitness(recordPath, ancestors, admitted.witness);
    const final = lstatSync(recordPath, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || !isSameIdentity(installedIdentity, final)) {
      throw new Error("control record replacement is uncertain");
    }
    return installedIdentity;
  } catch (error) {
    if (cutoverAttempted) {
      throw new ControlRecordReplacementUncertainError();
    }
    throw error;
  } finally {
    stagedControlRecords.delete(staged);
    if (!cutoverAttempted) {
      removeOwnedTemporary(prepared.path, prepared.identity);
    }
  }
}
