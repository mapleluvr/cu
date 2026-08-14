import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats
} from "node:fs";
import { dirname } from "node:path";

export const MAX_CONTROL_RECORD_BYTES = 65_536;
export const MAX_BINARY_BUNDLE_BYTES = 67_108_864;

export class RegularFileError extends Error {}
export class RegularFileAncestorChangedError extends RegularFileError {}

export type RegularFileStat = {
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

const stableAncestorBaselineBrand = Symbol("stable ancestor baseline");
const stableRegularFileWitnessBrand = Symbol("stable regular file witness");
const stableBinaryFileWitnessBrand = Symbol("stable binary file witness");

export type StableAncestorBaseline = {
  readonly [stableAncestorBaselineBrand]: true;
};

export type StableRegularFileWitness = {
  readonly [stableRegularFileWitnessBrand]: true;
};

export type StableRegularFileRead = {
  bytes: Buffer;
  witness: StableRegularFileWitness;
};

export type StableBinaryFileWitness = {
  readonly [stableBinaryFileWitnessBrand]: true;
};

export type StableBinaryFileRead = {
  bytes: Buffer;
  witness: StableBinaryFileWitness;
};

type StableAncestorBaselineData = {
  recordPath: string;
  ancestors: readonly string[];
  snapshots: readonly RegularFileStat[];
};

type StableRegularFileWitnessData = {
  recordPath: string;
  ancestors: readonly string[];
  recordSnapshot: RegularFileStat;
  ancestorSnapshots: readonly RegularFileStat[];
  bytesSha256: string;
};

type StableRegularFileData = {
  bytes: Buffer;
  recordSnapshot: RegularFileStat;
  ancestorSnapshots: readonly RegularFileStat[];
};

const stableAncestorBaselines = new WeakMap<StableAncestorBaseline, StableAncestorBaselineData>();
const stableRegularFileWitnesses = new WeakMap<
  StableRegularFileWitness,
  StableRegularFileWitnessData
>();
const stableBinaryFileWitnesses = new WeakMap<
  StableBinaryFileWitness,
  StableRegularFileWitnessData
>();

export type RegularFileOps = {
  lstat(path: string): RegularFileStat;
  realpath(path: string): string;
  openRead(path: string): number;
  fstat(descriptor: number): RegularFileStat;
  read(descriptor: number, target: Uint8Array, offset: number, length: number): number;
  close(descriptor: number): void;
};

function projectStat(stat: BigIntStats): RegularFileStat {
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

const defaultOps: RegularFileOps = {
  lstat(path) {
    return projectStat(lstatSync(path, { bigint: true }));
  },
  realpath(path) {
    return realpathSync.native(path);
  },
  openRead(path) {
    return openSync(path, constants.O_RDONLY);
  },
  fstat(descriptor) {
    return projectStat(fstatSync(descriptor, { bigint: true }));
  },
  read(descriptor, target, offset, length) {
    return readSync(descriptor, target, offset, length, null);
  },
  close(descriptor) {
    closeSync(descriptor);
  }
};

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32"
      ? value.replaceAll("/", "\\").toLowerCase()
      : value;
  return normalize(left) === normalize(right);
}

function isRegularFile(stat: RegularFileStat): boolean {
  return stat.isFile && !stat.isDirectory && !stat.isSymbolicLink;
}

function isRegularDirectory(stat: RegularFileStat): boolean {
  return stat.isDirectory && !stat.isSymbolicLink;
}

function sameIdentity(left: RegularFileStat, right: RegularFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameSnapshot(left: RegularFileStat, right: RegularFileStat): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}

function sameIdentityList(
  left: readonly RegularFileStat[],
  right: readonly RegularFileStat[]
): boolean {
  return left.length === right.length && left.every((snapshot, index) => sameIdentity(snapshot, right[index]!));
}

function sameSnapshotList(
  left: readonly RegularFileStat[],
  right: readonly RegularFileStat[]
): boolean {
  return left.length === right.length && left.every((snapshot, index) => sameSnapshot(snapshot, right[index]!));
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never {
  throw new RegularFileError(message);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertDirectAncestorChain(recordPath: string, ancestors: readonly string[]): void {
  if (ancestors.length === 0) {
    fail("state record has no admitted parent");
  }

  let child = recordPath;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (!samePath(dirname(child), ancestors[index])) {
      fail("state ancestor is not a direct parent");
    }
    child = ancestors[index];
  }
}

function captureAncestors(
  ancestors: readonly string[],
  ops: RegularFileOps
): RegularFileStat[] {
  return ancestors.map((ancestor) => {
    const snapshot = ops.lstat(ancestor);
    if (!isRegularDirectory(snapshot) || !samePath(ops.realpath(ancestor), ancestor)) {
      fail("state ancestor is unsafe");
    }
    return snapshot;
  });
}

function assertMatchingAncestors(
  ancestors: readonly string[],
  expected: readonly RegularFileStat[],
  ops: RegularFileOps
): RegularFileStat[] {
  const finalSnapshots = captureAncestors(ancestors, ops);
  if (
    finalSnapshots.length !== expected.length ||
    finalSnapshots.some((snapshot, index) => !sameSnapshot(snapshot, expected[index]))
  ) {
    throw new RegularFileAncestorChangedError("state ancestor changed while reading");
  }
  return finalSnapshots;
}

export function captureStableAncestorBaseline(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): StableAncestorBaseline {
  try {
    assertDirectAncestorChain(recordPath, ancestors);
    const baseline = Object.freeze({ [stableAncestorBaselineBrand]: true }) as StableAncestorBaseline;
    stableAncestorBaselines.set(baseline, {
      recordPath,
      ancestors: [...ancestors],
      snapshots: captureAncestors(ancestors, ops)
    });
    return baseline;
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state ancestor baseline cannot be captured");
  }
}

export function revalidateStableAncestorIdentitiesAgainstBaseline(
  recordPath: string,
  ancestors: readonly string[],
  baseline: StableAncestorBaseline,
  ops: RegularFileOps = defaultOps
): void {
  try {
    const expected = stableAncestorBaselines.get(baseline);
    if (
      expected === undefined ||
      !samePath(expected.recordPath, recordPath) ||
      expected.ancestors.length !== ancestors.length ||
      expected.ancestors.some((ancestor, index) => !samePath(ancestor, ancestors[index] ?? ""))
    ) {
      fail("state ancestor baseline is invalid");
    }
    const current = captureAncestors(ancestors, ops);
    if (
      current.length !== expected.snapshots.length ||
      current.some((snapshot, index) => !sameIdentity(snapshot, expected.snapshots[index]!))
    ) {
      fail("state ancestor identity changed");
    }
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state ancestor identity cannot be revalidated");
  }
}

export function readStableOptionalRegularFileWithWitnessAgainstBaseline(
  recordPath: string,
  ancestors: readonly string[],
  baseline: StableAncestorBaseline,
  ops: RegularFileOps = defaultOps
): StableRegularFileRead | undefined {
  try {
    const expected = stableAncestorBaselines.get(baseline);
    if (
      expected === undefined ||
      !samePath(expected.recordPath, recordPath) ||
      expected.ancestors.length !== ancestors.length ||
      expected.ancestors.some((ancestor, index) => !samePath(ancestor, ancestors[index] ?? ""))
    ) {
      fail("state ancestor baseline is invalid");
    }
    assertMatchingAncestors(ancestors, expected.snapshots, ops);
    const admitted = readStableOptionalRegularFileWithWitness(recordPath, ancestors, ops);
    assertMatchingAncestors(ancestors, expected.snapshots, ops);
    return admitted;
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state record cannot be inspected");
  }
}

export function readStableOptionalRegularFileAgainstBaseline(
  recordPath: string,
  ancestors: readonly string[],
  baseline: StableAncestorBaseline,
  ops: RegularFileOps = defaultOps
): Buffer | undefined {
  return readStableOptionalRegularFileWithWitnessAgainstBaseline(
    recordPath,
    ancestors,
    baseline,
    ops
  )?.bytes;
}

function readStableOptionalRegularFileWithWitness(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): StableRegularFileRead | undefined {
  try {
    assertDirectAncestorChain(recordPath, ancestors);
    const initialAncestors = captureAncestors(ancestors, ops);
    try {
      ops.lstat(recordPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      assertMatchingAncestors(ancestors, initialAncestors, ops);
      return undefined;
    }
    return readStableRegularFileWithWitness(recordPath, ancestors, ops);
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state record cannot be inspected");
  }
}

export function readStableOptionalRegularFile(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): Buffer | undefined {
  return readStableOptionalRegularFileWithWitness(recordPath, ancestors, ops)?.bytes;
}

export function readStableOptionalBinaryFileWithWitnessAgainstBaseline(
  recordPath: string,
  ancestors: readonly string[],
  baseline: StableAncestorBaseline,
  ops: RegularFileOps = defaultOps
): StableBinaryFileRead | undefined {
  try {
    const expected = stableAncestorBaselines.get(baseline);
    if (
      expected === undefined ||
      !samePath(expected.recordPath, recordPath) ||
      expected.ancestors.length !== ancestors.length ||
      expected.ancestors.some((ancestor, index) => !samePath(ancestor, ancestors[index] ?? ""))
    ) {
      fail("state ancestor baseline is invalid");
    }
    assertMatchingAncestors(ancestors, expected.snapshots, ops);
    let status: RegularFileStat;
    try {
      status = ops.lstat(recordPath);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      assertMatchingAncestors(ancestors, expected.snapshots, ops);
      return undefined;
    }
    if (!isRegularFile(status) || !samePath(ops.realpath(recordPath), recordPath)) {
      fail("state record is unsafe");
    }
    const admitted = readStableBinaryFileWithWitness(recordPath, ancestors, ops);
    assertMatchingAncestors(ancestors, expected.snapshots, ops);
    return admitted;
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state binary record cannot be inspected");
  }
}

function readStableRegularFileData(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps,
  maxBytes = MAX_CONTROL_RECORD_BYTES
): StableRegularFileData {
  try {
    assertDirectAncestorChain(recordPath, ancestors);
    const initialAncestors = captureAncestors(ancestors, ops);
    const sampled = ops.lstat(recordPath);
    if (!isRegularFile(sampled) || !samePath(ops.realpath(recordPath), recordPath)) {
      fail("state record is unsafe");
    }
    if (sampled.size < 0n || sampled.size > BigInt(maxBytes)) {
      fail("state record exceeds byte ceiling");
    }

    const expectedLength = Number(sampled.size);
    const descriptor = ops.openRead(recordPath);
    try {
      const opened = ops.fstat(descriptor);
      if (!isRegularFile(opened) || !sameIdentity(sampled, opened) || opened.size !== sampled.size) {
        fail("state record changed before open");
      }

      const bounded = Buffer.alloc(expectedLength + 1);
      let total = 0;
      while (total < bounded.length) {
        const remaining = bounded.length - total;
        const count = ops.read(descriptor, bounded, total, remaining);
        if (!Number.isSafeInteger(count) || count < 0 || count > remaining) {
          fail("state record read count is invalid");
        }
        if (count === 0) break;
        total += count;
      }
      if (total !== expectedLength) {
        fail("state record length changed while reading");
      }

      const finalDescriptor = ops.fstat(descriptor);
      if (!isRegularFile(finalDescriptor) || !sameSnapshot(opened, finalDescriptor)) {
        fail("state record changed while reading");
      }

      const finalPath = ops.lstat(recordPath);
      if (
        !isRegularFile(finalPath) ||
        !sameSnapshot(finalDescriptor, finalPath) ||
        !samePath(ops.realpath(recordPath), recordPath)
      ) {
        fail("state record path changed while reading");
      }
      const finalAncestors = assertMatchingAncestors(ancestors, initialAncestors, ops);
      return {
        bytes: bounded.subarray(0, expectedLength),
        recordSnapshot: finalDescriptor,
        ancestorSnapshots: finalAncestors
      };
    } finally {
      ops.close(descriptor);
    }
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state record cannot be inspected");
  }
}

export function readStableRegularFileWithWitness(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): StableRegularFileRead {
  const admitted = readStableRegularFileData(recordPath, ancestors, ops);
  const witness = Object.freeze({ [stableRegularFileWitnessBrand]: true }) as StableRegularFileWitness;
  stableRegularFileWitnesses.set(witness, {
    recordPath,
    ancestors: [...ancestors],
    recordSnapshot: admitted.recordSnapshot,
    ancestorSnapshots: admitted.ancestorSnapshots,
    bytesSha256: digestBytes(admitted.bytes)
  });
  return { bytes: admitted.bytes, witness };
}

export function revalidateStableRegularFileWitness(
  recordPath: string,
  ancestors: readonly string[],
  witness: StableRegularFileWitness,
  ops: RegularFileOps = defaultOps
): void {
  try {
    const expected = stableRegularFileWitnesses.get(witness);
    if (
      expected === undefined ||
      !samePath(expected.recordPath, recordPath) ||
      expected.ancestors.length !== ancestors.length ||
      expected.ancestors.some((ancestor, index) => !samePath(ancestor, ancestors[index] ?? ""))
    ) {
      fail("state record witness is invalid");
    }
    const current = readStableRegularFileData(recordPath, ancestors, ops);
    if (
      !sameSnapshot(expected.recordSnapshot, current.recordSnapshot) ||
      !sameSnapshotList(expected.ancestorSnapshots, current.ancestorSnapshots) ||
      expected.bytesSha256 !== digestBytes(current.bytes)
    ) {
      fail("state record witness no longer matches");
    }
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state record cannot be inspected");
  }
}

export function readStableBinaryFileWithWitness(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): StableBinaryFileRead {
  const admitted = readStableRegularFileData(
    recordPath,
    ancestors,
    ops,
    MAX_BINARY_BUNDLE_BYTES
  );
  const witness = Object.freeze({
    [stableBinaryFileWitnessBrand]: true
  }) as StableBinaryFileWitness;
  stableBinaryFileWitnesses.set(witness, {
    recordPath,
    ancestors: [...ancestors],
    recordSnapshot: admitted.recordSnapshot,
    ancestorSnapshots: admitted.ancestorSnapshots,
    bytesSha256: digestBytes(admitted.bytes)
  });
  return { bytes: admitted.bytes, witness };
}

export function revalidateStableBinaryFileWitness(
  recordPath: string,
  ancestors: readonly string[],
  witness: StableBinaryFileWitness,
  ops: RegularFileOps = defaultOps
): void {
  try {
    const expected = stableBinaryFileWitnesses.get(witness);
    if (
      expected === undefined ||
      !samePath(expected.recordPath, recordPath) ||
      expected.ancestors.length !== ancestors.length ||
      expected.ancestors.some((ancestor, index) =>
        !samePath(ancestor, ancestors[index] ?? "")
      )
    ) {
      fail("binary file witness is invalid");
    }
    const current = readStableRegularFileData(
      recordPath,
      ancestors,
      ops,
      MAX_BINARY_BUNDLE_BYTES
    );
    if (
      !sameSnapshot(expected.recordSnapshot, current.recordSnapshot) ||
      !sameSnapshotList(expected.ancestorSnapshots, current.ancestorSnapshots) ||
      expected.bytesSha256 !== digestBytes(current.bytes)
    ) {
      fail("binary file witness no longer matches");
    }
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("binary file cannot be inspected");
  }
}

export function assertStableRegularFileWitnessContinuity(
  recordPath: string,
  ancestors: readonly string[],
  initialWitness: StableRegularFileWitness,
  currentWitness: StableRegularFileWitness
): void {
  try {
    const initial = stableRegularFileWitnesses.get(initialWitness);
    const current = stableRegularFileWitnesses.get(currentWitness);
    const hasBinding = (
      witness: StableRegularFileWitnessData | undefined
    ): witness is StableRegularFileWitnessData =>
      witness !== undefined &&
      samePath(witness.recordPath, recordPath) &&
      witness.ancestors.length === ancestors.length &&
      witness.ancestors.every((ancestor, index) =>
        samePath(ancestor, ancestors[index] ?? "")
      );
    if (
      !hasBinding(initial) ||
      !hasBinding(current) ||
      !sameSnapshot(initial.recordSnapshot, current.recordSnapshot) ||
      !sameIdentityList(initial.ancestorSnapshots, current.ancestorSnapshots) ||
      initial.bytesSha256 !== current.bytesSha256
    ) {
      fail("state record witness continuity is invalid");
    }
  } catch (error) {
    if (error instanceof RegularFileError) {
      throw error;
    }
    throw new RegularFileError("state record witness continuity cannot be inspected");
  }
}

export function readStableRegularFile(
  recordPath: string,
  ancestors: readonly string[],
  ops: RegularFileOps = defaultOps
): Buffer {
  return readStableRegularFileData(recordPath, ancestors, ops).bytes;
}
