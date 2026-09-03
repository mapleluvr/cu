import { createHash } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  inspectArchiveTransaction,
  inspectArchiveTransactionWithWitness,
  type WitnessedArchiveTransaction,
} from "./archive-store.js";
import { validateCaptureBundleBytes } from "./capture-bundle.js";
import {
  ControlRecordPublicationUncertainError,
  ControlRecordReplacementUncertainError,
  discardStagedControlRecord,
  publishStagedControlRecordCreateOnce,
  replaceWitnessedControlRecord,
  stageValidatedControlRecord,
  type ControlRecordIdentity,
  type StagedControlRecord,
} from "./control-write.js";
import {
  assertEffectSegmentPlanObservation,
  effectJournalPlanFor,
  type EffectSegmentPlan,
} from "./effect-plan.js";
import {
  parseEffectJournalBytes,
  validateEffectJournalLiveBinding,
  type EffectJournal,
  type EffectJournalReason,
} from "./effect-journal.js";
import { parseHistoryEventBytes } from "./history-event.js";
import {
  parseCaptureSidecarBytes,
  parseLiveObservationBytes,
  validateBundleBoundLiveObservation,
  type BundleBoundLiveObservation,
  type CaptureSidecar,
  type LiveObservation,
} from "./observation-record.js";
import {
  assertStableRegularFileWitnessContinuity,
  captureStableAncestorBaseline,
  readStableBinaryFileWithWitness,
  readStableOptionalRegularFileWithWitnessAgainstBaseline,
  readStableRegularFileWithWitness,
  revalidateStableAncestorIdentitiesAgainstBaseline,
  revalidateStableBinaryFileWitness,
  revalidateStableRegularFileWitness,
  type RegularFileStat,
  type StableAncestorBaseline,
  type StableBinaryFileWitness,
  type StableRegularFileWitness,
} from "./regular-file.js";
import { inspectRun } from "./run.js";
import { ttlMsBetween } from "./observation-expiry.js";
import { revalidateRunLock, type RunLock } from "./run-lock.js";

export class EffectAuthorityError extends Error {
  public constructor() {
    super("");
  }
}

export class EffectAuthorityUnavailableError extends EffectAuthorityError {}
export class EffectAuthorityExpiredError extends EffectAuthorityError {}
export class EffectAuthorityEnvironmentChangedError extends EffectAuthorityError {}
export class EffectAuthorityInvalidError extends EffectAuthorityError {}
export class EffectAuthorityUncertainError extends EffectAuthorityError {}
export class EffectJournalInvalidError extends EffectAuthorityInvalidError {}
export class EffectJournalUnresolvedError extends EffectAuthorityError {}

const actAuthorityBrand = Symbol("act authority");
const effectIntentBrand = Symbol("effect intent");
const unresolvedEffectBrand = Symbol("unresolved effect");
const effectArchiveResolutionProofBrand = Symbol(
  "effect archive resolution proof",
);
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const effectIdPattern = /^eff_[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ActAuthority = {
  readonly [actAuthorityBrand]: true;
};

export type EffectIntent = {
  readonly [effectIntentBrand]: true;
};

export type UnresolvedEffect = {
  readonly [unresolvedEffectBrand]: true;
};

export type EffectArchiveResolutionProof = {
  readonly [effectArchiveResolutionProofBrand]: true;
};

export type EffectResolutionDescriptor = Readonly<{
  effectId: string;
  journalSha256: string;
}>;

export type ActInputSource = Readonly<{
  mapping: "normalized_endpoint_centers/v1";
  captureKind: "full" | "region";
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  observationTtlMs: number | null;
}>;

export type InspectActAuthorityOptions = Readonly<{
  observationId: string;
  now: () => Date;
  environmentFingerprint: string;
  topologyFingerprint: string;
}>;

export type BeginEffectIntentOptions = Readonly<{
  effectId: string;
  startedAt: string;
  plan: EffectSegmentPlan;
  now: () => Date;
  environmentFingerprint: string;
  topologyFingerprint: string;
}>;

export type EffectIntentTransition = Readonly<{
  state: "partial" | "indeterminate";
  reason: EffectJournalReason;
  stateChangedAt: string;
}>;

type RunPaths = {
  root: string;
  stateDirectory: string;
  runDirectory: string;
  ancestors: readonly string[];
  runRecordPath: string;
  runIdentityBaseline: StableAncestorBaseline;
  binding: {
    runId: string;
    workspaceFingerprint: string;
  };
  livePath: string;
  journalPath: string;
};

type LiveRecordState = {
  livePath: string;
  liveBytes: Buffer;
  liveSha256: string;
  live: LiveObservation;
  liveWitness: StableRegularFileWitness;
  liveIdentity: ControlRecordIdentity;
  capture?: CaptureSidecar;
  captureBytes?: Buffer;
  captureSha256?: string;
  capturePath?: string;
  captureWitness?: StableRegularFileWitness;
  captureIdentity?: ControlRecordIdentity;
  imageBytes?: Buffer;
  imagePath?: string;
  imageWitness?: StableBinaryFileWitness;
  imageIdentity?: ControlRecordIdentity;
};

type JournalRecordState = {
  bytes: Buffer;
  journal: EffectJournal;
  witness: StableRegularFileWitness;
  identity: ControlRecordIdentity;
};

type ActAuthorityState = {
  paths: RunPaths;
  lock: RunLock;
  live: LiveRecordState & {
    live: BundleBoundLiveObservation;
    capture: CaptureSidecar;
    captureSha256: string;
    captureWitness: StableRegularFileWitness;
    captureIdentity: ControlRecordIdentity;
    imageBytes: Buffer;
    imagePath: string;
    imageWitness: StableBinaryFileWitness;
    imageIdentity: ControlRecordIdentity;
  };
};

type EffectIntentState = {
  paths: RunPaths;
  lock: RunLock;
  effectId: string;
  bytes: Buffer;
  sha256: string;
  identity: ControlRecordIdentity;
  state: "intent" | "partial" | "indeterminate";
  live: LiveRecordState;
};

type RetainedEffectCaptureState = Readonly<{
  capture: CaptureSidecar;
  captureBytes: Buffer;
  captureSha256: string;
  capturePath: string;
  captureWitness: StableRegularFileWitness;
  captureIdentity: ControlRecordIdentity;
  imageBytes: Buffer;
  imagePath: string;
  imageIdentity: ControlRecordIdentity;
  imageSnapshot: RegularFileStat;
}>;

type PredecessorHistoryState = Readonly<{
  path: string;
  completePrefix: Buffer;
  trailing: Buffer;
  identity: ControlRecordIdentity;
  retainedEventLine: Buffer;
  retainedTransactionId: string;
}>;

type EffectArchiveResolutionProofState = Readonly<{
  paths: RunPaths;
  lock: RunLock;
  active: WitnessedArchiveTransaction;
  journal: JournalRecordState | undefined;
  predecessor: RetainedEffectCaptureState;
  predecessorHistory: PredecessorHistoryState;
}>;

const actAuthorities = new WeakMap<ActAuthority, ActAuthorityState>();
const effectIntents = new WeakMap<EffectIntent, EffectIntentState>();
const unresolvedEffects = new WeakMap<UnresolvedEffect, EffectIntentState>();
const effectArchiveResolutionProofs = new WeakMap<
  EffectArchiveResolutionProof,
  EffectArchiveResolutionProofState
>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(
  left: ControlRecordIdentity,
  right: ControlRecordIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function identityAt(path: string): ControlRecordIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new EffectAuthorityInvalidError();
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
  });
}

function regularDirectorySnapshotAt(path: string): RegularFileStat {
  const stat = lstatSync(path, { bigint: true });
  const snapshot: RegularFileStat = Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
  });
  if (!snapshot.isDirectory || snapshot.isFile || snapshot.isSymbolicLink) {
    throw new EffectAuthorityInvalidError();
  }
  return snapshot;
}

function regularFileSnapshotAt(path: string): RegularFileStat {
  const stat = lstatSync(path, { bigint: true });
  const snapshot: RegularFileStat = Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
  });
  if (!snapshot.isFile || snapshot.isDirectory || snapshot.isSymbolicLink) {
    throw new EffectAuthorityInvalidError();
  }
  return snapshot;
}

function sameRegularFileSnapshot(
  left: RegularFileStat,
  right: RegularFileStat,
): boolean {
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function requireCanonicalDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function requireValidOptions(options: InspectActAuthorityOptions): void {
  if (
    options === null ||
    typeof options !== "object" ||
    !observationIdPattern.test(options.observationId) ||
    !requireCanonicalDigest(options.environmentFingerprint) ||
    !requireCanonicalDigest(options.topologyFingerprint) ||
    typeof options.now !== "function"
  ) {
    throw new EffectAuthorityInvalidError();
  }
}

function currentTime(options: Readonly<{ now: () => Date }>): Date {
  try {
    const now = options.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error();
    }
    return new Date(now.getTime());
  } catch {
    throw new EffectAuthorityInvalidError();
  }
}

function inspectPaths(workspaceRoot: string, runId: string): RunPaths {
  try {
    const root = realpathSync.native(resolve(workspaceRoot));
    const stateDirectory = join(root, ".cu");
    const runDirectory = join(stateDirectory, runId);
    const ancestors = Object.freeze([stateDirectory, runDirectory]);
    const runRecordPath = join(runDirectory, "run.json");
    const runIdentityBaseline = captureStableAncestorBaseline(
      runRecordPath,
      ancestors,
    );
    const run = inspectRun(root, runId);
    if (run === undefined) {
      throw new EffectAuthorityUnavailableError();
    }
    revalidateStableAncestorIdentitiesAgainstBaseline(
      runRecordPath,
      ancestors,
      runIdentityBaseline,
    );
    return Object.freeze({
      root,
      stateDirectory,
      runDirectory,
      ancestors,
      runRecordPath,
      runIdentityBaseline,
      binding: Object.freeze({
        runId: run.runId,
        workspaceFingerprint: run.workspaceFingerprint,
      }),
      livePath: join(runDirectory, "live-observation.json"),
      journalPath: join(runDirectory, "effect-journal.json"),
    });
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityInvalidError();
  }
}

function revalidateRunDirectoryIdentity(paths: RunPaths): void {
  try {
    revalidateStableAncestorIdentitiesAgainstBaseline(
      paths.runRecordPath,
      paths.ancestors,
      paths.runIdentityBaseline,
    );
  } catch {
    throw new EffectAuthorityInvalidError();
  }
}

function requireHeldLock(lock: RunLock, paths: RunPaths, runId: string): void {
  try {
    revalidateRunLock(lock, paths.root, runId);
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function requireNoArchiveTransaction(paths: RunPaths): void {
  try {
    revalidateRunDirectoryIdentity(paths);
    if (
      inspectArchiveTransaction(paths.root, paths.binding.runId) !== undefined
    ) {
      throw new EffectAuthorityInvalidError();
    }
    revalidateRunDirectoryIdentity(paths);
  } catch (error) {
    if (error instanceof EffectAuthorityInvalidError) {
      throw error;
    }
    throw new EffectAuthorityInvalidError();
  }
}

function readLiveRecord(paths: RunPaths): LiveRecordState {
  try {
    revalidateRunDirectoryIdentity(paths);
    const runDirectoryBeforeAbsence = regularDirectorySnapshotAt(
      paths.runDirectory,
    );
    try {
      lstatSync(paths.livePath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        let stillMissing = false;
        try {
          lstatSync(paths.livePath);
        } catch (secondError) {
          stillMissing =
            typeof secondError === "object" &&
            secondError !== null &&
            "code" in secondError &&
            (secondError as { code?: unknown }).code === "ENOENT";
        }
        if (!stillMissing) {
          throw new EffectAuthorityUncertainError();
        }
        const runDirectoryAfterAbsence = regularDirectorySnapshotAt(
          paths.runDirectory,
        );
        if (
          !sameRegularFileSnapshot(
            runDirectoryBeforeAbsence,
            runDirectoryAfterAbsence,
          )
        ) {
          throw new EffectAuthorityUncertainError();
        }
        revalidateRunDirectoryIdentity(paths);
        throw new EffectAuthorityUnavailableError();
      }
      throw error;
    }
    const admitted = readStableRegularFileWithWitness(
      paths.livePath,
      paths.ancestors,
    );
    const live = parseLiveObservationBytes(admitted.bytes, paths.binding);
    const base: LiveRecordState = {
      livePath: paths.livePath,
      liveBytes: Buffer.from(admitted.bytes),
      liveSha256: sha256(admitted.bytes),
      live,
      liveWitness: admitted.witness,
      liveIdentity: identityAt(paths.livePath),
    };
    if (live.kind !== "cu.live-observation/v1") {
      revalidateRunDirectoryIdentity(paths);
      return base;
    }
    const capturesDirectory = join(paths.runDirectory, "captures");
    const captureAncestors = Object.freeze([
      ...paths.ancestors,
      capturesDirectory,
    ]);
    const capturePath = join(capturesDirectory, `${live.observationId}.json`);
    const imagePath = join(capturesDirectory, `${live.observationId}.png`);
    const captureAdmitted = readStableRegularFileWithWitness(
      capturePath,
      captureAncestors,
    );
    const imageAdmitted = readStableBinaryFileWithWitness(
      imagePath,
      captureAncestors,
    );
    const capture = parseCaptureSidecarBytes(
      captureAdmitted.bytes,
      paths.binding,
    );
    const captureSha256 = sha256(captureAdmitted.bytes);
    validateBundleBoundLiveObservation(live, capture, captureSha256);
    if (
      sha256(imageAdmitted.bytes) !== live.image.sha256 ||
      imageAdmitted.bytes.length !== live.image.byteLength
    ) {
      throw new EffectAuthorityInvalidError();
    }
    revalidateRunDirectoryIdentity(paths);
    return {
      ...base,
      capture,
      captureBytes: Buffer.from(captureAdmitted.bytes),
      captureSha256,
      capturePath,
      captureWitness: captureAdmitted.witness,
      captureIdentity: identityAt(capturePath),
      imageBytes: Buffer.from(imageAdmitted.bytes),
      imagePath,
      imageWitness: imageAdmitted.witness,
      imageIdentity: identityAt(imagePath),
    };
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityInvalidError();
  }
}

async function readRetainedEffectCapture(
  paths: RunPaths,
  observationId: string,
): Promise<RetainedEffectCaptureState> {
  try {
    if (!observationIdPattern.test(observationId)) {
      throw new Error();
    }
    const capturesDirectory = join(paths.runDirectory, "captures");
    const ancestors = Object.freeze([...paths.ancestors, capturesDirectory]);
    const capturePath = join(capturesDirectory, `${observationId}.json`);
    const imagePath = join(capturesDirectory, `${observationId}.png`);
    const capture = readStableRegularFileWithWitness(capturePath, ancestors);
    const image = readStableBinaryFileWithWitness(imagePath, ancestors);
    const captureIdentity = identityAt(capturePath);
    const imageIdentity = identityAt(imagePath);
    const imageSnapshot = regularFileSnapshotAt(imagePath);
    const validated = await validateCaptureBundleBytes(
      capture.bytes,
      image.bytes,
      paths.binding,
    );
    if (validated.capture.observationId !== observationId) {
      throw new Error();
    }
    revalidateStableRegularFileWitness(capturePath, ancestors, capture.witness);
    revalidateStableBinaryFileWitness(imagePath, ancestors, image.witness);
    if (
      !sameIdentity(captureIdentity, identityAt(capturePath)) ||
      !sameIdentity(imageIdentity, identityAt(imagePath))
    ) {
      throw new Error();
    }
    revalidateRunDirectoryIdentity(paths);
    return Object.freeze({
      capture: validated.capture,
      captureBytes: Buffer.from(capture.bytes),
      captureSha256: sha256(capture.bytes),
      capturePath,
      captureWitness: capture.witness,
      captureIdentity,
      imageBytes: Buffer.from(image.bytes),
      imagePath,
      imageIdentity,
      imageSnapshot,
    });
  } catch {
    throw new EffectAuthorityInvalidError();
  }
}

function revalidateRetainedEffectCapture(
  paths: RunPaths,
  expected: RetainedEffectCaptureState,
): void {
  try {
    const capturesDirectory = join(paths.runDirectory, "captures");
    const ancestors = Object.freeze([...paths.ancestors, capturesDirectory]);
    const capture = readStableRegularFileWithWitness(
      expected.capturePath,
      ancestors,
    );
    const image = readStableBinaryFileWithWitness(
      expected.imagePath,
      ancestors,
    );
    if (
      !capture.bytes.equals(expected.captureBytes) ||
      !sameIdentity(
        expected.captureIdentity,
        identityAt(expected.capturePath),
      ) ||
      !image.bytes.equals(expected.imageBytes) ||
      !sameRegularFileSnapshot(
        expected.imageSnapshot,
        regularFileSnapshotAt(expected.imagePath),
      )
    ) {
      throw new Error();
    }
    assertStableRegularFileWitnessContinuity(
      expected.capturePath,
      ancestors,
      expected.captureWitness,
      capture.witness,
    );
    revalidateRunDirectoryIdentity(paths);
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function readPredecessorHistory(
  paths: RunPaths,
  observationId: string,
  capturedAt: string,
): PredecessorHistoryState {
  try {
    const path = join(paths.runDirectory, "history.ndjson");
    const admitted = readStableBinaryFileWithWitness(path, paths.ancestors);
    if (admitted.bytes.length > 4 * 1024 * 1024) {
      throw new Error();
    }
    let latestCaptureState:
      | Readonly<{
          line: Buffer;
          transactionId: string;
          eventType: "capture_retained" | "capture_evicted" | "capture_cleared";
          capturedAt: string;
        }>
      | undefined;
    let offset = 0;
    let lines = 0;
    while (offset < admitted.bytes.length) {
      const newline = admitted.bytes.indexOf(0x0a, offset);
      if (newline < offset) break;
      if (newline === offset) {
        throw new Error();
      }
      const line = Buffer.from(admitted.bytes.subarray(offset, newline));
      if (line.length > 8_192) throw new Error();
      const event = parseHistoryEventBytes(line, paths.binding);
      if (
        event.eventType !== "effect_recovered" &&
        event.observationId === observationId
      ) {
        latestCaptureState = Object.freeze({
          line,
          transactionId: event.transactionId,
          eventType: event.eventType,
          capturedAt: event.capturedAt,
        });
      }
      lines += 1;
      if (lines > 4_096) throw new Error();
      offset = newline + 1;
    }
    if (
      latestCaptureState === undefined ||
      latestCaptureState.eventType !== "capture_retained" ||
      latestCaptureState.capturedAt !== capturedAt ||
      admitted.bytes.length - offset > 8_192
    ) {
      throw new Error();
    }
    return Object.freeze({
      path,
      completePrefix: Buffer.from(admitted.bytes.subarray(0, offset)),
      trailing: Buffer.from(admitted.bytes.subarray(offset)),
      identity: identityAt(path),
      retainedEventLine: latestCaptureState.line,
      retainedTransactionId: latestCaptureState.transactionId,
    });
  } catch {
    throw new EffectAuthorityInvalidError();
  }
}

function revalidatePredecessorHistory(
  paths: RunPaths,
  expected: PredecessorHistoryState,
  observationId: string,
  capturedAt: string,
): void {
  const current = readPredecessorHistory(paths, observationId, capturedAt);
  const unchangedIncomplete =
    current.completePrefix.length === expected.completePrefix.length &&
    current.trailing.equals(expected.trailing);
  const completedExtension =
    current.completePrefix.length > expected.completePrefix.length &&
    current.trailing.length === 0;
  if (
    !sameIdentity(expected.identity, current.identity) ||
    current.completePrefix.length < expected.completePrefix.length ||
    !current.completePrefix
      .subarray(0, expected.completePrefix.length)
      .equals(expected.completePrefix) ||
    (!unchangedIncomplete && !completedExtension) ||
    current.retainedTransactionId !== expected.retainedTransactionId ||
    !current.retainedEventLine.equals(expected.retainedEventLine)
  ) {
    throw new EffectAuthorityUncertainError();
  }
}

function requirePriorLiveBinding(
  paths: RunPaths,
  predecessor: RetainedEffectCaptureState,
  predecessorHistory: PredecessorHistoryState,
  journal: JournalRecordState,
  priorLiveSha256: string,
): void {
  const capture = predecessor.capture;
  const actionable: BundleBoundLiveObservation = {
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId: paths.binding.runId,
    workspaceFingerprint: paths.binding.workspaceFingerprint,
    observationId: capture.observationId,
    publishedByTransactionId: predecessorHistory.retainedTransactionId,
    captureMetadataSha256: predecessor.captureSha256,
    capturedAt: capture.capturedAt,
    expiresAt: capture.expiresAt,
    coordinateSpace: capture.coordinateSpace,
    source: { ...capture.source },
    environmentFingerprint: capture.environmentFingerprint,
    topologyFingerprint: capture.topologyFingerprint,
    image: { ...capture.image },
    state: "actionable",
    stateChangedAt: capture.capturedAt,
  };
  const normalizedActionable = parseLiveObservationBytes(
    serializeRecord(actionable),
    paths.binding,
  );
  if (normalizedActionable.kind !== "cu.live-observation/v1") {
    throw new EffectAuthorityUncertainError();
  }
  const consumed: BundleBoundLiveObservation = {
    ...normalizedActionable,
    state: "consumed",
    stateChangedAt: journal.journal.createdAt,
    consumedByEffectId: journal.journal.effectId,
  };
  if (
    sha256(serializeRecord(actionable)) !==
      journal.journal.observation.liveRecordSha256 ||
    sha256(serializeRecord(consumed)) !== priorLiveSha256
  ) {
    throw new EffectAuthorityUncertainError();
  }
}

function requireActionableLive(
  state: LiveRecordState,
  observationId: string,
): asserts state is ActAuthorityState["live"] {
  if (
    state.live.kind !== "cu.live-observation/v1" ||
    state.live.state !== "actionable" ||
    state.live.observationId !== observationId ||
    state.capture === undefined ||
    state.captureSha256 === undefined ||
    state.captureWitness === undefined ||
    state.captureIdentity === undefined ||
    state.imageBytes === undefined ||
    state.imagePath === undefined ||
    state.imageWitness === undefined ||
    state.imageIdentity === undefined
  ) {
    throw new EffectAuthorityUnavailableError();
  }
}

function revalidateLiveRecord(state: LiveRecordState): void {
  try {
    const runDirectory = join(state.livePath, "..");
    const stateDirectory = join(runDirectory, "..");
    const ancestors = Object.freeze([stateDirectory, runDirectory]);
    revalidateStableRegularFileWitness(
      state.livePath,
      ancestors,
      state.liveWitness,
    );
    if (
      state.capturePath !== undefined &&
      state.captureWitness !== undefined &&
      state.imagePath !== undefined &&
      state.imageWitness !== undefined
    ) {
      const capturesDirectory = join(runDirectory, "captures");
      const captureAncestors = Object.freeze([...ancestors, capturesDirectory]);
      revalidateStableRegularFileWitness(
        state.capturePath,
        captureAncestors,
        state.captureWitness,
      );
      revalidateStableBinaryFileWitness(
        state.imagePath,
        captureAncestors,
        state.imageWitness,
      );
    }
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function readJournal(paths: RunPaths): JournalRecordState | undefined {
  try {
    revalidateRunDirectoryIdentity(paths);
    const baseline = captureStableAncestorBaseline(
      paths.journalPath,
      paths.ancestors,
    );
    const admitted = readStableOptionalRegularFileWithWitnessAgainstBaseline(
      paths.journalPath,
      paths.ancestors,
      baseline,
    );
    if (admitted === undefined) {
      revalidateRunDirectoryIdentity(paths);
      return undefined;
    }
    const journal = parseEffectJournalBytes(admitted.bytes, paths.binding);
    revalidateRunDirectoryIdentity(paths);
    return Object.freeze({
      bytes: Buffer.from(admitted.bytes),
      journal,
      witness: admitted.witness,
      identity: identityAt(paths.journalPath),
    });
  } catch {
    throw new EffectJournalInvalidError();
  }
}

function validateJournalAgainstLive(
  journal: JournalRecordState,
  live: LiveRecordState,
): void {
  try {
    if (live.live.kind !== "cu.live-observation/v1") {
      throw new Error();
    }
    // The journal is published before the live record becomes consumed. A consumed
    // record therefore proves the same evidence and effect binding while retaining
    // the journal's pre-consume live-record digest.
    const liveRecordSha256 =
      live.live.state === "actionable"
        ? live.liveSha256
        : journal.journal.observation.liveRecordSha256;
    validateEffectJournalLiveBinding(
      journal.journal,
      live.live,
      liveRecordSha256,
    );
  } catch {
    throw new EffectJournalInvalidError();
  }
}

function revalidateJournal(paths: RunPaths, journal: JournalRecordState): void {
  try {
    revalidateStableRegularFileWitness(
      paths.journalPath,
      paths.ancestors,
      journal.witness,
    );
    if (!sameIdentity(journal.identity, identityAt(paths.journalPath))) {
      throw new Error();
    }
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function serializeRecord(record: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function discardStage(stage: StagedControlRecord): void {
  try {
    discardStagedControlRecord(stage);
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function requireSameImmutableBundle(
  expected: LiveRecordState,
  actual: LiveRecordState,
): void {
  if (
    expected.live.kind !== "cu.live-observation/v1" ||
    actual.live.kind !== "cu.live-observation/v1" ||
    expected.live.observationId !== actual.live.observationId ||
    expected.capturePath === undefined ||
    actual.capturePath !== expected.capturePath ||
    expected.captureBytes === undefined ||
    actual.captureBytes === undefined ||
    !expected.captureBytes.equals(actual.captureBytes) ||
    expected.captureIdentity === undefined ||
    actual.captureIdentity === undefined ||
    !sameIdentity(expected.captureIdentity, actual.captureIdentity) ||
    expected.captureSha256 !== actual.captureSha256 ||
    expected.imagePath === undefined ||
    actual.imagePath !== expected.imagePath ||
    expected.imageBytes === undefined ||
    actual.imageBytes === undefined ||
    !expected.imageBytes.equals(actual.imageBytes) ||
    expected.imageIdentity === undefined ||
    actual.imageIdentity === undefined ||
    !sameIdentity(expected.imageIdentity, actual.imageIdentity) ||
    expected.live.image.sha256 !== actual.live.image.sha256 ||
    expected.live.image.byteLength !== actual.live.image.byteLength
  ) {
    throw new EffectAuthorityUncertainError();
  }
}

function requireSameLiveAuthority(
  expected: LiveRecordState,
  actual: LiveRecordState,
): void {
  if (
    !expected.liveBytes.equals(actual.liveBytes) ||
    !sameIdentity(expected.liveIdentity, actual.liveIdentity) ||
    expected.liveSha256 !== actual.liveSha256 ||
    expected.live.kind !== "cu.live-observation/v1" ||
    actual.live.kind !== "cu.live-observation/v1" ||
    expected.live.state !== actual.live.state ||
    expected.live.observationId !== actual.live.observationId
  ) {
    throw new EffectAuthorityUncertainError();
  }
  requireSameImmutableBundle(expected, actual);
}

function replaceLiveRecord(
  lock: RunLock,
  paths: RunPaths,
  expected: LiveRecordState,
  replacement: LiveObservation,
  beforeCutover?: () => void,
): LiveRecordState {
  const candidateBytes = serializeRecord(replacement);
  try {
    parseLiveObservationBytes(candidateBytes, paths.binding);
    revalidateLiveRecord(expected);
    requireHeldLock(lock, paths, paths.binding.runId);
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityInvalidError();
  }

  let staged: StagedControlRecord;
  try {
    staged = stageValidatedControlRecord(
      paths.livePath,
      paths.runDirectory,
      paths.ancestors,
      candidateBytes,
      (bytes) => {
        parseLiveObservationBytes(bytes, paths.binding);
      },
    );
  } catch {
    throw new EffectAuthorityInvalidError();
  }

  let predecessor: LiveRecordState;
  try {
    predecessor = readLiveRecord(paths);
    requireSameLiveAuthority(expected, predecessor);
    revalidateLiveRecord(predecessor);
    requireHeldLock(lock, paths, paths.binding.runId);
    revalidateRunDirectoryIdentity(paths);
    beforeCutover?.();
  } catch (error) {
    discardStage(staged);
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }

  let installedIdentity: ControlRecordIdentity;
  try {
    installedIdentity = replaceWitnessedControlRecord(
      paths.livePath,
      paths.runDirectory,
      paths.ancestors,
      predecessor.liveWitness,
      staged,
    );
  } catch (error) {
    if (error instanceof ControlRecordReplacementUncertainError) {
      throw new EffectAuthorityUncertainError();
    }
    throw new EffectAuthorityInvalidError();
  }

  try {
    const installed = readLiveRecord(paths);
    if (
      !installed.liveBytes.equals(candidateBytes) ||
      !sameIdentity(installed.liveIdentity, installedIdentity)
    ) {
      throw new Error();
    }
    revalidateLiveRecord(installed);
    requireHeldLock(lock, paths, paths.binding.runId);
    revalidateRunDirectoryIdentity(paths);
    return installed;
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function invalidateLive(
  lock: RunLock,
  paths: RunPaths,
  live: LiveRecordState,
  invalidatedReason: "expired" | "environment_changed",
  at: string,
): void {
  if (live.live.kind !== "cu.live-observation/v1") {
    throw new EffectAuthorityUnavailableError();
  }
  try {
    replaceLiveRecord(
      lock,
      paths,
      live,
      {
        kind: "cu.live-observation-tombstone/v1",
        schemaVersion: 1,
        runId: live.live.runId,
        workspaceFingerprint: live.live.workspaceFingerprint,
        observationId: live.live.observationId,
        previousLiveRecordSha256: live.liveSha256,
        invalidatedReason,
        invalidatedAt: at,
        invalidatedByTransactionId: null,
      },
      () => {
        if (readJournal(paths) !== undefined) {
          throw new EffectJournalUnresolvedError();
        }
        requireNoArchiveTransaction(paths);
        requireHeldLock(lock, paths, paths.binding.runId);
        revalidateRunDirectoryIdentity(paths);
      },
    );
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

export async function inspectActAuthority(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  options: InspectActAuthorityOptions,
): Promise<ActAuthority> {
  requireValidOptions(options);
  const paths = inspectPaths(workspaceRoot, runId);
  requireHeldLock(lock, paths, runId);
  requireNoArchiveTransaction(paths);
  const live = readLiveRecord(paths);
  const journal = readJournal(paths);
  if (journal !== undefined) {
    validateJournalAgainstLive(journal, live);
    revalidateJournal(paths, journal);
    revalidateLiveRecord(live);
    requireHeldLock(lock, paths, runId);
    throw new EffectJournalUnresolvedError();
  }
  requireActionableLive(live, options.observationId);

  try {
    await validateCaptureBundleBytes(
      live.captureBytes!,
      live.imageBytes,
      paths.binding,
    );
  } catch {
    throw new EffectAuthorityInvalidError();
  }
  revalidateLiveRecord(live);
  requireHeldLock(lock, paths, runId);

  const now = currentTime(options);
  if (
    live.live.expiresAt !== null &&
    now.getTime() >= new Date(live.live.expiresAt).getTime()
  ) {
    invalidateLive(lock, paths, live, "expired", now.toISOString());
    throw new EffectAuthorityExpiredError();
  }
  if (
    options.environmentFingerprint !== live.live.environmentFingerprint ||
    options.topologyFingerprint !== live.live.topologyFingerprint
  ) {
    invalidateLive(lock, paths, live, "environment_changed", now.toISOString());
    throw new EffectAuthorityEnvironmentChangedError();
  }

  revalidateLiveRecord(live);
  if (readJournal(paths) !== undefined) {
    throw new EffectJournalUnresolvedError();
  }
  requireNoArchiveTransaction(paths);
  requireHeldLock(lock, paths, runId);
  revalidateRunDirectoryIdentity(paths);
  revalidateLiveRecord(live);

  const authority = Object.freeze({
    [actAuthorityBrand]: true,
  }) as ActAuthority;
  actAuthorities.set(authority, {
    paths,
    lock,
    live,
  });
  return authority;
}

function requireAuthority(
  authority: ActAuthority,
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): ActAuthorityState {
  const state = actAuthorities.get(authority);
  if (
    state === undefined ||
    state.paths.binding.runId !== runId ||
    state.lock !== lock
  ) {
    throw new EffectAuthorityInvalidError();
  }
  const requestedRoot = realpathSync.native(resolve(workspaceRoot));
  if (requestedRoot !== state.paths.root) {
    throw new EffectAuthorityInvalidError();
  }
  requireHeldLock(lock, state.paths, runId);
  requireNoArchiveTransaction(state.paths);
  revalidateLiveRecord(state.live);
  if (state.live.live.state !== "actionable") {
    throw new EffectAuthorityUnavailableError();
  }
  if (readJournal(state.paths) !== undefined) {
    throw new EffectJournalUnresolvedError();
  }
  return state;
}

function intentJournalRecord(
  paths: RunPaths,
  live: ActAuthorityState["live"],
  options: BeginEffectIntentOptions,
): EffectJournal {
  if (
    !effectIdPattern.test(options.effectId) ||
    !isCanonicalTimestamp(options.startedAt)
  ) {
    throw new EffectAuthorityInvalidError();
  }
  assertEffectSegmentPlanObservation(options.plan, live.live.observationId);
  const plan = effectJournalPlanFor(options.plan);
  const record: EffectJournal = {
    kind: "cu.effect-journal/v1",
    schemaVersion: 1,
    runId: paths.binding.runId,
    workspaceFingerprint: paths.binding.workspaceFingerprint,
    effectId: options.effectId,
    createdAt: options.startedAt,
    state: "intent",
    stateChangedAt: options.startedAt,
    observation: {
      observationId: live.live.observationId,
      liveRecordSha256: live.liveSha256,
      captureMetadataSha256: live.captureSha256,
      imageSha256: live.live.image.sha256,
      environmentFingerprint: live.live.environmentFingerprint,
      topologyFingerprint: live.live.topologyFingerprint,
    },
    plan,
  };
  parseEffectJournalBytes(serializeRecord(record), paths.binding);
  return record;
}

function publishIntentJournal(
  lock: RunLock,
  state: ActAuthorityState,
  record: EffectJournal,
): JournalRecordState {
  const candidateBytes = serializeRecord(record);
  let staged: StagedControlRecord;
  try {
    staged = stageValidatedControlRecord(
      state.paths.journalPath,
      state.paths.runDirectory,
      state.paths.ancestors,
      candidateBytes,
      (bytes) => {
        parseEffectJournalBytes(bytes, state.paths.binding);
      },
    );
  } catch {
    throw new EffectAuthorityInvalidError();
  }

  try {
    const afterStage = readLiveRecord(state.paths);
    requireSameLiveAuthority(state.live, afterStage);
    revalidateLiveRecord(afterStage);
    if (readJournal(state.paths) !== undefined) {
      throw new EffectJournalUnresolvedError();
    }
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, state.paths.binding.runId);
    revalidateRunDirectoryIdentity(state.paths);
  } catch (error) {
    discardStage(staged);
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }

  let published;
  try {
    published = publishStagedControlRecordCreateOnce(
      state.paths.journalPath,
      state.paths.runDirectory,
      state.paths.ancestors,
      staged,
    );
  } catch (error) {
    if (error instanceof ControlRecordPublicationUncertainError) {
      throw new EffectAuthorityUncertainError();
    }
    throw new EffectAuthorityInvalidError();
  }
  if (published === undefined) {
    throw new EffectAuthorityUncertainError();
  }
  try {
    const journal = parseEffectJournalBytes(
      candidateBytes,
      state.paths.binding,
    );
    return Object.freeze({
      bytes: candidateBytes,
      journal,
      witness: published.witness,
      identity: published.identity,
    });
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function consumeLiveForIntent(
  lock: RunLock,
  state: ActAuthorityState,
  journal: JournalRecordState,
  consumedAt: string,
): LiveRecordState {
  let current: LiveRecordState;
  try {
    const durableJournal = readJournal(state.paths);
    if (
      durableJournal === undefined ||
      !durableJournal.bytes.equals(journal.bytes) ||
      !sameIdentity(durableJournal.identity, journal.identity) ||
      durableJournal.journal.state !== "intent"
    ) {
      throw new EffectAuthorityUncertainError();
    }
    current = readLiveRecord(state.paths);
    requireSameLiveAuthority(state.live, current);
    if (
      current.live.kind !== "cu.live-observation/v1" ||
      current.live.state !== "actionable"
    ) {
      throw new EffectAuthorityUnavailableError();
    }
    validateJournalAgainstLive(durableJournal, current);
    revalidateJournal(state.paths, durableJournal);
    revalidateLiveRecord(current);
    requireHeldLock(lock, state.paths, state.paths.binding.runId);
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }

  const consumed: BundleBoundLiveObservation = {
    ...current.live,
    state: "consumed",
    stateChangedAt: consumedAt,
    consumedByEffectId: journal.journal.effectId,
  };
  try {
    const installed = replaceLiveRecord(
      lock,
      state.paths,
      current,
      consumed,
      () => {
        const durableJournal = readJournal(state.paths);
        if (
          durableJournal === undefined ||
          !durableJournal.bytes.equals(journal.bytes) ||
          !sameIdentity(durableJournal.identity, journal.identity) ||
          durableJournal.journal.state !== "intent"
        ) {
          throw new EffectAuthorityUncertainError();
        }
        revalidateJournal(state.paths, durableJournal);
        requireNoArchiveTransaction(state.paths);
        requireHeldLock(lock, state.paths, state.paths.binding.runId);
        revalidateRunDirectoryIdentity(state.paths);
      },
    );
    requireSameImmutableBundle(current, installed);
    revalidateLiveRecord(installed);
    return installed;
  } catch (error) {
    if (error instanceof EffectAuthorityUncertainError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }
}

function proveJointIntentState(
  lock: RunLock,
  state: ActAuthorityState,
  journal: JournalRecordState,
  consumed: LiveRecordState,
): Readonly<{ journal: JournalRecordState; live: LiveRecordState }> {
  const admitExact = (): Readonly<{
    journal: JournalRecordState;
    live: LiveRecordState;
  }> => {
    const currentJournal = readJournal(state.paths);
    if (
      currentJournal === undefined ||
      !currentJournal.bytes.equals(journal.bytes) ||
      !sameIdentity(currentJournal.identity, journal.identity) ||
      currentJournal.journal.state !== "intent"
    ) {
      throw new Error();
    }
    const currentLive = readLiveRecord(state.paths);
    if (
      !currentLive.liveBytes.equals(consumed.liveBytes) ||
      !sameIdentity(currentLive.liveIdentity, consumed.liveIdentity) ||
      currentLive.live.kind !== "cu.live-observation/v1" ||
      currentLive.live.state !== "consumed" ||
      currentLive.live.consumedByEffectId !== journal.journal.effectId
    ) {
      throw new Error();
    }
    requireSameImmutableBundle(consumed, currentLive);
    validateJournalAgainstLive(currentJournal, currentLive);
    revalidateJournal(state.paths, currentJournal);
    revalidateLiveRecord(currentLive);
    return Object.freeze({ journal: currentJournal, live: currentLive });
  };

  try {
    admitExact();
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, state.paths.binding.runId);
    revalidateRunDirectoryIdentity(state.paths);
    const final = admitExact();
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, state.paths.binding.runId);
    revalidateRunDirectoryIdentity(state.paths);
    revalidateJournal(state.paths, final.journal);
    revalidateLiveRecord(final.live);
    return final;
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

export function actAuthorityInputSource(
  authority: ActAuthority,
): ActInputSource {
  const state = actAuthorities.get(authority);
  if (state === undefined) {
    throw new EffectAuthorityInvalidError();
  }
  return Object.freeze({
    mapping: state.live.capture.source.mapping,
    captureKind: state.live.capture.source.captureKind,
    leftPx: state.live.capture.source.leftPx,
    topPx: state.live.capture.source.topPx,
    widthPx: state.live.capture.source.widthPx,
    heightPx: state.live.capture.source.heightPx,
    observationTtlMs: ttlMsBetween(
      state.live.capture.capturedAt,
      state.live.capture.expiresAt,
    ),
  });
}

export function beginEffectIntent(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  authority: ActAuthority,
  options: BeginEffectIntentOptions,
): EffectIntent {
  let state: ActAuthorityState;
  let record: EffectJournal;
  try {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.now !== "function" ||
      !requireCanonicalDigest(options.environmentFingerprint) ||
      !requireCanonicalDigest(options.topologyFingerprint)
    ) {
      throw new EffectAuthorityInvalidError();
    }
    state = requireAuthority(authority, lock, workspaceRoot, runId);
    actAuthorities.delete(authority);
    const now = currentTime(options);
    if (options.startedAt !== now.toISOString()) {
      throw new EffectAuthorityInvalidError();
    }
    if (
      state.live.live.expiresAt !== null &&
      now.getTime() >= new Date(state.live.live.expiresAt).getTime()
    ) {
      invalidateLive(
        lock,
        state.paths,
        state.live,
        "expired",
        now.toISOString(),
      );
      throw new EffectAuthorityExpiredError();
    }
    if (
      options.environmentFingerprint !==
        state.live.live.environmentFingerprint ||
      options.topologyFingerprint !== state.live.live.topologyFingerprint
    ) {
      invalidateLive(
        lock,
        state.paths,
        state.live,
        "environment_changed",
        now.toISOString(),
      );
      throw new EffectAuthorityEnvironmentChangedError();
    }
    revalidateLiveRecord(state.live);
    if (readJournal(state.paths) !== undefined) {
      throw new EffectJournalUnresolvedError();
    }
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    revalidateLiveRecord(state.live);
    record = intentJournalRecord(state.paths, state.live, options);
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityInvalidError();
  }

  let journal: JournalRecordState;
  try {
    journal = publishIntentJournal(lock, state, record);
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }
  let final: Readonly<{ journal: JournalRecordState; live: LiveRecordState }>;
  try {
    const consumed = consumeLiveForIntent(
      lock,
      state,
      journal,
      options.startedAt,
    );
    final = proveJointIntentState(lock, state, journal, consumed);
  } catch (error) {
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }

  const intent = Object.freeze({ [effectIntentBrand]: true }) as EffectIntent;
  effectIntents.set(intent, {
    paths: state.paths,
    lock,
    effectId: final.journal.journal.effectId,
    bytes: Buffer.from(final.journal.bytes),
    sha256: sha256(final.journal.bytes),
    identity: final.journal.identity,
    state: "intent",
    live: final.live,
  });
  return intent;
}

function requireIntent(
  intent: EffectIntent,
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): EffectIntentState {
  const state = effectIntents.get(intent);
  if (
    state === undefined ||
    state.paths.binding.runId !== runId ||
    state.lock !== lock
  ) {
    throw new EffectAuthorityInvalidError();
  }
  let requestedRoot: string;
  try {
    requestedRoot = realpathSync.native(resolve(workspaceRoot));
  } catch {
    throw new EffectAuthorityInvalidError();
  }
  if (requestedRoot !== state.paths.root) {
    throw new EffectAuthorityInvalidError();
  }
  revalidateRunDirectoryIdentity(state.paths);
  requireHeldLock(lock, state.paths, runId);
  return state;
}

function requireExactIntentJournal(
  paths: RunPaths,
  state: EffectIntentState,
): JournalRecordState {
  const current = readJournal(paths);
  if (
    current === undefined ||
    current.journal.effectId !== state.effectId ||
    sha256(current.bytes) !== state.sha256 ||
    !current.bytes.equals(state.bytes) ||
    !sameIdentity(current.identity, state.identity)
  ) {
    throw new EffectJournalInvalidError();
  }
  return current;
}

function requireExactConsumedLive(
  state: EffectIntentState,
  journal: JournalRecordState,
): LiveRecordState {
  try {
    const current = readLiveRecord(state.paths);
    if (
      !current.liveBytes.equals(state.live.liveBytes) ||
      !sameIdentity(current.liveIdentity, state.live.liveIdentity) ||
      current.live.kind !== "cu.live-observation/v1" ||
      current.live.state !== "consumed" ||
      current.live.consumedByEffectId !== state.effectId
    ) {
      throw new Error();
    }
    requireSameImmutableBundle(state.live, current);
    validateJournalAgainstLive(journal, current);
    revalidateLiveRecord(current);
    return current;
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

export function finalizeCompletedEffectIntent(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  intent: EffectIntent,
): void {
  const state = requireIntent(intent, lock, workspaceRoot, runId);
  if (state.state !== "intent") {
    throw new EffectAuthorityInvalidError();
  }
  try {
    const journal = requireExactIntentJournal(state.paths, state);
    requireExactConsumedLive(state, journal);
    requireNoArchiveTransaction(state.paths);
    revalidateJournal(state.paths, journal);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    if (!sameIdentity(journal.identity, identityAt(state.paths.journalPath))) {
      throw new Error();
    }
    effectIntents.delete(intent);
    unlinkSync(state.paths.journalPath);
    if (readJournal(state.paths) !== undefined) {
      throw new Error();
    }
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
  } catch {
    effectIntents.delete(intent);
    throw new EffectAuthorityUncertainError();
  }
}

export function transitionEffectIntent(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  intent: EffectIntent,
  transition: EffectIntentTransition,
): void {
  const state = requireIntent(intent, lock, workspaceRoot, runId);
  if (
    state.state !== "intent" ||
    transition === null ||
    typeof transition !== "object" ||
    (transition.state !== "partial" && transition.state !== "indeterminate") ||
    !isCanonicalTimestamp(transition.stateChangedAt)
  ) {
    throw new EffectAuthorityInvalidError();
  }
  const allowedReasons = new Set<EffectJournalReason>([
    "helper_lost",
    "input_unproven",
    "cleanup_unproven",
    "checkpoint_capture_failed",
    "checkpoint_publish_failed",
  ]);
  if (!allowedReasons.has(transition.reason)) {
    throw new EffectAuthorityInvalidError();
  }
  const prior = requireExactIntentJournal(state.paths, state);
  if (prior.journal.state !== "intent") {
    throw new EffectJournalInvalidError();
  }
  requireExactConsumedLive(state, prior);
  requireNoArchiveTransaction(state.paths);
  requireHeldLock(lock, state.paths, runId);
  revalidateRunDirectoryIdentity(state.paths);
  const candidateJournal: EffectJournal = {
    ...prior.journal,
    state: transition.state,
    stateChangedAt: transition.stateChangedAt,
    reason: transition.reason,
  };
  const candidateBytes = serializeRecord(candidateJournal);
  try {
    parseEffectJournalBytes(candidateBytes, state.paths.binding);
  } catch {
    throw new EffectAuthorityInvalidError();
  }

  let staged: StagedControlRecord;
  try {
    staged = stageValidatedControlRecord(
      state.paths.journalPath,
      state.paths.runDirectory,
      state.paths.ancestors,
      candidateBytes,
      (bytes) => {
        parseEffectJournalBytes(bytes, state.paths.binding);
      },
    );
  } catch {
    throw new EffectAuthorityInvalidError();
  }

  let predecessor: JournalRecordState;
  try {
    predecessor = requireExactIntentJournal(state.paths, state);
    const live = requireExactConsumedLive(state, predecessor);
    revalidateJournal(state.paths, predecessor);
    revalidateLiveRecord(live);
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
  } catch (error) {
    discardStage(staged);
    if (error instanceof EffectAuthorityError) {
      throw error;
    }
    throw new EffectAuthorityUncertainError();
  }

  let identity: ControlRecordIdentity;
  try {
    identity = replaceWitnessedControlRecord(
      state.paths.journalPath,
      state.paths.runDirectory,
      state.paths.ancestors,
      predecessor.witness,
      staged,
    );
  } catch (error) {
    if (error instanceof ControlRecordReplacementUncertainError) {
      throw new EffectAuthorityUncertainError();
    }
    throw new EffectAuthorityInvalidError();
  }

  try {
    const installed = readJournal(state.paths);
    if (
      installed === undefined ||
      !sameIdentity(installed.identity, identity) ||
      !installed.bytes.equals(candidateBytes) ||
      installed.journal.state !== transition.state ||
      installed.journal.effectId !== state.effectId
    ) {
      throw new Error();
    }
    const live = requireExactConsumedLive(state, installed);
    revalidateJournal(state.paths, installed);
    requireNoArchiveTransaction(state.paths);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    state.bytes = Buffer.from(installed.bytes);
    state.sha256 = sha256(installed.bytes);
    state.identity = installed.identity;
    state.state = transition.state;
    state.live = live;
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

function readLiveBoundToJournal(paths: RunPaths): LiveRecordState {
  try {
    return readLiveRecord(paths);
  } catch (error) {
    if (error instanceof EffectAuthorityUnavailableError) {
      throw new EffectJournalInvalidError();
    }
    throw error;
  }
}

export function inspectUnresolvedEffect(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): UnresolvedEffect | undefined {
  const paths = inspectPaths(workspaceRoot, runId);
  requireHeldLock(lock, paths, runId);
  requireNoArchiveTransaction(paths);
  const journal = readJournal(paths);
  if (journal === undefined) {
    requireNoArchiveTransaction(paths);
    requireHeldLock(lock, paths, runId);
    revalidateRunDirectoryIdentity(paths);
    return undefined;
  }
  const live = readLiveBoundToJournal(paths);
  validateJournalAgainstLive(journal, live);
  revalidateJournal(paths, journal);
  revalidateLiveRecord(live);
  requireNoArchiveTransaction(paths);
  requireHeldLock(lock, paths, runId);
  revalidateRunDirectoryIdentity(paths);
  const finalJournal = readJournal(paths);
  const finalLive = readLiveBoundToJournal(paths);
  if (
    finalJournal === undefined ||
    !finalJournal.bytes.equals(journal.bytes) ||
    !sameIdentity(finalJournal.identity, journal.identity) ||
    !finalLive.liveBytes.equals(live.liveBytes) ||
    !sameIdentity(finalLive.liveIdentity, live.liveIdentity)
  ) {
    throw new EffectAuthorityUncertainError();
  }
  requireSameImmutableBundle(live, finalLive);
  validateJournalAgainstLive(finalJournal, finalLive);
  revalidateJournal(paths, finalJournal);
  revalidateLiveRecord(finalLive);
  requireNoArchiveTransaction(paths);
  requireHeldLock(lock, paths, runId);
  revalidateRunDirectoryIdentity(paths);
  const unresolved = Object.freeze({
    [unresolvedEffectBrand]: true,
  }) as UnresolvedEffect;
  unresolvedEffects.set(unresolved, {
    paths,
    lock,
    effectId: finalJournal.journal.effectId,
    bytes: Buffer.from(finalJournal.bytes),
    sha256: sha256(finalJournal.bytes),
    identity: finalJournal.identity,
    state: finalJournal.journal.state,
    live: finalLive,
  });
  return unresolved;
}

export function revalidateEffectResolutionDescriptor(
  effect: EffectIntent | UnresolvedEffect,
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): EffectResolutionDescriptor {
  const state =
    effectIntents.get(effect as EffectIntent) ??
    unresolvedEffects.get(effect as UnresolvedEffect);
  if (
    state === undefined ||
    state.lock !== lock ||
    state.paths.binding.runId !== runId
  ) {
    throw new EffectAuthorityInvalidError();
  }
  let root: string;
  try {
    root = realpathSync.native(resolve(workspaceRoot));
  } catch {
    throw new EffectAuthorityInvalidError();
  }
  if (root !== state.paths.root) {
    throw new EffectAuthorityInvalidError();
  }
  try {
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    const journal = requireExactIntentJournal(state.paths, state);
    requireExactConsumedLive(state, journal);
    requireNoArchiveTransaction(state.paths);
    revalidateJournal(state.paths, journal);
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    return Object.freeze({
      effectId: state.effectId,
      journalSha256: state.sha256,
    });
  } catch (error) {
    if (error instanceof EffectAuthorityError) throw error;
    throw new EffectAuthorityUncertainError();
  }
}

function retainedCaptureMatchesIntent(
  predecessor: RetainedEffectCaptureState,
  expected: EffectIntentState,
): boolean {
  return (
    expected.live.capturePath === predecessor.capturePath &&
    expected.live.captureBytes !== undefined &&
    expected.live.captureBytes.equals(predecessor.captureBytes) &&
    expected.live.captureIdentity !== undefined &&
    sameIdentity(expected.live.captureIdentity, predecessor.captureIdentity) &&
    expected.live.imagePath === predecessor.imagePath &&
    expected.live.imageBytes !== undefined &&
    expected.live.imageBytes.equals(predecessor.imageBytes) &&
    expected.live.imageIdentity !== undefined &&
    sameIdentity(expected.live.imageIdentity, predecessor.imageIdentity)
  );
}

function requireEffectArchiveResolutionProof(
  proof: EffectArchiveResolutionProof,
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): EffectArchiveResolutionProofState {
  const state = effectArchiveResolutionProofs.get(proof);
  let root: string;
  try {
    root = realpathSync.native(resolve(workspaceRoot));
  } catch {
    throw new EffectAuthorityInvalidError();
  }
  if (
    state === undefined ||
    state.lock !== lock ||
    state.paths.root !== root ||
    state.paths.binding.runId !== runId
  ) {
    throw new EffectAuthorityInvalidError();
  }
  return state;
}

export async function proveEffectArchiveResolution(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  activeTransaction: WitnessedArchiveTransaction,
  expectedEffect?: EffectIntent | UnresolvedEffect,
): Promise<EffectArchiveResolutionProof> {
  const paths = inspectPaths(workspaceRoot, runId);
  const expectedState =
    expectedEffect === undefined
      ? undefined
      : (effectIntents.get(expectedEffect as EffectIntent) ??
        unresolvedEffects.get(expectedEffect as UnresolvedEffect));
  if (
    expectedEffect !== undefined &&
    (expectedState === undefined ||
      expectedState.lock !== lock ||
      expectedState.paths.root !== paths.root ||
      expectedState.paths.binding.runId !== runId)
  ) {
    throw new EffectAuthorityInvalidError();
  }
  try {
    requireHeldLock(lock, paths, runId);
    revalidateRunDirectoryIdentity(paths);
    const transaction = activeTransaction.transaction;
    if (
      transaction.operation !== "publish" ||
      transaction.state === "prepared" ||
      transaction.payload.resolvesEffect === null ||
      transaction.priorLive === null ||
      transaction.payload.replacesObservationId !==
        transaction.priorLive.observationId ||
      transaction.payload.newBundle.observationId ===
        transaction.priorLive.observationId ||
      activeTransaction.recordPath !==
        join(paths.runDirectory, "archive-transaction.json")
    ) {
      throw new Error();
    }
    revalidateStableRegularFileWitness(
      activeTransaction.recordPath,
      activeTransaction.ancestors,
      activeTransaction.witness,
    );
    const admittedActive = inspectArchiveTransactionWithWitness(
      paths.root,
      runId,
    );
    if (
      admittedActive === undefined ||
      admittedActive.recordPath !== activeTransaction.recordPath ||
      JSON.stringify(admittedActive.transaction) !== JSON.stringify(transaction)
    ) {
      throw new Error();
    }
    assertStableRegularFileWitnessContinuity(
      activeTransaction.recordPath,
      activeTransaction.ancestors,
      activeTransaction.witness,
      admittedActive.witness,
    );
    const descriptor = transaction.payload.resolvesEffect;
    const recoveryEvents = transaction.historyEvents.filter(
      (event) => event.eventType === "effect_recovered",
    );
    if (
      recoveryEvents.length !== 1 ||
      recoveryEvents[0]!.effectId !== descriptor.effectId ||
      recoveryEvents[0]!.recoveryObservationId !==
        transaction.payload.newBundle.observationId ||
      (expectedState !== undefined &&
        (expectedState.effectId !== descriptor.effectId ||
          expectedState.sha256 !== descriptor.journalSha256))
    ) {
      throw new Error();
    }

    const journal = readJournal(paths);
    const predecessor = await readRetainedEffectCapture(
      paths,
      transaction.priorLive.observationId,
    );
    const predecessorHistory = readPredecessorHistory(
      paths,
      transaction.priorLive.observationId,
      predecessor.capture.capturedAt,
    );
    if (
      (expectedState !== undefined &&
        (journal === undefined ||
          !journal.bytes.equals(expectedState.bytes) ||
          !sameIdentity(journal.identity, expectedState.identity) ||
          !retainedCaptureMatchesIntent(predecessor, expectedState))) ||
      (journal !== undefined &&
        (journal.journal.effectId !== descriptor.effectId ||
          journal.journal.observation.observationId !==
            transaction.priorLive.observationId ||
          journal.journal.observation.captureMetadataSha256 !==
            predecessor.captureSha256 ||
          journal.journal.observation.imageSha256 !==
            predecessor.capture.image.sha256 ||
          journal.journal.observation.environmentFingerprint !==
            predecessor.capture.environmentFingerprint ||
          journal.journal.observation.topologyFingerprint !==
            predecessor.capture.topologyFingerprint ||
          sha256(journal.bytes) !== descriptor.journalSha256))
    ) {
      throw new Error();
    }
    if (journal !== undefined) {
      requirePriorLiveBinding(
        paths,
        predecessor,
        predecessorHistory,
        journal,
        transaction.priorLive.liveRecordSha256,
      );
    }

    const proof = Object.freeze({
      [effectArchiveResolutionProofBrand]: true,
    }) as EffectArchiveResolutionProof;
    effectArchiveResolutionProofs.set(
      proof,
      Object.freeze({
        paths,
        lock,
        active: admittedActive,
        journal,
        predecessor,
        predecessorHistory,
      }),
    );
    revalidateEffectArchiveResolutionProof(proof, lock, paths.root, runId);
    return proof;
  } catch (error) {
    if (error instanceof EffectAuthorityError) throw error;
    throw new EffectAuthorityUncertainError();
  }
}

export function effectArchiveResolutionJournalPresent(
  proof: EffectArchiveResolutionProof,
): boolean {
  const state = effectArchiveResolutionProofs.get(proof);
  if (state === undefined) {
    throw new EffectAuthorityInvalidError();
  }
  return state.journal !== undefined;
}

export function revalidateEffectArchiveResolutionProof(
  proof: EffectArchiveResolutionProof,
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
): void {
  const state = requireEffectArchiveResolutionProof(
    proof,
    lock,
    workspaceRoot,
    runId,
  );
  try {
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
    const active = inspectArchiveTransactionWithWitness(
      state.paths.root,
      runId,
    );
    if (
      active === undefined ||
      active.recordPath !== state.active.recordPath ||
      JSON.stringify(active.transaction) !==
        JSON.stringify(state.active.transaction)
    ) {
      throw new Error();
    }
    assertStableRegularFileWitnessContinuity(
      state.active.recordPath,
      state.active.ancestors,
      state.active.witness,
      active.witness,
    );
    const journal = readJournal(state.paths);
    if (state.journal === undefined) {
      if (journal !== undefined) throw new Error();
    } else {
      if (
        journal === undefined ||
        !journal.bytes.equals(state.journal.bytes) ||
        !sameIdentity(journal.identity, state.journal.identity)
      ) {
        throw new Error();
      }
      assertStableRegularFileWitnessContinuity(
        state.paths.journalPath,
        state.paths.ancestors,
        state.journal.witness,
        journal.witness,
      );
    }
    revalidateRetainedEffectCapture(state.paths, state.predecessor);
    revalidatePredecessorHistory(
      state.paths,
      state.predecessorHistory,
      state.predecessor.capture.observationId,
      state.predecessor.capture.capturedAt,
    );
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
  } catch (error) {
    if (error instanceof EffectAuthorityError) throw error;
    throw new EffectAuthorityUncertainError();
  }
}

export function finalizeEffectJournalForArchiveTransaction(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  proof: EffectArchiveResolutionProof,
): void {
  const state = requireEffectArchiveResolutionProof(
    proof,
    lock,
    workspaceRoot,
    runId,
  );
  try {
    revalidateEffectArchiveResolutionProof(proof, lock, workspaceRoot, runId);
    const transaction = state.active.transaction;
    if (transaction.operation !== "publish") {
      throw new Error();
    }
    const descriptor = transaction.payload.resolvesEffect;
    if (descriptor === null || transaction.priorLive === null) {
      throw new Error();
    }
    const recoveryEvents = transaction.historyEvents.filter(
      (event) => event.eventType === "effect_recovered",
    );
    if (recoveryEvents.length !== 1) {
      throw new Error();
    }
    const live = readLiveRecord(state.paths);
    if (
      live.live.kind !== "cu.live-observation/v1" ||
      live.live.state !== "actionable" ||
      live.live.observationId !== transaction.payload.newBundle.observationId ||
      live.live.publishedByTransactionId !== transaction.transactionId ||
      live.live.captureMetadataSha256 !==
        transaction.payload.newBundle.captureMetadataSha256 ||
      live.live.image.sha256 !== transaction.payload.newBundle.imageSha256 ||
      live.live.image.byteLength !==
        transaction.payload.newBundle.imageByteLength ||
      sha256(live.liveBytes) !== transaction.payload.newLiveRecordSha256
    ) {
      throw new Error();
    }
    const historyPath = join(state.paths.runDirectory, "history.ndjson");
    const history = readStableBinaryFileWithWitness(
      historyPath,
      state.paths.ancestors,
    );
    if (history.bytes.length > 4 * 1024 * 1024) {
      throw new Error();
    }
    const historyLines: Buffer[] = [];
    let offset = 0;
    while (offset < history.bytes.length) {
      const newline = history.bytes.indexOf(0x0a, offset);
      if (newline < offset || newline === offset) {
        throw new Error();
      }
      historyLines.push(Buffer.from(history.bytes.subarray(offset, newline)));
      offset = newline + 1;
    }
    if (offset !== history.bytes.length || historyLines.length > 4_096) {
      throw new Error();
    }
    const expectedHistoryLines = transaction.historyEvents.map((event) =>
      Buffer.from(
        JSON.stringify({
          kind: "cu.history.event/v1",
          schemaVersion: 1,
          ...event,
          transactionId: transaction.transactionId,
          runId: transaction.runId,
          workspaceFingerprint: transaction.workspaceFingerprint,
        }),
        "utf8",
      ),
    );
    if (expectedHistoryLines.length > historyLines.length) {
      throw new Error();
    }
    const transactionTail = historyLines.slice(
      historyLines.length - expectedHistoryLines.length,
    );
    if (
      transactionTail.some(
        (line, index) => !line.equals(expectedHistoryLines[index]!),
      )
    ) {
      throw new Error();
    }
    const matching = historyLines
      .map((line) => parseHistoryEventBytes(line, state.paths.binding))
      .filter(
        (event) =>
          event.transactionId === transaction.transactionId &&
          event.eventType === "effect_recovered" &&
          event.eventId === recoveryEvents[0]!.eventId &&
          event.at === recoveryEvents[0]!.at &&
          event.effectId === descriptor.effectId &&
          event.recoveryObservationId ===
            transaction.payload.newBundle.observationId,
      );
    if (matching.length !== 1) {
      throw new Error();
    }

    revalidateLiveRecord(live);
    revalidateStableBinaryFileWitness(
      historyPath,
      state.paths.ancestors,
      history.witness,
    );
    revalidateEffectArchiveResolutionProof(proof, lock, workspaceRoot, runId);
    if (state.journal === undefined) {
      return;
    }
    if (
      !sameIdentity(state.journal.identity, identityAt(state.paths.journalPath))
    ) {
      throw new Error();
    }
    unlinkSync(state.paths.journalPath);
    if (readJournal(state.paths) !== undefined) {
      throw new Error();
    }
    requireHeldLock(lock, state.paths, runId);
    revalidateRunDirectoryIdentity(state.paths);
  } catch {
    throw new EffectAuthorityUncertainError();
  }
}

export function effectResolutionDescriptor(
  effect: EffectIntent | UnresolvedEffect,
): EffectResolutionDescriptor {
  const state =
    effectIntents.get(effect as EffectIntent) ??
    unresolvedEffects.get(effect as UnresolvedEffect);
  if (state === undefined) {
    throw new EffectAuthorityInvalidError();
  }
  return Object.freeze({
    effectId: state.effectId,
    journalSha256: state.sha256,
  });
}
