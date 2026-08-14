import { createHash, randomBytes } from "node:crypto";
import {
  fsyncSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeSync,
  type BigIntStats
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  prepareArchiveTransactionLayout,
  inspectArchiveTransactionLayout
} from "./archive-layout.js";
import {
  ArchiveStorePublicationUncertainError,
  inspectArchiveTransactionWithWitness,
  publishPreparedArchiveTransaction,
  type WitnessedArchiveTransaction
} from "./archive-store.js";
import {
  parseArchiveTransactionBytes,
  type ArchiveBundle,
  type ArchiveHistoryEvent,
  type ArchiveTransaction,
  type ClearAllArchiveTransaction,
  type ClearRangeArchiveTransaction,
  type PublishArchiveTransaction
} from "./archive-transaction.js";
import {
  copyValidatedCaptureBundleBytes,
  validateCaptureBundleBytes,
  type ValidatedCaptureBundle
} from "./capture-bundle.js";
import {
  ControlRecordPublicationUncertainError,
  ControlRecordReplacementUncertainError,
  publishStagedControlRecordCreateOnce,
  replaceWitnessedControlRecord,
  stageValidatedControlRecord,
  writeCreateOnceRecordWithIdentity,
  type ControlRecordIdentity
} from "./control-write.js";
import {
  validateEffectJournalLiveBinding,
  type EffectJournal
} from "./effect-journal.js";
import { parseHistoryEventBytes, type HistoryEvent } from "./history-event.js";
import { isRunId } from "./identifiers.js";
import {
  effectArchiveResolutionJournalPresent,
  finalizeEffectJournalForArchiveTransaction,
  proveEffectArchiveResolution,
  revalidateEffectArchiveResolutionProof,
  revalidateEffectResolutionDescriptor,
  type EffectArchiveResolutionProof,
  type EffectIntent,
  type UnresolvedEffect
} from "./effect-store.js";
import {
  parseLiveObservationBytes,
  validateBundleBoundLiveObservation,
  type BundleBoundLiveObservation,
  type CaptureSidecar,
  type LiveObservation
} from "./observation-record.js";
import {
  assertStableRegularFileWitnessContinuity,
  captureStableAncestorBaseline,
  readStableBinaryFileWithWitness,
  readStableOptionalBinaryFileWithWitnessAgainstBaseline,
  readStableOptionalRegularFileWithWitnessAgainstBaseline,
  readStableRegularFileWithWitness,
  revalidateStableAncestorIdentitiesAgainstBaseline,
  revalidateStableBinaryFileWitness,
  revalidateStableRegularFileWitness,
  type StableAncestorBaseline,
  type StableBinaryFileWitness,
  type StableRegularFileWitness
} from "./regular-file.js";
import { revalidateRunLock, type RunLock } from "./run-lock.js";
import { workspaceFingerprint } from "./workspace.js";

export class ObservationArchiveError extends Error {
  constructor() {
    super("");
  }
}

export class ObservationArchivePublicationUncertainError extends ObservationArchiveError {}
export class ObservationArchiveQuotaError extends ObservationArchiveError {}

export type ObservationRetentionEntry = Readonly<{
  observationId: string;
  capturedAt: string;
  committedBytes: number;
}>;

export type ObservationRetentionLimits = Readonly<{
  maxHistoricalBundles: number;
  maxCommittedBytes: number;
}>;

export type ObservationRetentionPlan = Readonly<{
  evictedObservationIds: readonly string[];
  evictedHistoryCount: number;
}>;

const DEFAULT_RETENTION_LIMITS: ObservationRetentionLimits = Object.freeze({
  maxHistoricalBundles: 128,
  maxCommittedBytes: 536_870_912
});
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function planObservationRetention(
  entries: readonly ObservationRetentionEntry[],
  currentObservationId: string | null,
  newBundleBytes: number,
  limits: ObservationRetentionLimits = DEFAULT_RETENTION_LIMITS
): ObservationRetentionPlan {
  const seen = new Set<string>();
  if (
    !Array.isArray(entries) ||
    !Number.isSafeInteger(newBundleBytes) ||
    newBundleBytes < 0 ||
    !Number.isSafeInteger(limits.maxHistoricalBundles) ||
    limits.maxHistoricalBundles < 0 ||
    !Number.isSafeInteger(limits.maxCommittedBytes) ||
    limits.maxCommittedBytes < 0 ||
    (currentObservationId !== null && !observationIdPattern.test(currentObservationId)) ||
    entries.some((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        !observationIdPattern.test(entry.observationId) ||
        seen.has(entry.observationId) ||
        !canonicalTimestampPattern.test(entry.capturedAt) ||
        new Date(entry.capturedAt).toISOString() !== entry.capturedAt ||
        !Number.isSafeInteger(entry.committedBytes) ||
        entry.committedBytes < 0
      ) {
        return true;
      }
      seen.add(entry.observationId);
      return false;
    }) ||
    (currentObservationId !== null && !seen.has(currentObservationId))
  ) {
    throw new ObservationArchiveError();
  }

  let historicalCount = entries.length;
  let committedBytes = entries.reduce((total, entry) => total + entry.committedBytes, newBundleBytes);
  if (!Number.isSafeInteger(committedBytes)) {
    throw new ObservationArchiveError();
  }
  const eligible = entries
    .filter((entry) => entry.observationId !== currentObservationId)
    .sort((left, right) =>
      left.capturedAt.localeCompare(right.capturedAt) ||
      left.observationId.localeCompare(right.observationId)
    );
  const evictedObservationIds: string[] = [];
  while (
    historicalCount > limits.maxHistoricalBundles ||
    committedBytes > limits.maxCommittedBytes
  ) {
    const selected = eligible.shift();
    if (selected === undefined) {
      throw new ObservationArchiveQuotaError();
    }
    evictedObservationIds.push(selected.observationId);
    historicalCount -= 1;
    committedBytes -= selected.committedBytes;
  }
  return Object.freeze({
    evictedObservationIds: Object.freeze(evictedObservationIds),
    evictedHistoryCount: evictedObservationIds.length
  });
}

export type PublishCaptureObservationOptions = Readonly<{
  createTransactionId?: () => string;
  createHistoryEventId?: (index: number) => string;
  now?: () => Date;
  resolveEffect?: EffectIntent | UnresolvedEffect;
}>;

export type PublishedCaptureObservation = Readonly<{
  observationId: string;
  transactionId: string;
  liveObservationPath: string;
  captureMetadataPath: string;
  imagePath: string;
  historyPath: string;
  evictedHistoryCount: number;
}>;

const transactionIdPattern = /^txn_[a-f0-9]{32}$/;
const historyEventIdPattern = /^hist_[a-f0-9]{32}_[1-9][0-9]{0,3}$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function randomToken(prefix: "txn" | "hist", suffix = ""): string {
  return `${prefix}_${randomBytes(16).toString("hex")}${suffix}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function validatePublishTransactionSemantics(transaction: PublishArchiveTransaction): void {
  const resolvesEffect = transaction.payload.resolvesEffect;
  const expectedEventCount = transaction.movedBundles.length + 1 + (resolvesEffect === null ? 0 : 1);
  if (
    transaction.historyEvents.length !== expectedEventCount ||
    transaction.movedBundles.some((moved) => moved.observationId === transaction.payload.newBundle.observationId)
  ) {
    throw new ObservationArchiveError();
  }
  for (let index = 0; index < transaction.movedBundles.length; index += 1) {
    const event = transaction.historyEvents[index];
    const moved = transaction.movedBundles[index]!;
    if (
      event?.eventType !== "capture_evicted" ||
      event.observationId !== moved.observationId
    ) {
      throw new ObservationArchiveError();
    }
  }
  const retained = transaction.historyEvents[transaction.movedBundles.length];
  if (
    retained?.eventType !== "capture_retained" ||
    retained.observationId !== transaction.payload.newBundle.observationId ||
    (transaction.priorLive === null
      ? transaction.payload.replacesObservationId !== null
      : transaction.payload.replacesObservationId !== transaction.priorLive.observationId)
  ) {
    throw new ObservationArchiveError();
  }
  const recovery = transaction.historyEvents[transaction.movedBundles.length + 1];
  if (
    (resolvesEffect === null && recovery !== undefined) ||
    (resolvesEffect !== null && (
      transaction.priorLive === null ||
      recovery?.eventType !== "effect_recovered" ||
      recovery.effectId !== resolvesEffect.effectId ||
      recovery.recoveryObservationId !== transaction.payload.newBundle.observationId
    ))
  ) {
    throw new ObservationArchiveError();
  }
}

function historyLinesForTransaction(transaction: ArchiveTransaction): Buffer[] {
  return transaction.historyEvents.map((event) => {
    const line = jsonBytes({
      kind: "cu.history.event/v1",
      schemaVersion: 1,
      ...event,
      transactionId: transaction.transactionId,
      runId: transaction.runId,
      workspaceFingerprint: transaction.workspaceFingerprint
    });
    parseHistoryEventBytes(line, {
      runId: transaction.runId,
      workspaceFingerprint: transaction.workspaceFingerprint
    });
    return line;
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
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

type RetainedCapture = Readonly<{
  capture: CaptureSidecar;
  descriptor: ArchiveBundle;
  metadataPath: string;
  imagePath: string;
  metadataWitness: StableRegularFileWitness;
  imageWitness: StableBinaryFileWitness;
  metadataSnapshot: BigIntStats;
  imageSnapshot: BigIntStats;
  committedBytes: number;
}>;

type RetainedArchiveState = Readonly<{
  runDirectory: string;
  runSnapshot: BigIntStats;
  ancestors: readonly string[];
  capturesDirectory: string;
  capturesSnapshot: BigIntStats | null;
  liveObservationPath: string;
  liveBytes: Buffer | null;
  liveSnapshot: BigIntStats | null;
  live: LiveObservation | null;
  currentObservationId: string | null;
  retained: readonly RetainedCapture[];
}>;

export type ObservationArchiveReadCapture = Readonly<{
  observationId: string;
  capturedAt: string;
  coordinateSpace: "normalized_999_top_left";
  imagePath: string;
  committedBytes: number;
}>;

export type ObservationArchiveHistoryState = Readonly<{
  observationId: string;
  capturedAt: string;
  availability: "available" | "unavailable";
  order: number;
}>;

export type ObservationArchiveReadSnapshot = Readonly<{
  retained: readonly ObservationArchiveReadCapture[];
  history: readonly ObservationArchiveHistoryState[];
  currentObservationState: "recorded_actionable" | "consumed" | "tombstone" | "unavailable";
  maxHistoricalBundles: number;
  maxCommittedBytes: number;
}>;

type ObservationArchiveReadAuthority = Readonly<{
  live: LiveObservation | null;
}>;

const observationArchiveReadAuthorities = new WeakMap<
  ObservationArchiveReadSnapshot,
  ObservationArchiveReadAuthority
>();

export function validateObservationArchiveReadSnapshotEffect(
  snapshot: ObservationArchiveReadSnapshot,
  journal: EffectJournal
): void {
  try {
    const authority = observationArchiveReadAuthorities.get(snapshot);
    if (
      authority === undefined ||
      authority.live === null ||
      authority.live.kind !== "cu.live-observation/v1" ||
      authority.live.state !== "consumed"
    ) {
      throw new ObservationArchiveError();
    }
    validateEffectJournalLiveBinding(
      journal,
      authority.live,
      journal.observation.liveRecordSha256
    );
  } catch {
    throw new ObservationArchiveError();
  }
}

function directRunPaths(root: string, runId: string): {
  runDirectory: string;
  ancestors: readonly string[];
} {
  const stateDirectory = join(root, ".cu");
  const runDirectory = join(stateDirectory, runId);
  assertDirectory(stateDirectory);
  assertDirectory(runDirectory);
  const canonicalState = realpathSync.native(stateDirectory);
  const canonicalRun = realpathSync.native(runDirectory);
  if (!samePath(canonicalState, stateDirectory) || !samePath(canonicalRun, runDirectory)) {
    throw new ObservationArchiveError();
  }
  return {
    runDirectory: canonicalRun,
    ancestors: Object.freeze([canonicalState, canonicalRun])
  };
}

function stableFileSnapshot(path: string): BigIntStats {
  const snapshot = lstatSync(path, { bigint: true });
  if (!snapshot.isFile() || snapshot.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  return snapshot;
}

function readOptionalLive(
  path: string,
  ancestors: readonly string[],
  runId: string,
  fingerprint: string
): {
  bytes: Buffer;
  live: LiveObservation;
  witness: StableRegularFileWitness;
  snapshot: BigIntStats;
} | null {
  const baseline = captureStableAncestorBaseline(path, ancestors);
  const admitted = readStableOptionalRegularFileWithWitnessAgainstBaseline(path, ancestors, baseline);
  if (admitted === undefined) {
    return null;
  }
  return {
    bytes: admitted.bytes,
    live: parseLiveObservationBytes(admitted.bytes, {
      runId,
      workspaceFingerprint: fingerprint
    }),
    witness: admitted.witness,
    snapshot: stableFileSnapshot(path)
  };
}

async function inspectRetainedArchive(
  root: string,
  runId: string,
  fingerprint: string,
  allowTemporarilyUnboundLiveObservationId: string | null = null
): Promise<RetainedArchiveState> {
  const { runDirectory, ancestors } = directRunPaths(root, runId);
  const runSnapshot = lstatSync(runDirectory, { bigint: true });
  if (!runSnapshot.isDirectory() || runSnapshot.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  const liveObservationPath = join(runDirectory, "live-observation.json");
  const capturesDirectory = join(runDirectory, "captures");
  let names: string[] = [];
  let capturesSnapshot: BigIntStats | null = null;
  try {
    const status = lstatSync(capturesDirectory, { bigint: true });
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new ObservationArchiveError();
    }
    capturesSnapshot = status;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (capturesSnapshot !== null) {
    assertDirectory(capturesDirectory);
    names = readdirSync(capturesDirectory);
  }

  const pairNames = new Map<string, Set<"json" | "png">>();
  for (const name of names) {
    const match = /^(obs_[a-f0-9]{32})\.(json|png)$/.exec(name);
    if (match === null) {
      throw new ObservationArchiveError();
    }
    const id = match[1]!;
    const extension = match[2]! as "json" | "png";
    const extensions = pairNames.get(id) ?? new Set<"json" | "png">();
    if (extensions.has(extension)) {
      throw new ObservationArchiveError();
    }
    extensions.add(extension);
    pairNames.set(id, extensions);
  }

  const captureAncestors = Object.freeze([...ancestors, capturesDirectory]);
  const retained: RetainedCapture[] = [];
  for (const [id, extensions] of pairNames) {
    if (!extensions.has("json") || !extensions.has("png")) {
      throw new ObservationArchiveError();
    }
    const metadataPath = join(capturesDirectory, `${id}.json`);
    const imagePath = join(capturesDirectory, `${id}.png`);
    const metadata = readStableRegularFileWithWitness(metadataPath, captureAncestors);
    const image = readStableBinaryFileWithWitness(imagePath, captureAncestors);
    const validated = await validateCaptureBundleBytes(metadata.bytes, image.bytes, {
      runId,
      workspaceFingerprint: fingerprint
    });
    const capture = validated.capture;
    if (capture.observationId !== id) {
      throw new ObservationArchiveError();
    }
    retained.push(Object.freeze({
      capture,
      descriptor: Object.freeze({
        observationId: id,
        captureMetadataSha256: sha256(metadata.bytes),
        imageSha256: capture.image.sha256,
        imageByteLength: capture.image.byteLength
      }),
      metadataPath,
      imagePath,
      metadataWitness: metadata.witness,
      imageWitness: image.witness,
      metadataSnapshot: stableFileSnapshot(metadataPath),
      imageSnapshot: stableFileSnapshot(imagePath),
      committedBytes: metadata.bytes.length + image.bytes.length
    }));
  }

  const liveAdmission = readOptionalLive(liveObservationPath, ancestors, runId, fingerprint);
  let currentObservationId: string | null = null;
  if (liveAdmission?.live.kind === "cu.live-observation/v1") {
    currentObservationId = liveAdmission.live.observationId;
    const current = retained.find((entry) => entry.capture.observationId === currentObservationId);
    if (current === undefined) {
      if (allowTemporarilyUnboundLiveObservationId !== currentObservationId) {
        throw new ObservationArchiveError();
      }
    } else {
      validateBundleBoundLiveObservation(
        liveAdmission.live,
        current.capture,
        current.descriptor.captureMetadataSha256
      );
    }
  }

  for (const entry of retained) {
    revalidateStableRegularFileWitness(entry.metadataPath, captureAncestors, entry.metadataWitness);
    revalidateStableBinaryFileWitness(entry.imagePath, captureAncestors, entry.imageWitness);
    if (
      !sameDirectorySnapshot(entry.metadataSnapshot, stableFileSnapshot(entry.metadataPath)) ||
      !sameDirectorySnapshot(entry.imageSnapshot, stableFileSnapshot(entry.imagePath))
    ) {
      throw new ObservationArchiveError();
    }
  }
  if (liveAdmission !== null) {
    revalidateStableRegularFileWitness(
      liveObservationPath,
      ancestors,
      liveAdmission.witness
    );
    if (!sameDirectorySnapshot(liveAdmission.snapshot, stableFileSnapshot(liveObservationPath))) {
      throw new ObservationArchiveError();
    }
  }
  if (capturesSnapshot === null) {
    try {
      lstatSync(capturesDirectory);
      throw new ObservationArchiveError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  } else {
    const finalCaptures = lstatSync(capturesDirectory, { bigint: true });
    if (
      !finalCaptures.isDirectory() ||
      finalCaptures.isSymbolicLink() ||
      !sameDirectorySnapshot(capturesSnapshot, finalCaptures)
    ) {
      throw new ObservationArchiveError();
    }
  }
  const finalRun = lstatSync(runDirectory, { bigint: true });
  if (
    !finalRun.isDirectory() ||
    finalRun.isSymbolicLink() ||
    !sameDirectorySnapshot(runSnapshot, finalRun)
  ) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({
    runDirectory,
    runSnapshot: finalRun,
    ancestors,
    capturesDirectory,
    capturesSnapshot,
    liveObservationPath,
    liveBytes: liveAdmission?.bytes ?? null,
    liveSnapshot: liveAdmission?.snapshot ?? null,
    live: liveAdmission?.live ?? null,
    currentObservationId,
    retained: Object.freeze(retained)
  });
}

export async function inspectObservationArchiveReadSnapshot(
  workspaceRoot: string,
  runId: string
): Promise<ObservationArchiveReadSnapshot> {
  try {
    if (!isRunId(runId)) {
      throw new ObservationArchiveError();
    }
    const fingerprint = workspaceFingerprint(workspaceRoot);
    const initial = await inspectRetainedArchive(workspaceRoot, runId, fingerprint);
    const historyPath = join(initial.runDirectory, "history.ndjson");
    const historyBaseline = captureStableAncestorBaseline(historyPath, initial.ancestors);
    const historyRead = readStableOptionalBinaryFileWithWitnessAgainstBaseline(
      historyPath,
      initial.ancestors,
      historyBaseline
    );
    const inspectedHistory = historyRead === undefined
      ? { ordered: [], trailing: Buffer.alloc(0) }
      : inspectHistoryBytes(historyRead.bytes, runId, fingerprint);
    if (inspectedHistory.trailing.length !== 0) {
      throw new ObservationArchiveError();
    }
    const final = await inspectRetainedArchive(workspaceRoot, runId, fingerprint);
    if (!retainedArchiveStatesMatch(initial, final, null)) {
      throw new ObservationArchiveError();
    }
    if (historyRead === undefined) {
      if (
        readStableOptionalBinaryFileWithWitnessAgainstBaseline(
          historyPath,
          initial.ancestors,
          historyBaseline
        ) !== undefined
      ) {
        throw new ObservationArchiveError();
      }
    } else {
      revalidateStableBinaryFileWitness(historyPath, initial.ancestors, historyRead.witness);
    }

    const latest = new Map<string, { event: Exclude<HistoryEvent, { eventType: "effect_recovered" }>; order: number }>();
    inspectedHistory.ordered.forEach((entry, order) => {
      if (entry.event.eventType !== "effect_recovered") {
        latest.set(entry.event.observationId, { event: entry.event, order });
      }
    });
    const retainedById = new Map(final.retained.map((entry) => [entry.capture.observationId, entry]));
    for (const retained of final.retained) {
      const history = latest.get(retained.capture.observationId);
      if (
        history === undefined ||
        history.event.eventType !== "capture_retained" ||
        history.event.capturedAt !== retained.capture.capturedAt
      ) {
        throw new ObservationArchiveError();
      }
    }
    for (const [observationId, history] of latest) {
      const retained = retainedById.get(observationId);
      if (
        (history.event.eventType === "capture_retained") !== (retained !== undefined) ||
        (retained !== undefined && history.event.capturedAt !== retained.capture.capturedAt)
      ) {
        throw new ObservationArchiveError();
      }
    }

    const retained = Object.freeze(final.retained.map((entry) => Object.freeze({
      observationId: entry.capture.observationId,
      capturedAt: entry.capture.capturedAt,
      coordinateSpace: entry.capture.coordinateSpace,
      imagePath: `.cu/${runId}/captures/${entry.capture.observationId}.png`,
      committedBytes: entry.committedBytes
    })));
    const history = Object.freeze([...latest.entries()].map(([observationId, entry]) => Object.freeze({
      observationId,
      capturedAt: entry.event.capturedAt,
      availability: retainedById.has(observationId) ? "available" as const : "unavailable" as const,
      order: entry.order
    })));
    const live = final.live;
    const currentObservationState = live === null
      ? "unavailable" as const
      : live.kind === "cu.live-observation-tombstone/v1"
        ? "tombstone" as const
        : live.state === "actionable"
          ? "recorded_actionable" as const
          : "consumed" as const;
    const snapshot: ObservationArchiveReadSnapshot = Object.freeze({
      retained,
      history,
      currentObservationState,
      maxHistoricalBundles: DEFAULT_RETENTION_LIMITS.maxHistoricalBundles,
      maxCommittedBytes: DEFAULT_RETENTION_LIMITS.maxCommittedBytes
    });
    observationArchiveReadAuthorities.set(snapshot, Object.freeze({ live }));
    return snapshot;
  } catch {
    throw new ObservationArchiveError();
  }
}

function assertDirectory(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  const canonical = realpathSync.native(path);
  const expected = resolve(path);
  if (process.platform === "win32" ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected) {
    throw new ObservationArchiveError();
  }
}

function ensureDirectory(path: string, parent: string): void {
  assertDirectory(parent);
  if (!samePath(dirname(resolve(path)), resolve(parent))) {
    throw new ObservationArchiveError();
  }
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  assertDirectory(path);
}

function identityAt(path: string): ControlRecordIdentity {
  const status = lstatSync(path, { bigint: true });
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({
    dev: status.dev,
    ino: status.ino,
    birthtimeNs: status.birthtimeNs
  });
}

function sameIdentity(identity: ControlRecordIdentity, path: string): boolean {
  const status = lstatSync(path, { bigint: true });
  return status.isFile() &&
    !status.isSymbolicLink() &&
    identity.dev === status.dev &&
    identity.ino === status.ino &&
    identity.birthtimeNs === status.birthtimeNs;
}

function sameDirectoryIdentity(identity: ControlRecordIdentity, path: string): boolean {
  const status = lstatSync(path, { bigint: true });
  return status.isDirectory() &&
    !status.isSymbolicLink() &&
    identity.dev === status.dev &&
    identity.ino === status.ino &&
    identity.birthtimeNs === status.birthtimeNs;
}

function requireAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new ObservationArchiveError();
}

function createOnceRegularFile(
  path: string,
  parent: string,
  ancestors: readonly string[],
  bytes: Buffer
): ControlRecordIdentity {
  const identity = writeCreateOnceRecordWithIdentity(path, parent, bytes);
  if (identity === undefined) {
    throw new ObservationArchiveError();
  }
  const admitted = readStableRegularFileWithWitness(path, ancestors);
  if (!admitted.bytes.equals(bytes) || !sameIdentity(identity, path)) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({ ...identity });
}

function createOnceBinaryFile(
  path: string,
  parent: string,
  ancestors: readonly string[],
  bytes: Buffer
): ControlRecordIdentity {
  const identity = writeCreateOnceRecordWithIdentity(path, parent, bytes);
  if (identity === undefined) {
    throw new ObservationArchiveError();
  }
  const admitted = readStableBinaryFileWithWitness(path, ancestors);
  if (!admitted.bytes.equals(bytes) || !sameIdentity(identity, path)) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({ ...identity });
}

function publishStagedRegularFile(
  stagedPath: string,
  targetPath: string,
  targetAncestors: readonly string[],
  identity: ControlRecordIdentity,
  bytes: Buffer
): void {
  requireAbsent(targetPath);
  linkSync(stagedPath, targetPath);
  if (!sameIdentity(identity, stagedPath) || !sameIdentity(identity, targetPath)) {
    throw new ObservationArchiveError();
  }
  const admitted = readStableRegularFileWithWitness(targetPath, targetAncestors);
  if (!admitted.bytes.equals(bytes) || !sameIdentity(identity, targetPath)) {
    throw new ObservationArchiveError();
  }
}

function publishStagedBinaryFile(
  stagedPath: string,
  targetPath: string,
  targetAncestors: readonly string[],
  identity: ControlRecordIdentity,
  bytes: Buffer
): void {
  requireAbsent(targetPath);
  linkSync(stagedPath, targetPath);
  if (!sameIdentity(identity, stagedPath) || !sameIdentity(identity, targetPath)) {
    throw new ObservationArchiveError();
  }
  const admitted = readStableBinaryFileWithWitness(targetPath, targetAncestors);
  if (!admitted.bytes.equals(bytes) || !sameIdentity(identity, targetPath)) {
    throw new ObservationArchiveError();
  }
}

type MovedRetainedCapture = Readonly<{
  metadataPath: string;
  imagePath: string;
  metadataIdentity: ControlRecordIdentity;
  imageIdentity: ControlRecordIdentity;
}>;

function moveRetainedCaptureToTrash(
  retained: RetainedCapture,
  captureAncestors: readonly string[],
  trashDirectory: string,
  trashAncestors: readonly string[]
): MovedRetainedCapture {
  const metadata = readStableRegularFileWithWitness(retained.metadataPath, captureAncestors);
  if (sha256(metadata.bytes) !== retained.descriptor.captureMetadataSha256) {
    throw new ObservationArchiveError();
  }
  const image = readStableBinaryFileWithWitness(retained.imagePath, captureAncestors);
  if (
    image.bytes.length !== retained.descriptor.imageByteLength ||
    sha256(image.bytes) !== retained.descriptor.imageSha256
  ) {
    throw new ObservationArchiveError();
  }

  const metadataIdentity = identityAt(retained.metadataPath);
  const imageIdentity = identityAt(retained.imagePath);
  const trashMetadataPath = join(trashDirectory, `${retained.capture.observationId}.json`);
  const trashImagePath = join(trashDirectory, `${retained.capture.observationId}.png`);
  requireAbsent(trashMetadataPath);
  requireAbsent(trashImagePath);

  renameSync(retained.metadataPath, trashMetadataPath);
  requireAbsent(retained.metadataPath);
  const movedMetadata = readStableRegularFileWithWitness(trashMetadataPath, trashAncestors);
  if (!sameIdentity(metadataIdentity, trashMetadataPath) || !movedMetadata.bytes.equals(metadata.bytes)) {
    throw new ObservationArchiveError();
  }

  renameSync(retained.imagePath, trashImagePath);
  requireAbsent(retained.imagePath);
  const movedImage = readStableBinaryFileWithWitness(trashImagePath, trashAncestors);
  if (!sameIdentity(imageIdentity, trashImagePath) || !movedImage.bytes.equals(image.bytes)) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({
    metadataPath: trashMetadataPath,
    imagePath: trashImagePath,
    metadataIdentity,
    imageIdentity
  });
}

function removeOwnedFile(path: string, identity: ControlRecordIdentity): void {
  if (!sameIdentity(identity, path)) {
    throw new ObservationArchiveError();
  }
  rmSync(path);
}

function removeOwnedEmptyDirectory(path: string, identity: ControlRecordIdentity): void {
  const status = lstatSync(path, { bigint: true });
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.dev !== identity.dev ||
    status.ino !== identity.ino ||
    status.birthtimeNs !== identity.birthtimeNs ||
    readdirSync(path).length !== 0
  ) {
    throw new ObservationArchiveError();
  }
  rmdirSync(path);
}

function inspectHistoryBytes(
  bytes: Buffer,
  runId: string,
  fingerprint: string
): {
  byId: Map<string, Buffer>;
  ordered: Array<{ event: HistoryEvent; line: Buffer }>;
  completeLength: number;
  trailing: Buffer;
} {
  if (bytes.length > 4_194_304) {
    throw new ObservationArchiveError();
  }
  const byId = new Map<string, Buffer>();
  const ordered: Array<{ event: HistoryEvent; line: Buffer }> = [];
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) {
      continue;
    }
    const line = Buffer.from(bytes.subarray(lineStart, index + 1));
    if (line.length > 8_192) {
      throw new ObservationArchiveError();
    }
    const event = parseHistoryEventBytes(line, {
      runId,
      workspaceFingerprint: fingerprint
    });
    if (byId.has(event.eventId)) {
      throw new ObservationArchiveError();
    }
    byId.set(event.eventId, line);
    ordered.push({ event, line });
    lineStart = index + 1;
  }
  if (byId.size > 4_096 || bytes.length - lineStart > 8_192) {
    throw new ObservationArchiveError();
  }
  return {
    byId,
    ordered,
    completeLength: lineStart,
    trailing: Buffer.from(bytes.subarray(lineStart))
  };
}

function indexHistoryBytes(
  bytes: Buffer,
  runId: string,
  fingerprint: string
): Map<string, Buffer> {
  const inspected = inspectHistoryBytes(bytes, runId, fingerprint);
  if (inspected.trailing.length !== 0) {
    throw new ObservationArchiveError();
  }
  return inspected.byId;
}

function appendHistoryEvents(
  path: string,
  parent: string,
  ancestors: readonly string[],
  lines: readonly Buffer[],
  runId: string,
  fingerprint: string
): void {
  assertDirectory(parent);
  let existing: Buffer = Buffer.alloc(0);
  let present = true;
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new ObservationArchiveError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    present = false;
  }
  if (present) {
    existing = readStableBinaryFileWithWitness(path, ancestors).bytes;
  }
  const inspected = inspectHistoryBytes(existing, runId, fingerprint);
  const existingById = inspected.byId;
  const expected = lines.map((line) => {
    if (line.length > 8_192) {
      throw new ObservationArchiveError();
    }
    const event = parseHistoryEventBytes(line, {
      runId,
      workspaceFingerprint: fingerprint
    });
    return { eventId: event.eventId, line };
  });
  let presentPrefixLength = 0;
  while (
    presentPrefixLength < expected.length &&
    existingById.has(expected[presentPrefixLength]!.eventId)
  ) {
    presentPrefixLength += 1;
  }
  if (
    expected.slice(presentPrefixLength).some((entry) => existingById.has(entry.eventId)) ||
    presentPrefixLength > inspected.ordered.length
  ) {
    throw new ObservationArchiveError();
  }
  const presentTail = inspected.ordered.slice(inspected.ordered.length - presentPrefixLength);
  for (let index = 0; index < presentPrefixLength; index += 1) {
    const expectedEntry = expected[index]!;
    const actualEntry = presentTail[index]!;
    if (
      actualEntry.event.eventId !== expectedEntry.eventId ||
      !actualEntry.line.equals(expectedEntry.line)
    ) {
      throw new ObservationArchiveError();
    }
  }
  const missing = expected.slice(presentPrefixLength).map((entry) => entry.line);
  const appended = Buffer.concat(missing);
  if (
    inspected.trailing.length > 0 &&
    (
      appended.length <= inspected.trailing.length ||
      !appended.subarray(0, inspected.trailing.length).equals(inspected.trailing)
    )
  ) {
    throw new ObservationArchiveError();
  }
  const existingPrefix = Buffer.from(existing.subarray(0, inspected.completeLength));
  const finalBytes = Buffer.concat([existingPrefix, appended]);
  if (existingById.size + missing.length > 4_096 || finalBytes.length > 4_194_304) {
    throw new ObservationArchiveError();
  }
  if (missing.length === 0) {
    return;
  }
  if (!present) {
    if (writeCreateOnceRecordWithIdentity(path, parent, finalBytes) === undefined) {
      throw new ObservationArchiveError();
    }
  } else {
    const identity = identityAt(path);
    const descriptor = openSync(path, "r+", 0o600);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (
        opened.dev !== identity.dev ||
        opened.ino !== identity.ino ||
        opened.birthtimeNs !== identity.birthtimeNs
      ) {
        throw new ObservationArchiveError();
      }
      if (inspected.trailing.length > 0) {
        ftruncateSync(descriptor, inspected.completeLength);
        fsyncSync(descriptor);
      }
      let written = 0;
      while (written < appended.length) {
        const count = writeSync(
          descriptor,
          appended,
          written,
          appended.length - written,
          inspected.completeLength + written
        );
        if (count <= 0) {
          throw new ObservationArchiveError();
        }
        written += count;
      }
      fsyncSync(descriptor);
      const finalized = fstatSync(descriptor, { bigint: true });
      if (
        finalized.dev !== identity.dev ||
        finalized.ino !== identity.ino ||
        finalized.birthtimeNs !== identity.birthtimeNs
      ) {
        throw new ObservationArchiveError();
      }
    } finally {
      closeSync(descriptor);
    }
  }
  const admitted = readStableBinaryFileWithWitness(path, ancestors);
  if (!admitted.bytes.equals(finalBytes)) {
    throw new ObservationArchiveError();
  }
}

function requireTransactionHistoryComplete(
  path: string,
  ancestors: readonly string[],
  transaction: ArchiveTransaction,
  runId: string,
  fingerprint: string
): void {
  const history = readStableBinaryFileWithWitness(path, ancestors);
  const inspected = inspectHistoryBytes(history.bytes, runId, fingerprint);
  const expected = historyLinesForTransaction(transaction);
  if (
    inspected.trailing.length !== 0 ||
    expected.length > inspected.ordered.length
  ) {
    throw new ObservationArchiveError();
  }
  const tail = inspected.ordered.slice(inspected.ordered.length - expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (!tail[index]!.line.equals(expected[index]!)) {
      throw new ObservationArchiveError();
    }
  }
  revalidateStableBinaryFileWitness(path, ancestors, history.witness);
}

function optionalDirectoryEntries(path: string): string[] | null {
  try {
    const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new ObservationArchiveError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  assertDirectory(path);
  return readdirSync(path).sort();
}

function descriptorMatches(left: ArchiveBundle, right: ArchiveBundle): boolean {
  return left.observationId === right.observationId &&
    left.captureMetadataSha256 === right.captureMetadataSha256 &&
    left.imageSha256 === right.imageSha256 &&
    left.imageByteLength === right.imageByteLength;
}

function retainedArchiveStatesMatch(
  left: RetainedArchiveState,
  right: RetainedArchiveState,
  allowHardLinkCleanupForObservationId: string | null
): boolean {
  if (
    left.runDirectory !== right.runDirectory ||
    left.runSnapshot.dev !== right.runSnapshot.dev ||
    left.runSnapshot.ino !== right.runSnapshot.ino ||
    left.runSnapshot.birthtimeNs !== right.runSnapshot.birthtimeNs ||
    left.currentObservationId !== right.currentObservationId ||
    (left.capturesSnapshot === null) !== (right.capturesSnapshot === null) ||
    (left.capturesSnapshot !== null &&
      !sameDirectorySnapshot(left.capturesSnapshot, right.capturesSnapshot!)) ||
    (left.liveBytes === null) !== (right.liveBytes === null) ||
    (left.liveBytes !== null && !left.liveBytes.equals(right.liveBytes!)) ||
    (left.liveSnapshot === null) !== (right.liveSnapshot === null) ||
    (left.liveSnapshot !== null &&
      !sameDirectorySnapshot(left.liveSnapshot, right.liveSnapshot!)) ||
    left.retained.length !== right.retained.length
  ) {
    return false;
  }
  const rightById = new Map(right.retained.map((entry) => [entry.capture.observationId, entry]));
  return left.retained.every((entry) => {
    const candidate = rightById.get(entry.capture.observationId);
    return candidate !== undefined &&
      descriptorMatches(entry.descriptor, candidate.descriptor) &&
      entry.capture.capturedAt === candidate.capture.capturedAt &&
      entry.committedBytes === candidate.committedBytes &&
      (entry.capture.observationId === allowHardLinkCleanupForObservationId
        ? entry.metadataSnapshot.dev === candidate.metadataSnapshot.dev &&
          entry.metadataSnapshot.ino === candidate.metadataSnapshot.ino &&
          entry.metadataSnapshot.birthtimeNs === candidate.metadataSnapshot.birthtimeNs &&
          entry.imageSnapshot.dev === candidate.imageSnapshot.dev &&
          entry.imageSnapshot.ino === candidate.imageSnapshot.ino &&
          entry.imageSnapshot.birthtimeNs === candidate.imageSnapshot.birthtimeNs
        : sameDirectorySnapshot(entry.metadataSnapshot, candidate.metadataSnapshot) &&
          sameDirectorySnapshot(entry.imageSnapshot, candidate.imageSnapshot));
  });
}

function readOptionalHistory(
  path: string,
  ancestors: readonly string[]
): Buffer | null {
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new ObservationArchiveError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return readStableBinaryFileWithWitness(path, ancestors).bytes;
}

function validateClearTransactionShape(
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  currentObservationId: string | null
): void {
  if (transaction.operation === "clear_range") {
    if (
      transaction.historyEvents.length !== transaction.movedBundles.length ||
      transaction.historyEvents.some((event, index) =>
        event.eventType !== "capture_cleared" ||
        event.observationId !== transaction.movedBundles[index]!.observationId
      ) ||
      (transaction.payload.invalidatesLive &&
        (transaction.priorLive === null ||
          !transaction.payload.selectedObservationIds.includes(
            transaction.priorLive.observationId
          ))) ||
      (!transaction.payload.invalidatesLive &&
        currentObservationId !== null &&
        transaction.payload.selectedObservationIds.includes(currentObservationId))
    ) {
      throw new ObservationArchiveError();
    }
  } else if (
    transaction.historyEvents.length !== 0 ||
    !transaction.payload.deletesLiveRecord
  ) {
    throw new ObservationArchiveError();
  }
}

function validateClearTransactionHistory(
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  runDirectory: string,
  ancestors: readonly string[]
): void {
  const historyPath = join(runDirectory, "history.ndjson");
  const historyBytes = readOptionalHistory(historyPath, ancestors);
  if (historyBytes === null) {
    if (transaction.operation !== "clear_all" || transaction.state !== "cutover_committed") {
      throw new ObservationArchiveError();
    }
    return;
  }
  const inspected = inspectHistoryBytes(
    historyBytes,
    transaction.runId,
    transaction.workspaceFingerprint
  );
  const latestExternalCapture = new Map<string, Exclude<HistoryEvent, { eventType: "effect_recovered" }>>();
  for (const { event } of inspected.ordered) {
    if (event.eventType !== "effect_recovered" && event.transactionId !== transaction.transactionId) {
      latestExternalCapture.set(event.observationId, event);
    }
  }

  if (transaction.operation === "clear_range") {
    transaction.historyEvents.forEach((event, index) => {
      if (event.eventType !== "capture_cleared") {
        throw new ObservationArchiveError();
      }
      const prior = latestExternalCapture.get(event.observationId);
      if (
        prior === undefined ||
        prior.eventType !== "capture_retained" ||
        prior.capturedAt !== event.capturedAt ||
        transaction.movedBundles[index]!.observationId !== event.observationId
      ) {
        throw new ObservationArchiveError();
      }
    });
    return;
  }

  const retainedIds = [...latestExternalCapture.values()]
    .filter((event) => event.eventType === "capture_retained")
    .map((event) => event.observationId)
    .sort();
  const selectedIds = [...transaction.payload.selectedObservationIds].sort();
  if (retainedIds.join("\0") !== selectedIds.join("\0")) {
    throw new ObservationArchiveError();
  }
}

function validateClearTransactionSemantics(
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  state: RetainedArchiveState
): void {
  validateClearTransactionShape(transaction, state.currentObservationId);
  validateClearTransactionHistory(transaction, state.runDirectory, state.ancestors);
}

function compactHistoryLines(
  ordered: readonly { event: HistoryEvent; line: Buffer }[],
  state: RetainedArchiveState
): Buffer {
  const latestCaptureByObservation = new Map<
    string,
    { event: Exclude<HistoryEvent, { eventType: "effect_recovered" }>; line: Buffer; index: number }
  >();
  ordered.forEach((entry, index) => {
    if (entry.event.eventType !== "effect_recovered") {
      latestCaptureByObservation.set(entry.event.observationId, {
        event: entry.event,
        line: entry.line,
        index
      });
    }
  });

  const retainedIds = new Set(state.retained.map((entry) => entry.capture.observationId));
  const selected: Array<{ line: Buffer; index: number }> = [];
  for (const retained of state.retained) {
    const latest = latestCaptureByObservation.get(retained.capture.observationId);
    if (
      latest === undefined ||
      latest.event.eventType !== "capture_retained" ||
      latest.event.capturedAt !== retained.capture.capturedAt
    ) {
      throw new ObservationArchiveError();
    }
    selected.push({ line: latest.line, index: latest.index });
  }

  const unavailable: Array<{ line: Buffer; index: number }> = [];
  for (const [observationId, latest] of latestCaptureByObservation) {
    if (retainedIds.has(observationId)) {
      continue;
    }
    if (latest.event.eventType === "capture_retained") {
      throw new ObservationArchiveError();
    }
    unavailable.push({ line: latest.line, index: latest.index });
  }
  unavailable.sort((left, right) => left.index - right.index);
  selected.push(...unavailable.slice(-512));
  selected.sort((left, right) => left.index - right.index);
  return Buffer.concat(selected.map((entry) => entry.line));
}

function replaceHistoryWithCompactedBytes(
  path: string,
  parent: string,
  ancestors: readonly string[],
  expectedBytes: Buffer,
  compactedBytes: Buffer,
  runId: string,
  fingerprint: string,
  revalidateAuthority: () => void
): void {
  if (readdirSync(parent).some((name) => name.startsWith("@history-compact-"))) {
    throw new ObservationArchiveError();
  }
  const stagedPath = join(parent, `@history-compact-${randomBytes(16).toString("hex")}`);
  let descriptor: number | undefined;
  let stageCreated = false;
  let stagedIdentity: ControlRecordIdentity | undefined;
  let renameAttempted = false;
  try {
    descriptor = openSync(stagedPath, "wx", 0o600);
    stageCreated = true;
    const opened = fstatSync(descriptor, { bigint: true });
    stagedIdentity = Object.freeze({
      dev: opened.dev,
      ino: opened.ino,
      birthtimeNs: opened.birthtimeNs
    });
    let written = 0;
    while (written < compactedBytes.length) {
      const count = writeSync(
        descriptor,
        compactedBytes,
        written,
        compactedBytes.length - written,
        written
      );
      if (count <= 0) {
        throw new ObservationArchiveError();
      }
      written += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    const staged = readStableBinaryFileWithWitness(stagedPath, ancestors);
    if (!staged.bytes.equals(compactedBytes) || !sameIdentity(stagedIdentity, stagedPath)) {
      throw new ObservationArchiveError();
    }
    const parsedCompacted = inspectHistoryBytes(compactedBytes, runId, fingerprint);
    if (parsedCompacted.trailing.length !== 0) {
      throw new ObservationArchiveError();
    }
    const predecessor = readStableBinaryFileWithWitness(path, ancestors);
    if (!predecessor.bytes.equals(expectedBytes)) {
      throw new ObservationArchiveError();
    }
    revalidateStableBinaryFileWitness(stagedPath, ancestors, staged.witness);
    revalidateStableBinaryFileWitness(path, ancestors, predecessor.witness);
    revalidateAuthority();

    renameAttempted = true;
    renameSync(stagedPath, path);
    const installed = identityAt(path);
    if (installed.dev !== stagedIdentity.dev || installed.ino !== stagedIdentity.ino) {
      throw new ObservationArchivePublicationUncertainError();
    }
    const admitted = readStableBinaryFileWithWitness(path, ancestors);
    if (!admitted.bytes.equals(compactedBytes) || !sameIdentity(installed, path)) {
      throw new ObservationArchivePublicationUncertainError();
    }
    revalidateStableBinaryFileWitness(path, ancestors, admitted.witness);
    revalidateAuthority();
    if (!sameIdentity(installed, path)) {
      throw new ObservationArchivePublicationUncertainError();
    }
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (!renameAttempted && stagedIdentity !== undefined) {
      try {
        removeOwnedFile(stagedPath, stagedIdentity);
      } catch {
        throw new ObservationArchivePublicationUncertainError();
      }
    }
    if (
      (stageCreated && stagedIdentity === undefined) ||
      renameAttempted ||
      error instanceof ObservationArchivePublicationUncertainError
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    throw error;
  }
}

function requireHistoryCapacityBeforePrepared(
  transaction: ArchiveTransaction,
  state: RetainedArchiveState,
  revalidateAuthority: () => void
): boolean {
  const historyPath = join(state.runDirectory, "history.ndjson");
  if (readdirSync(state.runDirectory).some((name) => name.startsWith("@history-compact-"))) {
    throw new ObservationArchiveError();
  }
  const history = readOptionalHistory(historyPath, state.ancestors);
  const nextLines = historyLinesForTransaction(transaction);
  const appendedBytes = nextLines.reduce((total, line) => total + line.length, 0);
  if (history === null) {
    if (nextLines.length > 4_096 || appendedBytes > 4_194_304) {
      throw new ObservationArchiveQuotaError();
    }
    return false;
  }
  const indexed = inspectHistoryBytes(
    history,
    transaction.runId,
    transaction.workspaceFingerprint
  );
  if (indexed.trailing.length !== 0) {
    throw new ObservationArchiveError();
  }
  if (transaction.historyEvents.some((event) => indexed.byId.has(event.eventId))) {
    throw new ObservationArchiveError();
  }
  if (
    indexed.byId.size + nextLines.length <= 4_096 &&
    history.length + appendedBytes <= 4_194_304
  ) {
    return false;
  }

  const compacted = compactHistoryLines(indexed.ordered, state);
  const compactedIndex = inspectHistoryBytes(
    compacted,
    transaction.runId,
    transaction.workspaceFingerprint
  );
  if (
    compactedIndex.byId.size + nextLines.length > 4_096 ||
    compacted.length + appendedBytes > 4_194_304
  ) {
    throw new ObservationArchiveQuotaError();
  }
  replaceHistoryWithCompactedBytes(
    historyPath,
    state.runDirectory,
    state.ancestors,
    history,
    compacted,
    transaction.runId,
    transaction.workspaceFingerprint,
    revalidateAuthority
  );
  return true;
}

function requireTransactionHistoryAbsent(
  transaction: ArchiveTransaction,
  state: Pick<RetainedArchiveState, "runDirectory" | "ancestors">
): void {
  const historyPath = join(state.runDirectory, "history.ndjson");
  const history = readOptionalHistory(historyPath, state.ancestors);
  if (history === null) {
    return;
  }
  const indexed = indexHistoryBytes(history, transaction.runId, transaction.workspaceFingerprint);
  if (transaction.historyEvents.some((event) => indexed.has(event.eventId))) {
    throw new ObservationArchiveError();
  }
}

function requireNoPrivateTransactionState(
  transaction: ArchiveTransaction,
  state: RetainedArchiveState
): void {
  const archiveDirectory = join(state.runDirectory, "@archive");
  const archiveEntries = optionalDirectoryEntries(archiveDirectory);
  if (archiveEntries !== null && archiveEntries.length !== 0) {
    throw new ObservationArchiveError();
  }
  const transactionDirectory = join(archiveDirectory, transaction.transactionId);
  if (optionalDirectoryEntries(transactionDirectory) !== null) {
    throw new ObservationArchiveError();
  }
}

type ProvenPrivateDirectory = Readonly<{
  path: string;
  snapshot: BigIntStats;
  entries: readonly string[];
}>;

type ProvenPrivateFile = Readonly<{
  path: string;
  ancestors: readonly string[];
  ancestorIdentities: readonly Readonly<{ path: string; identity: ControlRecordIdentity }>[];
  identity: ControlRecordIdentity;
  snapshot: BigIntStats;
  bytes: Buffer;
  bytesSha256: string;
  witness: StableRegularFileWitness | StableBinaryFileWitness;
  kind: "regular" | "binary";
}>;

type PrivatePublishProof = Readonly<{
  directories: readonly ProvenPrivateDirectory[];
  absentDirectories: readonly string[];
  files: readonly ProvenPrivateFile[];
  transactionDirectory: string | null;
  stagingDirectory: string | null;
  trashDirectory: string | null;
}>;

function admitOptionalPrivateDirectory(path: string): ProvenPrivateDirectory | null {
  let initial: BigIntStats;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  assertDirectory(path);
  const entries = readdirSync(path).sort();
  const final = lstatSync(path, { bigint: true });
  if (
    !final.isDirectory() ||
    final.isSymbolicLink() ||
    !sameDirectorySnapshot(initial, final)
  ) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({ path, snapshot: final, entries: Object.freeze(entries) });
}

function privateFileIdentity(path: string): ControlRecordIdentity {
  const identity = identityAt(path);
  if (!sameIdentity(identity, path)) {
    throw new ObservationArchiveError();
  }
  return identity;
}

function directoryIdentity(path: string): ControlRecordIdentity {
  const status = lstatSync(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({
    dev: status.dev,
    ino: status.ino,
    birthtimeNs: status.birthtimeNs
  });
}

function provePrivateFile(
  path: string,
  ancestors: readonly string[],
  bytes: Buffer,
  witness: StableRegularFileWitness | StableBinaryFileWitness,
  kind: "regular" | "binary"
): ProvenPrivateFile {
  const snapshot = lstatSync(path, { bigint: true });
  if (!snapshot.isFile() || snapshot.isSymbolicLink()) {
    throw new ObservationArchiveError();
  }
  return Object.freeze({
    path,
    ancestors,
    ancestorIdentities: Object.freeze(ancestors.map((ancestor) => Object.freeze({
      path: ancestor,
      identity: directoryIdentity(ancestor)
    }))),
    identity: privateFileIdentity(path),
    snapshot,
    bytes: Buffer.from(bytes),
    bytesSha256: sha256(bytes),
    witness,
    kind
  });
}

function revalidatePrivatePublishProof(
  proof: PrivatePublishProof,
  mode: "full" | "identity-continuity" = "full"
): void {
  for (const path of proof.absentDirectories) {
    try {
      lstatSync(path);
      throw new ObservationArchiveError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const directory of proof.directories) {
    const status = lstatSync(directory.path, { bigint: true });
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      !sameDirectorySnapshot(directory.snapshot, status) ||
      readdirSync(directory.path).sort().join("\0") !== directory.entries.join("\0")
    ) {
      throw new ObservationArchiveError();
    }
  }
  for (const file of proof.files) {
    if (mode === "full") {
      if (file.kind === "regular") {
        revalidateStableRegularFileWitness(
          file.path,
          file.ancestors,
          file.witness as StableRegularFileWitness
        );
      } else {
        revalidateStableBinaryFileWitness(
          file.path,
          file.ancestors,
          file.witness as StableBinaryFileWitness
        );
      }
    } else {
      const admitted = file.kind === "regular"
        ? readStableRegularFileWithWitness(file.path, file.ancestors)
        : readStableBinaryFileWithWitness(file.path, file.ancestors);
      const currentSnapshot = lstatSync(file.path, { bigint: true });
      if (
        sha256(admitted.bytes) !== file.bytesSha256 ||
        !sameDirectorySnapshot(file.snapshot, currentSnapshot) ||
        file.ancestorIdentities.some((ancestor) => {
          const current = directoryIdentity(ancestor.path);
          return current.dev !== ancestor.identity.dev ||
            current.ino !== ancestor.identity.ino ||
            current.birthtimeNs !== ancestor.identity.birthtimeNs;
        })
      ) {
        throw new ObservationArchiveError();
      }
    }
    if (!sameIdentity(file.identity, file.path)) {
      throw new ObservationArchiveError();
    }
  }
}

function provePrivatePublishState(
  transaction: PublishArchiveTransaction,
  state: RetainedArchiveState
): PrivatePublishProof {
  const archiveDirectory = join(state.runDirectory, "@archive");
  const transactionDirectory = join(archiveDirectory, transaction.transactionId);
  const directories: ProvenPrivateDirectory[] = [];
  const absentDirectories: string[] = [];
  const files: ProvenPrivateFile[] = [];
  const archive = admitOptionalPrivateDirectory(archiveDirectory);
  if (archive === null) {
    absentDirectories.push(archiveDirectory);
    return Object.freeze({
      directories: Object.freeze(directories),
      absentDirectories: Object.freeze(absentDirectories),
      files: Object.freeze(files),
      transactionDirectory: null,
      stagingDirectory: null,
      trashDirectory: null
    });
  }
  directories.push(archive);
  if (archive.entries.length === 0) {
    absentDirectories.push(transactionDirectory);
    return Object.freeze({
      directories: Object.freeze(directories),
      absentDirectories: Object.freeze(absentDirectories),
      files: Object.freeze(files),
      transactionDirectory: null,
      stagingDirectory: null,
      trashDirectory: null
    });
  }
  if (archive.entries.length !== 1 || archive.entries[0] !== transaction.transactionId) {
    throw new ObservationArchiveError();
  }
  const transactionDirectoryProof = admitOptionalPrivateDirectory(transactionDirectory);
  if (
    transactionDirectoryProof === null ||
    transactionDirectoryProof.entries.some((entry) => entry !== "staging" && entry !== "trash")
  ) {
    throw new ObservationArchiveError();
  }
  directories.push(transactionDirectoryProof);

  const capturesDirectory = state.capturesDirectory;
  const captureAncestors = Object.freeze([...state.ancestors, capturesDirectory]);
  const stagingDirectory = join(transactionDirectory, "staging");
  const staging = admitOptionalPrivateDirectory(stagingDirectory);
  if (staging === null) {
    absentDirectories.push(stagingDirectory);
  } else {
    directories.push(staging);
    const expectedNames = new Set([
      `${transaction.payload.newBundle.observationId}.json`,
      `${transaction.payload.newBundle.observationId}.png`
    ]);
    if (staging.entries.some((entry) => !expectedNames.has(entry))) {
      throw new ObservationArchiveError();
    }
    const stagingAncestors = Object.freeze([
      ...state.ancestors,
      archiveDirectory,
      transactionDirectory,
      stagingDirectory
    ]);
    for (const name of staging.entries) {
      const stagedPath = join(stagingDirectory, name);
      const capturePath = join(capturesDirectory, name);
      const captureIdentity = identityAt(capturePath);
      if (!sameIdentity(captureIdentity, stagedPath)) {
        throw new ObservationArchiveError();
      }
      if (name.endsWith(".json")) {
        const staged = readStableRegularFileWithWitness(stagedPath, stagingAncestors);
        const captured = readStableRegularFileWithWitness(capturePath, captureAncestors);
        if (
          !staged.bytes.equals(captured.bytes) ||
          sha256(staged.bytes) !== transaction.payload.newBundle.captureMetadataSha256
        ) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(
          stagedPath,
          stagingAncestors,
          staged.bytes,
          staged.witness,
          "regular"
        ));
      } else {
        const staged = readStableBinaryFileWithWitness(stagedPath, stagingAncestors);
        const captured = readStableBinaryFileWithWitness(capturePath, captureAncestors);
        if (
          !staged.bytes.equals(captured.bytes) ||
          staged.bytes.length !== transaction.payload.newBundle.imageByteLength ||
          sha256(staged.bytes) !== transaction.payload.newBundle.imageSha256
        ) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(
          stagedPath,
          stagingAncestors,
          staged.bytes,
          staged.witness,
          "binary"
        ));
      }
    }
  }

  const trashDirectory = join(transactionDirectory, "trash");
  const trash = admitOptionalPrivateDirectory(trashDirectory);
  if (trash === null) {
    absentDirectories.push(trashDirectory);
  } else {
    directories.push(trash);
    const expectedNames = new Set(transaction.movedBundles.flatMap((entry) => [
      `${entry.observationId}.json`,
      `${entry.observationId}.png`
    ]));
    if (trash.entries.some((entry) => !expectedNames.has(entry))) {
      throw new ObservationArchiveError();
    }
    const trashAncestors = Object.freeze([
      ...state.ancestors,
      archiveDirectory,
      transactionDirectory,
      trashDirectory
    ]);
    for (const name of trash.entries) {
      const descriptor = transaction.movedBundles.find((entry) =>
        name === `${entry.observationId}.json` || name === `${entry.observationId}.png`
      );
      if (descriptor === undefined) {
        throw new ObservationArchiveError();
      }
      const path = join(trashDirectory, name);
      if (name.endsWith(".json")) {
        const admitted = readStableRegularFileWithWitness(path, trashAncestors);
        if (sha256(admitted.bytes) !== descriptor.captureMetadataSha256) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(
          path,
          trashAncestors,
          admitted.bytes,
          admitted.witness,
          "regular"
        ));
      } else {
        const admitted = readStableBinaryFileWithWitness(path, trashAncestors);
        if (
          admitted.bytes.length !== descriptor.imageByteLength ||
          sha256(admitted.bytes) !== descriptor.imageSha256
        ) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(
          path,
          trashAncestors,
          admitted.bytes,
          admitted.witness,
          "binary"
        ));
      }
    }
  }

  const proof = Object.freeze({
    directories: Object.freeze(directories),
    absentDirectories: Object.freeze(absentDirectories),
    files: Object.freeze(files),
    transactionDirectory,
    stagingDirectory: staging === null ? null : stagingDirectory,
    trashDirectory: trash === null ? null : trashDirectory
  });
  revalidatePrivatePublishProof(proof);
  return proof;
}

function removeProvenPrivateDirectory(
  path: string,
  proof: PrivatePublishProof
): void {
  const directory = proof.directories.find((entry) => samePath(entry.path, path));
  if (directory === undefined) {
    throw new ObservationArchiveError();
  }
  const current = lstatSync(path, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== directory.snapshot.dev ||
    current.ino !== directory.snapshot.ino ||
    current.birthtimeNs !== directory.snapshot.birthtimeNs ||
    readdirSync(path).length !== 0
  ) {
    throw new ObservationArchiveError();
  }
  rmdirSync(path);
}

function finalizePrivatePublishState(
  proof: PrivatePublishProof,
  beforeMutation: () => void = () => {}
): void {
  revalidatePrivatePublishProof(proof, "identity-continuity");
  for (const file of proof.files) {
    beforeMutation();
    removeOwnedFile(file.path, file.identity);
  }
  if (proof.stagingDirectory !== null) {
    beforeMutation();
    removeProvenPrivateDirectory(proof.stagingDirectory, proof);
  }
  if (proof.trashDirectory !== null) {
    beforeMutation();
    removeProvenPrivateDirectory(proof.trashDirectory, proof);
  }
  if (proof.transactionDirectory !== null) {
    beforeMutation();
    removeProvenPrivateDirectory(proof.transactionDirectory, proof);
  }
}

type ClearAllCapturesGuard = {
  path: string;
  ancestors: readonly string[];
  ancestorBaseline: StableAncestorBaseline;
  directory: ProvenPrivateDirectory | null;
  present: boolean;
};

function stableCapturesAbsence(path: string, ancestors: readonly string[]): void {
  const baseline = captureStableAncestorBaseline(path, ancestors);
  if (readStableOptionalRegularFileWithWitnessAgainstBaseline(path, ancestors, baseline) !== undefined) {
    throw new ObservationArchiveError();
  }
}

function proveClearAllCapturesGuard(
  path: string,
  ancestors: readonly string[]
): ClearAllCapturesGuard {
  const ancestorBaseline = captureStableAncestorBaseline(path, ancestors);
  const directory = admitOptionalPrivateDirectory(path);
  revalidateStableAncestorIdentitiesAgainstBaseline(path, ancestors, ancestorBaseline);
  if (directory === null) {
    stableCapturesAbsence(path, ancestors);
  } else if (directory.entries.length !== 0) {
    throw new ObservationArchiveError();
  } else {
    revalidatePrivatePublishProof(Object.freeze({
      directories: Object.freeze([directory]),
      absentDirectories: Object.freeze([]),
      files: Object.freeze([]),
      transactionDirectory: null,
      stagingDirectory: null,
      trashDirectory: null
    }));
  }
  return {
    path,
    ancestors,
    ancestorBaseline,
    directory,
    present: directory !== null
  };
}

function revalidateClearAllCapturesGuard(guard: ClearAllCapturesGuard): void {
  revalidateStableAncestorIdentitiesAgainstBaseline(
    guard.path,
    guard.ancestors,
    guard.ancestorBaseline
  );
  if (!guard.present) {
    stableCapturesAbsence(guard.path, guard.ancestors);
    return;
  }
  if (guard.directory === null) {
    throw new ObservationArchiveError();
  }
  revalidatePrivatePublishProof(Object.freeze({
    directories: Object.freeze([guard.directory]),
    absentDirectories: Object.freeze([]),
    files: Object.freeze([]),
    transactionDirectory: null,
    stagingDirectory: null,
    trashDirectory: null
  }));
  revalidateStableAncestorIdentitiesAgainstBaseline(
    guard.path,
    guard.ancestors,
    guard.ancestorBaseline
  );
}

function removeClearAllCapturesDirectory(guard: ClearAllCapturesGuard): void {
  revalidateClearAllCapturesGuard(guard);
  if (!guard.present) return;
  if (guard.directory === null) throw new ObservationArchiveError();
  removeOwnedEmptyDirectory(guard.path, {
    dev: guard.directory.snapshot.dev,
    ino: guard.directory.snapshot.ino,
    birthtimeNs: guard.directory.snapshot.birthtimeNs
  });
  guard.present = false;
  revalidateClearAllCapturesGuard(guard);
}

function provePrivateClearState(
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  state: Pick<RetainedArchiveState, "runDirectory" | "ancestors">,
  requireComplete = true
): PrivatePublishProof {
  const archiveDirectory = join(state.runDirectory, "@archive");
  const transactionDirectory = join(archiveDirectory, transaction.transactionId);
  const stagingDirectory = join(transactionDirectory, "staging");
  const trashDirectory = join(transactionDirectory, "trash");
  const directories: ProvenPrivateDirectory[] = [];
  const absentDirectories: string[] = [];
  const files: ProvenPrivateFile[] = [];
  const expectedNames = transaction.movedBundles.flatMap((entry) => [
    `${entry.observationId}.json`,
    `${entry.observationId}.png`
  ]).sort();

  const archive = admitOptionalPrivateDirectory(archiveDirectory);
  if (archive === null) {
    if (requireComplete) throw new ObservationArchiveError();
    absentDirectories.push(archiveDirectory);
    return Object.freeze({
      directories: Object.freeze(directories),
      absentDirectories: Object.freeze(absentDirectories),
      files: Object.freeze(files),
      transactionDirectory: null,
      stagingDirectory: null,
      trashDirectory: null
    });
  }
  directories.push(archive);
  if (
    archive.entries.some((entry) => entry !== transaction.transactionId) ||
    (requireComplete && archive.entries.join("\0") !== transaction.transactionId)
  ) {
    throw new ObservationArchiveError();
  }
  if (archive.entries.length === 0) {
    absentDirectories.push(transactionDirectory);
    const proof: PrivatePublishProof = Object.freeze({
      directories: Object.freeze(directories),
      absentDirectories: Object.freeze(absentDirectories),
      files: Object.freeze(files),
      transactionDirectory: null,
      stagingDirectory: null,
      trashDirectory: null
    });
    revalidatePrivatePublishProof(proof);
    return proof;
  }

  const transactionProof = admitOptionalPrivateDirectory(transactionDirectory);
  if (
    transactionProof === null ||
    transactionProof.entries.some((entry) => entry !== "staging" && entry !== "trash") ||
    (requireComplete && transactionProof.entries.join("\0") !== "staging\0trash")
  ) {
    throw new ObservationArchiveError();
  }
  directories.push(transactionProof);

  const staging = admitOptionalPrivateDirectory(stagingDirectory);
  if (staging === null) {
    if (requireComplete) throw new ObservationArchiveError();
    absentDirectories.push(stagingDirectory);
  } else {
    if (staging.entries.length !== 0) throw new ObservationArchiveError();
    directories.push(staging);
  }

  const trash = admitOptionalPrivateDirectory(trashDirectory);
  if (trash === null) {
    if (requireComplete) throw new ObservationArchiveError();
    absentDirectories.push(trashDirectory);
  } else {
    if (
      trash.entries.some((entry) => !expectedNames.includes(entry)) ||
      (requireComplete && trash.entries.join("\0") !== expectedNames.join("\0"))
    ) {
      throw new ObservationArchiveError();
    }
    directories.push(trash);
    const trashAncestors = Object.freeze([
      ...state.ancestors,
      archiveDirectory,
      transactionDirectory,
      trashDirectory
    ]);
    for (const name of trash.entries) {
      const descriptor = transaction.movedBundles.find((entry) =>
        name === `${entry.observationId}.json` || name === `${entry.observationId}.png`
      );
      if (descriptor === undefined) throw new ObservationArchiveError();
      const path = join(trashDirectory, name);
      if (name.endsWith(".json")) {
        const metadata = readStableRegularFileWithWitness(path, trashAncestors);
        if (sha256(metadata.bytes) !== descriptor.captureMetadataSha256) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(path, trashAncestors, metadata.bytes, metadata.witness, "regular"));
      } else {
        const image = readStableBinaryFileWithWitness(path, trashAncestors);
        if (
          image.bytes.length !== descriptor.imageByteLength ||
          sha256(image.bytes) !== descriptor.imageSha256
        ) {
          throw new ObservationArchiveError();
        }
        files.push(provePrivateFile(path, trashAncestors, image.bytes, image.witness, "binary"));
      }
    }
  }

  const proof: PrivatePublishProof = Object.freeze({
    directories: Object.freeze(directories),
    absentDirectories: Object.freeze(absentDirectories),
    files: Object.freeze(files),
    transactionDirectory,
    stagingDirectory: staging === null ? null : stagingDirectory,
    trashDirectory: trash === null ? null : trashDirectory
  });
  revalidatePrivatePublishProof(proof);
  return proof;
}

function requireRetainedAfterClear(
  before: RetainedArchiveState,
  after: RetainedArchiveState,
  clearedObservationIds: ReadonlySet<string>,
  expectedLiveBytes: Buffer,
  invalidatedCurrent: boolean,
  transactionId: string,
  clearAll: boolean
): void {
  if (
    before.runDirectory !== after.runDirectory ||
    before.runSnapshot.dev !== after.runSnapshot.dev ||
    before.runSnapshot.ino !== after.runSnapshot.ino ||
    before.runSnapshot.birthtimeNs !== after.runSnapshot.birthtimeNs
  ) {
    throw new ObservationArchiveError();
  }
  if (clearAll) {
    if (
      after.currentObservationId !== null ||
      after.live !== null ||
      after.liveBytes !== null ||
      after.liveSnapshot !== null ||
      expectedLiveBytes.length !== 0
    ) {
      throw new ObservationArchiveError();
    }
  } else if (invalidatedCurrent) {
    if (
      before.liveBytes === null ||
      after.liveBytes === null ||
      before.liveSnapshot === null ||
      after.liveSnapshot === null ||
      !after.live ||
      after.live.kind !== "cu.live-observation-tombstone/v1" ||
      !after.liveBytes.equals(expectedLiveBytes) ||
      after.live.observationId !== before.currentObservationId ||
      after.live.invalidatedReason !== "cleared" ||
      after.live.invalidatedByTransactionId !== transactionId ||
      after.live.previousLiveRecordSha256 !== sha256(before.liveBytes)
    ) {
      throw new ObservationArchiveError();
    }
  } else if (before.liveBytes === null) {
    if (
      before.currentObservationId !== null ||
      before.live !== null ||
      before.liveSnapshot !== null ||
      after.currentObservationId !== null ||
      after.live !== null ||
      after.liveBytes !== null ||
      after.liveSnapshot !== null ||
      expectedLiveBytes.length !== 0
    ) {
      throw new ObservationArchiveError();
    }
  } else if (
    before.currentObservationId !== after.currentObservationId ||
    after.liveBytes === null ||
    !before.liveBytes.equals(after.liveBytes) ||
    before.liveSnapshot === null ||
    after.liveSnapshot === null ||
    !sameDirectorySnapshot(before.liveSnapshot, after.liveSnapshot)
  ) {
    throw new ObservationArchiveError();
  }
  const expected = before.retained.filter((entry) =>
    !clearedObservationIds.has(entry.capture.observationId)
  );
  if (after.retained.length !== expected.length) {
    throw new ObservationArchiveError();
  }
  const afterById = new Map(after.retained.map((entry) => [entry.capture.observationId, entry]));
  for (const entry of expected) {
    const candidate = afterById.get(entry.capture.observationId);
    if (
      candidate === undefined ||
      !descriptorMatches(entry.descriptor, candidate.descriptor) ||
      entry.capture.capturedAt !== candidate.capture.capturedAt ||
      entry.committedBytes !== candidate.committedBytes ||
      !sameDirectorySnapshot(entry.metadataSnapshot, candidate.metadataSnapshot) ||
      !sameDirectorySnapshot(entry.imageSnapshot, candidate.imageSnapshot)
    ) {
      throw new ObservationArchiveError();
    }
  }
}

function replaceClearTransactionState(
  root: string,
  runId: string,
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  expectedState: "prepared" | "assets_staged",
  expectedUpdatedAt: string,
  expectedIdentity: ControlRecordIdentity,
  expectedSnapshot: BigIntStats,
  nextState: "assets_staged" | "cutover_committed",
  updatedAt: string,
  recordPath: string,
  ancestors: readonly string[]
): ControlRecordIdentity {
  const next: ClearRangeArchiveTransaction | ClearAllArchiveTransaction = {
    ...transaction,
    state: nextState,
    updatedAt
  };
  const staged = stageValidatedControlRecord(
    recordPath,
    ancestors[1]!,
    ancestors,
    jsonBytes(next),
    (candidate) => {
      const parsed = parseArchiveTransactionBytes(candidate, {
        runId,
        workspaceFingerprint: transaction.workspaceFingerprint
      });
      if (
        parsed.operation !== transaction.operation ||
        parsed.transactionId !== transaction.transactionId ||
        parsed.state !== nextState
      ) {
        throw new ObservationArchiveError();
      }
    }
  );
  const active = inspectArchiveTransactionWithWitness(root, runId);
  const expectedActive = {
    ...transaction,
    state: expectedState,
    updatedAt: expectedUpdatedAt
  };
  if (
    active === undefined ||
    !isDeepStrictEqual(active.transaction, expectedActive) ||
    !sameIdentity(expectedIdentity, active.recordPath) ||
    !sameDirectorySnapshot(expectedSnapshot, stableFileSnapshot(active.recordPath))
  ) {
    throw new ObservationArchiveError();
  }
  return replaceWitnessedControlRecord(
    recordPath,
    ancestors[1]!,
    ancestors,
    active.witness,
    staged
  );
}

export type ClearObservationArchiveRangeResult = Readonly<{
  clearedCount: number;
  invalidatedCurrent: boolean;
}>;

async function performObservationArchiveClear(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  timeStart: string | null,
  timeEnd: string,
  clearAll: boolean
): Promise<ClearObservationArchiveRangeResult> {
  let preparedPublished = false;
  try {
    if (!isRunId(runId)) {
      throw new ObservationArchiveError();
    }
    const root = realpathSync.native(resolve(workspaceRoot));
    const fingerprint = workspaceFingerprint(root);
    revalidateRunLock(lock, root, runId);
    await recoverObservationArchive(lock, root, runId);
    if (inspectArchiveTransactionWithWitness(root, runId) !== undefined) {
      throw new ObservationArchiveError();
    }
    let state = await inspectRetainedArchive(root, runId, fingerprint);
    const startMilliseconds = timeStart === null ? null : new Date(timeStart).getTime();
    const endMilliseconds = new Date(timeEnd).getTime();
    const selected = clearAll
      ? [...state.retained]
      : state.retained.filter((entry) => {
          const capturedAt = new Date(entry.capture.capturedAt).getTime();
          return capturedAt < endMilliseconds &&
            (startMilliseconds === null || capturedAt >= startMilliseconds);
        });
    if (
      selected.length === 0 &&
      (!clearAll || (state.live === null && readOptionalHistory(
        join(state.runDirectory, "history.ndjson"),
        state.ancestors
      ) === null))
    ) {
      return Object.freeze({ clearedCount: 0, invalidatedCurrent: false });
    }
    const invalidatesLive = !clearAll && state.currentObservationId !== null &&
      selected.some((entry) => entry.capture.observationId === state.currentObservationId);
    const deletesLive = clearAll && state.liveBytes !== null;
    const transactionId = randomToken("txn");
    const createdAt = new Date();
    const createdMilliseconds = createdAt.getTime();
    const updatedAt = createdAt.toISOString();
    const historyEvents: ArchiveHistoryEvent[] = clearAll
      ? []
      : selected.map((entry, index) => ({
          eventId: randomToken("hist", `_${index + 1}`),
          at: updatedAt,
          eventType: "capture_cleared",
          observationId: entry.capture.observationId,
          capturedAt: entry.capture.capturedAt
        }));
    const transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction = clearAll
      ? {
          kind: "cu.archive-transaction/v1",
          schemaVersion: 1,
          runId,
          workspaceFingerprint: fingerprint,
          transactionId,
          operation: "clear_all",
          state: "prepared",
          createdAt: updatedAt,
          updatedAt,
          priorLive: state.live === null ? null : {
            observationId: state.live.observationId,
            liveRecordSha256: sha256(state.liveBytes!)
          },
          movedBundles: selected.map((entry) => entry.descriptor),
          historyEvents,
          payload: {
            deletesLiveRecord: true,
            selectedObservationIds: selected.map((entry) => entry.capture.observationId)
          }
        }
      : {
          kind: "cu.archive-transaction/v1",
          schemaVersion: 1,
          runId,
          workspaceFingerprint: fingerprint,
          transactionId,
          operation: "clear_range",
          state: "prepared",
          createdAt: updatedAt,
          updatedAt,
          priorLive: state.live === null ? null : {
            observationId: state.live.observationId,
            liveRecordSha256: sha256(state.liveBytes!)
          },
          movedBundles: selected.map((entry) => entry.descriptor),
          historyEvents,
          payload: {
            invalidatesLive,
            selectedObservationIds: selected.map((entry) => entry.capture.observationId)
          }
        };
    const parsed = parseArchiveTransactionBytes(jsonBytes(transaction), {
      runId,
      workspaceFingerprint: fingerprint
    });
    if (parsed.operation !== transaction.operation || parsed.transactionId !== transactionId) {
      throw new ObservationArchiveError();
    }
    validateClearTransactionSemantics(transaction, state);
    revalidateRunLock(lock, root, runId);
    if (requireHistoryCapacityBeforePrepared(
      transaction,
      state,
      () => revalidateRunLock(lock, root, runId)
    )) {
      state = await inspectRetainedArchive(root, runId, fingerprint);
      const refreshedById = new Map(state.retained.map((entry) => [entry.capture.observationId, entry]));
      if (selected.some((entry) => {
        const refreshed = refreshedById.get(entry.capture.observationId);
        return refreshed === undefined || !descriptorMatches(entry.descriptor, refreshed.descriptor);
      })) {
        throw new ObservationArchiveError();
      }
    }
    const preparedPublication = publishPreparedArchiveTransaction(
      lock,
      root,
      runId,
      jsonBytes(transaction)
    );
    preparedPublished = true;
    let activeRecordIdentity = preparedPublication.identity;
    let activeRecordSnapshot = stableFileSnapshot(preparedPublication.recordPath);
    const layout = prepareArchiveTransactionLayout(lock, root, runId);
    const paths = inspectArchiveTransactionLayout(layout, lock, root, runId);
    const clearAllArchiveIdentity = clearAll
      ? directoryIdentity(paths.archiveDirectory)
      : null;
    const capturesAncestors = Object.freeze([...paths.ancestors, paths.capturesDirectory]);
    const trashAncestors = Object.freeze([
      ...paths.ancestors,
      paths.archiveDirectory,
      paths.transactionDirectory,
      paths.trashDirectory
    ]);
    const selectedById = new Map(state.retained.map((entry) => [entry.capture.observationId, entry]));
    const liveIdentity = clearAll && state.liveBytes !== null
      ? privateFileIdentity(paths.liveObservationPath)
      : null;
    const historyIdentity = clearAll && readOptionalHistory(paths.historyPath, state.ancestors) !== null
      ? privateFileIdentity(paths.historyPath)
      : null;
    for (const descriptor of transaction.movedBundles) {
      const retained = selectedById.get(descriptor.observationId);
      if (retained === undefined || !descriptorMatches(retained.descriptor, descriptor)) {
        throw new ObservationArchiveError();
      }
      revalidateRunLock(lock, root, runId);
      moveRetainedCaptureToTrash(
        retained,
        capturesAncestors,
        paths.trashDirectory,
        trashAncestors
      );
    }
    const clearAllCapturesGuard = clearAll
      ? proveClearAllCapturesGuard(paths.capturesDirectory, paths.ancestors)
      : null;
    revalidateRunLock(lock, root, runId);
    const assetsStagedAt = new Date(createdMilliseconds + 1).toISOString();
    activeRecordIdentity = replaceClearTransactionState(
      root,
      runId,
      transaction,
      "prepared",
      transaction.updatedAt,
      activeRecordIdentity,
      activeRecordSnapshot,
      "assets_staged",
      assetsStagedAt,
      paths.recordPath,
      paths.ancestors
    );
    activeRecordSnapshot = stableFileSnapshot(paths.recordPath);
    let finalLiveBytes: Buffer = state.liveBytes === null
      ? Buffer.alloc(0)
      : Buffer.from(state.liveBytes);
    const cutoverCommittedAt = new Date(createdMilliseconds + 2).toISOString();
    const expectedCommittedTransaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction = {
      ...transaction,
      state: "cutover_committed",
      updatedAt: cutoverCommittedAt
    };
    let committedAuthority: WitnessedArchiveTransaction | null = null;
    let installedTombstoneIdentity: ControlRecordIdentity | null = null;
    if (clearAll) {
      revalidateRunLock(lock, root, runId);
      activeRecordIdentity = replaceClearTransactionState(
        root,
        runId,
        transaction,
        "assets_staged",
        assetsStagedAt,
        activeRecordIdentity,
        activeRecordSnapshot,
        "cutover_committed",
        cutoverCommittedAt,
        paths.recordPath,
        paths.ancestors
      );
      activeRecordSnapshot = stableFileSnapshot(paths.recordPath);
      committedAuthority = inspectArchiveTransactionWithWitness(root, runId) ?? null;
      if (
        committedAuthority === null ||
        !isDeepStrictEqual(committedAuthority.transaction, expectedCommittedTransaction)
      ) {
        throw new ObservationArchivePublicationUncertainError();
      }
      revalidateStableRegularFileWitness(
        committedAuthority.recordPath,
        committedAuthority.ancestors,
        committedAuthority.witness
      );
      if (
        !sameIdentity(activeRecordIdentity, committedAuthority.recordPath) ||
        !sameDirectorySnapshot(
          activeRecordSnapshot,
          stableFileSnapshot(committedAuthority.recordPath)
        )
      ) {
        throw new ObservationArchivePublicationUncertainError();
      }
      if (clearAllCapturesGuard === null) {
        throw new ObservationArchivePublicationUncertainError();
      }
      if (liveIdentity !== null) {
        revalidateClearAllCapturesGuard(clearAllCapturesGuard);
        removeOwnedFile(paths.liveObservationPath, liveIdentity);
      }
      if (historyIdentity !== null) {
        revalidateClearAllCapturesGuard(clearAllCapturesGuard);
        removeOwnedFile(paths.historyPath, historyIdentity);
      }
      finalLiveBytes = Buffer.alloc(0);
    } else {
      if (invalidatesLive) {
        const live = state.live;
        if (live === null || state.liveBytes === null || live.kind !== "cu.live-observation/v1") {
          throw new ObservationArchiveError();
        }
        const tombstone = {
          kind: "cu.live-observation-tombstone/v1" as const,
          schemaVersion: 1 as const,
          runId,
          workspaceFingerprint: fingerprint,
          observationId: live.observationId,
          previousLiveRecordSha256: sha256(state.liveBytes),
          invalidatedReason: "cleared" as const,
          invalidatedAt: updatedAt,
          invalidatedByTransactionId: transactionId
        };
        finalLiveBytes = jsonBytes(tombstone);
        parseLiveObservationBytes(finalLiveBytes, { runId, workspaceFingerprint: fingerprint });
        const stagedLive = stageValidatedControlRecord(
          paths.liveObservationPath,
          paths.ancestors[1]!,
          paths.ancestors,
          finalLiveBytes,
          (candidate) => {
            parseLiveObservationBytes(candidate, { runId, workspaceFingerprint: fingerprint });
          }
        );
        const liveBaseline = captureStableAncestorBaseline(paths.liveObservationPath, paths.ancestors);
        const existingLive = readStableOptionalRegularFileWithWitnessAgainstBaseline(
          paths.liveObservationPath,
          paths.ancestors,
          liveBaseline
        );
        if (
          existingLive === undefined ||
          !existingLive.bytes.equals(state.liveBytes) ||
          transaction.priorLive === null ||
          sha256(existingLive.bytes) !== transaction.priorLive.liveRecordSha256
        ) {
          throw new ObservationArchiveError();
        }
        const admittedPredecessor = parseLiveObservationBytes(existingLive.bytes, {
          runId,
          workspaceFingerprint: fingerprint
        });
        if (admittedPredecessor.observationId !== state.currentObservationId) {
          throw new ObservationArchiveError();
        }
        revalidateRunLock(lock, root, runId);
        installedTombstoneIdentity = replaceWitnessedControlRecord(
          paths.liveObservationPath,
          paths.ancestors[1]!,
          paths.ancestors,
          existingLive.witness,
          stagedLive
        );
      }
      revalidateRunLock(lock, root, runId);
      activeRecordIdentity = replaceClearTransactionState(
        root,
        runId,
        transaction,
        "assets_staged",
        assetsStagedAt,
        activeRecordIdentity,
        activeRecordSnapshot,
        "cutover_committed",
        cutoverCommittedAt,
        paths.recordPath,
        paths.ancestors
      );
      activeRecordSnapshot = stableFileSnapshot(paths.recordPath);
    }
    let committed = committedAuthority ?? inspectArchiveTransactionWithWitness(root, runId);
    if (
      committed === undefined ||
      committed.transaction.operation === "publish" ||
      !isDeepStrictEqual(committed.transaction, expectedCommittedTransaction)
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    const committedTransaction = committed.transaction;
    if (invalidatesLive) {
      const liveBaseline = captureStableAncestorBaseline(
        paths.liveObservationPath,
        paths.ancestors
      );
      const installedTombstone = readStableOptionalRegularFileWithWitnessAgainstBaseline(
        paths.liveObservationPath,
        paths.ancestors,
        liveBaseline
      );
      if (
        installedTombstone === undefined ||
        installedTombstoneIdentity === null ||
        !sameIdentity(installedTombstoneIdentity, paths.liveObservationPath) ||
        !installedTombstone.bytes.equals(finalLiveBytes)
      ) {
        throw new ObservationArchivePublicationUncertainError();
      }
      const admittedTombstone = parseLiveObservationBytes(installedTombstone.bytes, {
        runId,
        workspaceFingerprint: fingerprint
      });
      if (
        admittedTombstone.kind !== "cu.live-observation-tombstone/v1" ||
        admittedTombstone.invalidatedByTransactionId !== transactionId
      ) {
        throw new ObservationArchivePublicationUncertainError();
      }
    }
    const privateProof = provePrivateClearState(committedTransaction, state);
    revalidateRunLock(lock, root, runId);
    if (committedAuthority === null) {
      revalidateStableRegularFileWitness(
        committed.recordPath,
        committed.ancestors,
        committed.witness
      );
    } else {
      const rebound = inspectArchiveTransactionWithWitness(root, runId);
      if (
        rebound === undefined ||
        rebound.transaction.operation === "publish" ||
        !isDeepStrictEqual(rebound.transaction, expectedCommittedTransaction)
      ) {
        throw new ObservationArchivePublicationUncertainError();
      }
      assertStableRegularFileWitnessContinuity(
        committed.recordPath,
        committed.ancestors,
        committed.witness,
        rebound.witness
      );
      committed = rebound;
    }
    if (
      !sameIdentity(activeRecordIdentity, committed.recordPath) ||
      !sameDirectorySnapshot(activeRecordSnapshot, stableFileSnapshot(committed.recordPath))
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    if (!clearAll) {
      appendHistoryEvents(
        paths.historyPath,
        state.runDirectory,
        state.ancestors,
        historyLinesForTransaction(committedTransaction),
        runId,
        fingerprint
      );
    }
    finalizePrivatePublishState(
      privateProof,
      clearAllCapturesGuard === null
        ? undefined
        : () => revalidateClearAllCapturesGuard(clearAllCapturesGuard)
    );
    const finalState = await inspectRetainedArchive(root, runId, fingerprint);
    requireRetainedAfterClear(
      state,
      finalState,
      new Set(transaction.movedBundles.map((entry) => entry.observationId)),
      finalLiveBytes,
      invalidatesLive,
      transactionId,
      clearAll
    );
    if (clearAll) {
      if (clearAllCapturesGuard === null || clearAllArchiveIdentity === null) {
        throw new ObservationArchiveError();
      }
      removeClearAllCapturesDirectory(clearAllCapturesGuard);
      revalidateClearAllCapturesGuard(clearAllCapturesGuard);
      removeOwnedEmptyDirectory(paths.archiveDirectory, clearAllArchiveIdentity);
    }
    revalidateRunLock(lock, root, runId);
    const finalActive = inspectArchiveTransactionWithWitness(root, runId);
    if (
      finalActive === undefined ||
      finalActive.transaction.operation !== transaction.operation ||
      finalActive.transaction.transactionId !== transactionId ||
      finalActive.transaction.state !== "cutover_committed"
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    if (
      !sameIdentity(activeRecordIdentity, finalActive.recordPath) ||
      !sameDirectorySnapshot(activeRecordSnapshot, stableFileSnapshot(finalActive.recordPath))
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    assertStableRegularFileWitnessContinuity(
      committed.recordPath,
      committed.ancestors,
      committed.witness,
      finalActive.witness
    );
    if (clearAllCapturesGuard !== null) {
      revalidateClearAllCapturesGuard(clearAllCapturesGuard);
    }
    removeOwnedFile(finalActive.recordPath, activeRecordIdentity);
    return Object.freeze({
      clearedCount: transaction.movedBundles.length,
      invalidatedCurrent: invalidatesLive
    });
  } catch (error) {
    if (
      preparedPublished ||
      error instanceof ObservationArchivePublicationUncertainError ||
      error instanceof ArchiveStorePublicationUncertainError ||
      error instanceof ControlRecordPublicationUncertainError ||
      error instanceof ControlRecordReplacementUncertainError
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    throw new ObservationArchiveError();
  }
}

export async function clearObservationArchiveRange(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  timeStart: string | null,
  timeEnd: string
): Promise<ClearObservationArchiveRangeResult> {
  return performObservationArchiveClear(
    lock,
    workspaceRoot,
    runId,
    timeStart,
    timeEnd,
    false
  );
}

export async function clearObservationArchiveAll(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): Promise<ClearObservationArchiveRangeResult> {
  return performObservationArchiveClear(
    lock,
    workspaceRoot,
    runId,
    null,
    "9999-12-31T23:59:59.999Z",
    true
  );
}

function requireClearCutoverState(
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction,
  state: RetainedArchiveState
): void {
  if (transaction.movedBundles.some((moved) =>
    state.retained.some((entry) => entry.capture.observationId === moved.observationId)
  )) {
    throw new ObservationArchiveError();
  }
  if (transaction.operation === "clear_all") {
    if (state.retained.length !== 0) {
      throw new ObservationArchiveError();
    }
    if (transaction.priorLive === null) {
      if (state.live !== null || state.liveBytes !== null || state.liveSnapshot !== null) {
        throw new ObservationArchiveError();
      }
    } else if (
      state.live !== null &&
      (state.liveBytes === null ||
        sha256(state.liveBytes) !== transaction.priorLive.liveRecordSha256)
    ) {
      throw new ObservationArchiveError();
    }
    return;
  }
  if (transaction.payload.invalidatesLive) {
    if (
      transaction.priorLive === null ||
      state.live === null ||
      state.live.kind !== "cu.live-observation-tombstone/v1" ||
      state.live.observationId !== transaction.priorLive.observationId ||
      state.live.previousLiveRecordSha256 !== transaction.priorLive.liveRecordSha256 ||
      state.live.invalidatedReason !== "cleared" ||
      state.live.invalidatedByTransactionId !== transaction.transactionId
    ) {
      throw new ObservationArchiveError();
    }
  } else if (transaction.priorLive === null) {
    if (state.live !== null || state.liveBytes !== null) {
      throw new ObservationArchiveError();
    }
  } else if (
    state.live === null ||
    state.live.observationId !== transaction.priorLive.observationId ||
    state.liveBytes === null ||
    sha256(state.liveBytes) !== transaction.priorLive.liveRecordSha256
  ) {
    throw new ObservationArchiveError();
  }
}

function requireClearHistoryPrefix(
  transaction: ClearRangeArchiveTransaction,
  state: RetainedArchiveState
): void {
  const historyPath = join(state.runDirectory, "history.ndjson");
  const history = readOptionalHistory(historyPath, state.ancestors);
  if (history === null) {
    return;
  }
  const inspected = inspectHistoryBytes(history, transaction.runId, transaction.workspaceFingerprint);
  const expected = historyLinesForTransaction(transaction).map((line) => ({
    event: parseHistoryEventBytes(line, {
      runId: transaction.runId,
      workspaceFingerprint: transaction.workspaceFingerprint
    }),
    line
  }));
  let prefix = 0;
  while (prefix < expected.length && inspected.byId.has(expected[prefix]!.event.eventId)) {
    prefix += 1;
  }
  if (
    expected.slice(prefix).some((entry) => inspected.byId.has(entry.event.eventId)) ||
    prefix > inspected.ordered.length
  ) {
    throw new ObservationArchiveError();
  }
  const presentTail = inspected.ordered.slice(inspected.ordered.length - prefix);
  for (let index = 0; index < prefix; index += 1) {
    if (
      presentTail[index]!.event.eventId !== expected[index]!.event.eventId ||
      !presentTail[index]!.line.equals(expected[index]!.line)
    ) {
      throw new ObservationArchiveError();
    }
  }
  if (
    inspected.trailing.length > 0 &&
    !Buffer.concat(expected.slice(prefix).map((entry) => entry.line))
      .subarray(0, inspected.trailing.length)
      .equals(inspected.trailing)
  ) {
    throw new ObservationArchiveError();
  }
}

function requireClearFinalState(
  before: RetainedArchiveState,
  after: RetainedArchiveState,
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction
): void {
  if (
    (transaction.operation === "clear_range" &&
      before.currentObservationId !== after.currentObservationId) ||
    before.retained.length !== after.retained.length
  ) {
    throw new ObservationArchiveError();
  }
  const afterById = new Map(after.retained.map((entry) => [entry.capture.observationId, entry]));
  for (const entry of before.retained) {
    const candidate = afterById.get(entry.capture.observationId);
    if (
      candidate === undefined ||
      !descriptorMatches(entry.descriptor, candidate.descriptor) ||
      !sameDirectorySnapshot(entry.metadataSnapshot, candidate.metadataSnapshot) ||
      !sameDirectorySnapshot(entry.imageSnapshot, candidate.imageSnapshot)
    ) {
      throw new ObservationArchiveError();
    }
  }
  if (transaction.operation === "clear_all") {
    if (after.live !== null || after.liveBytes !== null || after.liveSnapshot !== null) {
      throw new ObservationArchiveError();
    }
  } else if (before.liveBytes === null) {
    if (after.live !== null || after.liveBytes !== null || after.liveSnapshot !== null) {
      throw new ObservationArchiveError();
    }
  } else if (
    after.liveBytes === null ||
    !before.liveBytes.equals(after.liveBytes) ||
    before.liveSnapshot === null ||
    after.liveSnapshot === null ||
    !sameDirectorySnapshot(before.liveSnapshot, after.liveSnapshot)
  ) {
    throw new ObservationArchiveError();
  }
}

type ClearRollbackFile = Readonly<{
  targetPath: string;
  source: ProvenPrivateFile;
  fromTrash: boolean;
}>;

type ClearRollbackProof = Readonly<{
  runDirectory: string;
  ancestors: readonly string[];
  capturesDirectory: string;
  capturesProof: PrivatePublishProof;
  privateProof: PrivatePublishProof;
  files: readonly ClearRollbackFile[];
  liveBytes: Buffer | null;
}>;

function proveOptionalRollbackFile(
  path: string,
  ancestors: readonly string[],
  kind: "regular" | "binary"
): ProvenPrivateFile | null {
  const baseline = captureStableAncestorBaseline(path, ancestors);
  const admitted = kind === "regular"
    ? readStableOptionalRegularFileWithWitnessAgainstBaseline(path, ancestors, baseline)
    : readStableOptionalBinaryFileWithWitnessAgainstBaseline(path, ancestors, baseline);
  return admitted === undefined
    ? null
    : provePrivateFile(path, ancestors, admitted.bytes, admitted.witness, kind);
}

async function proveClearRollbackProgress(
  root: string,
  runId: string,
  transaction: ClearRangeArchiveTransaction | ClearAllArchiveTransaction
): Promise<ClearRollbackProof> {
  const { runDirectory, ancestors } = directRunPaths(root, runId);
  const capturesDirectory = join(runDirectory, "captures");
  const capturesDirectoryProof = admitOptionalPrivateDirectory(capturesDirectory);
  if (capturesDirectoryProof === null) throw new ObservationArchiveError();
  const captureAncestors = Object.freeze([...ancestors, capturesDirectory]);
  const privateProof = provePrivateClearState(
    transaction,
    { runDirectory, ancestors },
    false
  );
  const trashDirectory = join(
    runDirectory,
    "@archive",
    transaction.transactionId,
    "trash"
  );
  const selectedById = new Map(
    transaction.movedBundles.map((descriptor) => [descriptor.observationId, descriptor])
  );
  const captureNamesById = new Map<string, Set<"json" | "png">>();
  for (const name of capturesDirectoryProof.entries) {
    const match = /^(obs_[a-f0-9]{32})\.(json|png)$/.exec(name);
    if (match === null) throw new ObservationArchiveError();
    const extensions = captureNamesById.get(match[1]!) ?? new Set<"json" | "png">();
    extensions.add(match[2]! as "json" | "png");
    captureNamesById.set(match[1]!, extensions);
  }
  const observationIds = new Set([
    ...captureNamesById.keys(),
    ...selectedById.keys()
  ]);
  const captureFiles: ProvenPrivateFile[] = [];
  const rollbackFiles: ClearRollbackFile[] = [];
  const validatedCaptures = new Map<string, CaptureSidecar>();

  for (const observationId of observationIds) {
    const descriptor = selectedById.get(observationId);
    const admissions = new Map<"json" | "png", ProvenPrivateFile>();
    for (const extension of ["json", "png"] as const) {
      const targetPath = join(capturesDirectory, `${observationId}.${extension}`);
      const captured = proveOptionalRollbackFile(
        targetPath,
        captureAncestors,
        extension === "json" ? "regular" : "binary"
      );
      const trashPath = join(trashDirectory, `${observationId}.${extension}`);
      const trashed = privateProof.files.find((file) => samePath(file.path, trashPath));
      if (descriptor === undefined) {
        if (captured === null || trashed !== undefined) throw new ObservationArchiveError();
        admissions.set(extension, captured);
        captureFiles.push(captured);
      } else {
        if ((captured === null) === (trashed === undefined)) {
          throw new ObservationArchiveError();
        }
        const source = captured ?? trashed!;
        admissions.set(extension, source);
        if (captured !== null) captureFiles.push(captured);
        rollbackFiles.push(Object.freeze({
          targetPath,
          source,
          fromTrash: captured === null
        }));
      }
    }
    const metadata = admissions.get("json")!;
    const image = admissions.get("png")!;
    const validated = await validateCaptureBundleBytes(metadata.bytes, image.bytes, {
      runId,
      workspaceFingerprint: transaction.workspaceFingerprint
    });
    if (validated.capture.observationId !== observationId) {
      throw new ObservationArchiveError();
    }
    if (
      descriptor !== undefined &&
      (sha256(metadata.bytes) !== descriptor.captureMetadataSha256 ||
        sha256(image.bytes) !== descriptor.imageSha256 ||
        image.bytes.length !== descriptor.imageByteLength)
    ) {
      throw new ObservationArchiveError();
    }
    validatedCaptures.set(observationId, validated.capture);
  }

  const capturesProof: PrivatePublishProof = Object.freeze({
    directories: Object.freeze([capturesDirectoryProof]),
    absentDirectories: Object.freeze([]),
    files: Object.freeze(captureFiles),
    transactionDirectory: null,
    stagingDirectory: null,
    trashDirectory: null
  });
  const livePath = join(runDirectory, "live-observation.json");
  const liveAdmission = readOptionalLive(
    livePath,
    ancestors,
    runId,
    transaction.workspaceFingerprint
  );
  if (liveAdmission?.live.kind === "cu.live-observation/v1") {
    const capture = validatedCaptures.get(liveAdmission.live.observationId);
    const metadata = rollbackFiles.find((file) =>
      file.targetPath === join(capturesDirectory, `${liveAdmission.live.observationId}.json`)
    )?.source ?? captureFiles.find((file) =>
      file.path === join(capturesDirectory, `${liveAdmission.live.observationId}.json`)
    );
    if (capture === undefined || metadata === undefined) throw new ObservationArchiveError();
    validateBundleBoundLiveObservation(
      liveAdmission.live,
      capture,
      sha256(metadata.bytes)
    );
  }
  if (
    transaction.priorLive === null
      ? liveAdmission !== null
      : liveAdmission === null ||
        liveAdmission.live.observationId !== transaction.priorLive.observationId ||
        sha256(liveAdmission.bytes) !== transaction.priorLive.liveRecordSha256
  ) {
    throw new ObservationArchiveError();
  }
  const currentObservationId = liveAdmission?.live.kind === "cu.live-observation/v1"
    ? liveAdmission.live.observationId
    : null;
  validateClearTransactionShape(transaction, currentObservationId);
  validateClearTransactionHistory(transaction, runDirectory, ancestors);
  requireTransactionHistoryAbsent(transaction, { runDirectory, ancestors });
  revalidatePrivatePublishProof(capturesProof);
  revalidatePrivatePublishProof(privateProof);
  if (liveAdmission !== null) {
    revalidateStableRegularFileWitness(livePath, ancestors, liveAdmission.witness);
  }
  return Object.freeze({
    runDirectory,
    ancestors,
    capturesDirectory,
    capturesProof,
    privateProof,
    files: Object.freeze(rollbackFiles),
    liveBytes: liveAdmission === null ? null : Buffer.from(liveAdmission.bytes)
  });
}

function restoreClearRollbackProgress(proof: ClearRollbackProof): void {
  revalidatePrivatePublishProof(proof.capturesProof);
  revalidatePrivatePublishProof(proof.privateProof);
  for (const file of proof.files) {
    if (!file.fromTrash) continue;
    const targetAncestors = Object.freeze([...proof.ancestors, proof.capturesDirectory]);
    if (proveOptionalRollbackFile(file.targetPath, targetAncestors, file.source.kind) !== null) {
      throw new ObservationArchiveError();
    }
    const source = file.source.kind === "regular"
      ? readStableRegularFileWithWitness(file.source.path, file.source.ancestors)
      : readStableBinaryFileWithWitness(file.source.path, file.source.ancestors);
    if (
      !sameIdentity(file.source.identity, file.source.path) ||
      !sameDirectorySnapshot(file.source.snapshot, stableFileSnapshot(file.source.path)) ||
      sha256(source.bytes) !== file.source.bytesSha256 ||
      file.source.ancestorIdentities.some((ancestor) =>
        !sameDirectoryIdentity(ancestor.identity, ancestor.path)
      )
    ) {
      throw new ObservationArchiveError();
    }
    renameSync(file.source.path, file.targetPath);
    const restored = file.source.kind === "regular"
      ? readStableRegularFileWithWitness(file.targetPath, targetAncestors)
      : readStableBinaryFileWithWitness(file.targetPath, targetAncestors);
    if (
      !sameIdentity(file.source.identity, file.targetPath) ||
      sha256(restored.bytes) !== sha256(file.source.bytes)
    ) {
      throw new ObservationArchiveError();
    }
  }
  if (proof.privateProof.stagingDirectory !== null) {
    removeProvenPrivateDirectory(proof.privateProof.stagingDirectory, proof.privateProof);
  }
  if (proof.privateProof.trashDirectory !== null) {
    removeProvenPrivateDirectory(proof.privateProof.trashDirectory, proof.privateProof);
  }
  if (proof.privateProof.transactionDirectory !== null) {
    removeProvenPrivateDirectory(proof.privateProof.transactionDirectory, proof.privateProof);
  }
}

async function recoverClearTransaction(
  lock: RunLock,
  root: string,
  runId: string,
  active: WitnessedArchiveTransaction
): Promise<boolean> {
  const transaction = active.transaction;
  const initialRecordIdentity = privateFileIdentity(active.recordPath);
  const initialRecordSnapshot = stableFileSnapshot(active.recordPath);
  if (transaction.operation === "publish") {
    throw new ObservationArchiveError();
  }
  if (
    transaction.state === "assets_staged" &&
    transaction.operation === "clear_range" &&
    transaction.payload.invalidatesLive
  ) {
    const { runDirectory, ancestors } = directRunPaths(root, runId);
    const liveAdmission = readOptionalLive(
      join(runDirectory, "live-observation.json"),
      ancestors,
      runId,
      transaction.workspaceFingerprint
    );
    if (
      liveAdmission?.live.kind === "cu.live-observation-tombstone/v1" &&
      liveAdmission.live.invalidatedByTransactionId === transaction.transactionId &&
      liveAdmission.live.observationId === transaction.priorLive?.observationId &&
      liveAdmission.live.previousLiveRecordSha256 === transaction.priorLive?.liveRecordSha256
    ) {
      const cutoverState = await inspectRetainedArchive(
        root,
        runId,
        transaction.workspaceFingerprint
      );
      validateClearTransactionSemantics(transaction, cutoverState);
      requireClearCutoverState(transaction, cutoverState);
      provePrivateClearState(transaction, cutoverState);
      revalidateRunLock(lock, root, runId);
      revalidateStableRegularFileWitness(active.recordPath, active.ancestors, active.witness);
      if (
        !sameIdentity(initialRecordIdentity, active.recordPath) ||
        !sameDirectorySnapshot(initialRecordSnapshot, stableFileSnapshot(active.recordPath))
      ) {
        throw new ObservationArchiveError();
      }
      replaceClearTransactionState(
        root,
        runId,
        transaction,
        "assets_staged",
        transaction.updatedAt,
        initialRecordIdentity,
        initialRecordSnapshot,
        "cutover_committed",
        new Date(new Date(transaction.createdAt).getTime() + 2).toISOString(),
        active.recordPath,
        active.ancestors
      );
      const committed = inspectArchiveTransactionWithWitness(root, runId);
      if (
        committed === undefined ||
        committed.transaction.operation !== "clear_range" ||
        committed.transaction.transactionId !== transaction.transactionId ||
        committed.transaction.state !== "cutover_committed"
      ) {
        throw new ObservationArchiveError();
      }
      return recoverClearTransaction(lock, root, runId, committed);
    }
  }
  if (transaction.state === "prepared" || transaction.state === "assets_staged") {
    validateClearTransactionShape(transaction, null);
    const rollbackProof = await proveClearRollbackProgress(root, runId, transaction);
    revalidateRunLock(lock, root, runId);
    revalidateStableRegularFileWitness(active.recordPath, active.ancestors, active.witness);
    if (
      !sameIdentity(initialRecordIdentity, active.recordPath) ||
      !sameDirectorySnapshot(initialRecordSnapshot, stableFileSnapshot(active.recordPath))
    ) {
      throw new ObservationArchiveError();
    }
    restoreClearRollbackProgress(rollbackProof);
    const finalState = await inspectRetainedArchive(root, runId, workspaceFingerprint(root));
    validateClearTransactionSemantics(transaction, finalState);
    if (
      transaction.movedBundles.some((descriptor) => {
        const retained = finalState.retained.find((entry) =>
          entry.capture.observationId === descriptor.observationId
        );
        return retained === undefined || !descriptorMatches(retained.descriptor, descriptor);
      }) ||
      (rollbackProof.liveBytes === null
        ? finalState.liveBytes !== null
        : finalState.liveBytes === null ||
          !finalState.liveBytes.equals(rollbackProof.liveBytes))
    ) {
      throw new ObservationArchiveError();
    }
    requireNoPrivateTransactionState(transaction, finalState);
    revalidateRunLock(lock, root, runId);
    const finalActive = inspectArchiveTransactionWithWitness(root, runId);
    if (
      finalActive === undefined ||
      finalActive.transaction.transactionId !== transaction.transactionId ||
      finalActive.transaction.state !== transaction.state
    ) {
      throw new ObservationArchiveError();
    }
    assertStableRegularFileWitnessContinuity(
      active.recordPath,
      active.ancestors,
      active.witness,
      finalActive.witness
    );
    if (
      !sameIdentity(initialRecordIdentity, finalActive.recordPath) ||
      !sameDirectorySnapshot(initialRecordSnapshot, stableFileSnapshot(finalActive.recordPath))
    ) {
      throw new ObservationArchiveError();
    }
    removeOwnedFile(finalActive.recordPath, initialRecordIdentity);
    return true;
  }
  if (transaction.state !== "cutover_committed") {
    throw new ObservationArchiveError();
  }
  const state = await inspectRetainedArchive(
    root,
    runId,
    workspaceFingerprint(root),
    transaction.operation === "clear_all"
      ? transaction.priorLive?.observationId ?? null
      : null
  );
  validateClearTransactionSemantics(transaction, state);
  requireClearCutoverState(transaction, state);
  if (transaction.operation === "clear_range") {
    requireClearHistoryPrefix(transaction, state);
  }
  const clearAllCapturesGuard = transaction.operation === "clear_all"
    ? proveClearAllCapturesGuard(state.capturesDirectory, state.ancestors)
    : null;
  const proof = provePrivateClearState(transaction, state, false);
  const historyPath = join(state.runDirectory, "history.ndjson");
  const admittedHistory = readOptionalHistory(historyPath, state.ancestors);
  const historyIdentity = admittedHistory === null
    ? null
    : privateFileIdentity(historyPath);
  const clearAllLiveIdentity = transaction.operation === "clear_all" && state.liveBytes !== null
    ? privateFileIdentity(join(state.runDirectory, "live-observation.json"))
    : null;
  const clearAllArchivePath = join(state.runDirectory, "@archive");
  const clearAllArchiveAdmission = transaction.operation === "clear_all"
    ? admitOptionalPrivateDirectory(clearAllArchivePath)
    : null;
  const clearAllArchiveIdentity = clearAllArchiveAdmission === null
    ? null
    : directoryIdentity(clearAllArchivePath);
  revalidateRunLock(lock, root, runId);
  revalidateStableRegularFileWitness(active.recordPath, active.ancestors, active.witness);
  if (
    !sameIdentity(initialRecordIdentity, active.recordPath) ||
    !sameDirectorySnapshot(initialRecordSnapshot, stableFileSnapshot(active.recordPath))
  ) {
    throw new ObservationArchiveError();
  }
  if (transaction.operation === "clear_range") {
    appendHistoryEvents(
      historyPath,
      state.runDirectory,
      state.ancestors,
      historyLinesForTransaction(transaction),
      runId,
      transaction.workspaceFingerprint
    );
    if (historyIdentity !== null && !sameIdentity(historyIdentity, historyPath)) {
      throw new ObservationArchiveError();
    }
  } else {
    if (clearAllCapturesGuard === null) {
      throw new ObservationArchiveError();
    }
    if (clearAllLiveIdentity !== null) {
      revalidateClearAllCapturesGuard(clearAllCapturesGuard);
      removeOwnedFile(join(state.runDirectory, "live-observation.json"), clearAllLiveIdentity);
    }
    revalidateRunLock(lock, root, runId);
    if (historyIdentity !== null) {
      revalidateClearAllCapturesGuard(clearAllCapturesGuard);
      removeOwnedFile(historyPath, historyIdentity);
    }
  }
  finalizePrivatePublishState(
    proof,
    clearAllCapturesGuard === null
      ? undefined
      : () => revalidateClearAllCapturesGuard(clearAllCapturesGuard)
  );
  const finalState = await inspectRetainedArchive(root, runId, workspaceFingerprint(root));
  requireClearFinalState(state, finalState, transaction);
  if (transaction.operation === "clear_all") {
    if (clearAllCapturesGuard === null) {
      throw new ObservationArchiveError();
    }
    removeClearAllCapturesDirectory(clearAllCapturesGuard);
    revalidateClearAllCapturesGuard(clearAllCapturesGuard);
    if (clearAllArchiveIdentity === null) {
      if (optionalDirectoryEntries(clearAllArchivePath) !== null) {
        throw new ObservationArchiveError();
      }
    } else {
      removeOwnedEmptyDirectory(clearAllArchivePath, clearAllArchiveIdentity);
    }
  }
  revalidateRunLock(lock, root, runId);
  const finalActive = inspectArchiveTransactionWithWitness(root, runId);
  if (
    finalActive === undefined ||
    finalActive.transaction.transactionId !== transaction.transactionId ||
    finalActive.transaction.state !== "cutover_committed"
  ) {
    throw new ObservationArchiveError();
  }
  assertStableRegularFileWitnessContinuity(
    active.recordPath,
    active.ancestors,
    active.witness,
    finalActive.witness
  );
  if (
    !sameIdentity(initialRecordIdentity, finalActive.recordPath) ||
    !sameDirectorySnapshot(initialRecordSnapshot, stableFileSnapshot(finalActive.recordPath))
  ) {
    throw new ObservationArchiveError();
  }
  if (clearAllCapturesGuard !== null) {
    revalidateClearAllCapturesGuard(clearAllCapturesGuard);
  }
  removeOwnedFile(finalActive.recordPath, initialRecordIdentity);
  return true;
}

export async function recoverObservationArchive(
  lock: RunLock,
  workspaceRoot: string,
  runId: string
): Promise<boolean> {
  try {
    if (!isRunId(runId)) {
      throw new ObservationArchiveError();
    }
    const root = realpathSync.native(resolve(workspaceRoot));
    const fingerprint = workspaceFingerprint(root);
    revalidateRunLock(lock, root, runId);
    const active = inspectArchiveTransactionWithWitness(root, runId);
    if (active === undefined) {
      return false;
    }
    const transaction = active.transaction;
    const activeIdentity = privateFileIdentity(active.recordPath);
    revalidateStableRegularFileWitness(active.recordPath, active.ancestors, active.witness);
    if (transaction.operation !== "publish") {
      return await recoverClearTransaction(lock, root, runId, active);
    }
    validatePublishTransactionSemantics(transaction);
    const state = await inspectRetainedArchive(root, runId, fingerprint);
    const liveCutover = state.live?.kind === "cu.live-observation/v1" &&
      state.live.publishedByTransactionId === transaction.transactionId &&
      state.live.observationId === transaction.payload.newBundle.observationId &&
      sha256(state.liveBytes!) === transaction.payload.newLiveRecordSha256;
    let effectResolutionProof: EffectArchiveResolutionProof | undefined;

    if (liveCutover) {
      if (transaction.state === "prepared") {
        throw new ObservationArchiveError();
      }
      const retainedNew = state.retained.find((entry) =>
        entry.capture.observationId === transaction.payload.newBundle.observationId
      );
      if (
        retainedNew === undefined ||
        !descriptorMatches(retainedNew.descriptor, transaction.payload.newBundle) ||
        transaction.movedBundles.some((moved) =>
          state.retained.some((entry) => entry.capture.observationId === moved.observationId)
        )
      ) {
        throw new ObservationArchiveError();
      }
      const privateProof = provePrivatePublishState(transaction, state);
      if (transaction.payload.resolvesEffect !== null) {
        effectResolutionProof = await proveEffectArchiveResolution(
          lock,
          root,
          runId,
          active
        );
      }
      revalidateRunLock(lock, root, runId);
      if (
        effectResolutionProof !== undefined &&
        !effectArchiveResolutionJournalPresent(effectResolutionProof)
      ) {
        requireTransactionHistoryComplete(
          join(state.runDirectory, "history.ndjson"),
          state.ancestors,
          transaction,
          runId,
          fingerprint
        );
        if (
          privateProof.transactionDirectory !== null ||
          privateProof.stagingDirectory !== null ||
          privateProof.trashDirectory !== null ||
          privateProof.files.length !== 0
        ) {
          throw new ObservationArchiveError();
        }
        revalidatePrivatePublishProof(privateProof);
        revalidateEffectArchiveResolutionProof(
          effectResolutionProof,
          lock,
          root,
          runId
        );
      } else {
        appendHistoryEvents(
          join(state.runDirectory, "history.ndjson"),
          state.runDirectory,
          state.ancestors,
          historyLinesForTransaction(transaction),
          runId,
          fingerprint
        );
        finalizePrivatePublishState(privateProof);
      }
    } else {
      if (
        transaction.state !== "prepared" ||
        state.retained.some((entry) =>
          entry.capture.observationId === transaction.payload.newBundle.observationId
        ) ||
        transaction.movedBundles.some((moved) => {
          const retained = state.retained.find((entry) => entry.capture.observationId === moved.observationId);
          return retained === undefined || !descriptorMatches(retained.descriptor, moved);
        })
      ) {
        throw new ObservationArchiveError();
      }
      if (transaction.priorLive === null) {
        if (state.live !== null || transaction.payload.replacesObservationId !== null) {
          throw new ObservationArchiveError();
        }
      } else if (
        state.live === null ||
        state.live.observationId !== transaction.priorLive.observationId ||
        transaction.payload.replacesObservationId !== transaction.priorLive.observationId ||
        sha256(state.liveBytes!) !== transaction.priorLive.liveRecordSha256
      ) {
        throw new ObservationArchiveError();
      }
      requireTransactionHistoryAbsent(transaction, state);
      requireNoPrivateTransactionState(transaction, state);
    }

    if (!liveCutover) {
      requireTransactionHistoryAbsent(transaction, state);
      requireNoPrivateTransactionState(transaction, state);
    }
    const finalState = await inspectRetainedArchive(root, runId, fingerprint);
    if (!retainedArchiveStatesMatch(
      state,
      finalState,
      transaction.payload.newBundle.observationId
    )) {
      throw new ObservationArchiveError();
    }
    revalidateRunLock(lock, root, runId);
    const finalActive = inspectArchiveTransactionWithWitness(root, runId);
    if (
      finalActive === undefined ||
      finalActive.transaction.transactionId !== transaction.transactionId
    ) {
      throw new ObservationArchiveError();
    }
    assertStableRegularFileWitnessContinuity(
      active.recordPath,
      active.ancestors,
      active.witness,
      finalActive.witness
    );
    if (liveCutover && transaction.payload.resolvesEffect !== null) {
      if (effectResolutionProof === undefined) {
        throw new ObservationArchiveError();
      }
      finalizeEffectJournalForArchiveTransaction(
        lock,
        root,
        runId,
        effectResolutionProof
      );
    }
    removeOwnedFile(active.recordPath, activeIdentity);
    return true;
  } catch {
    throw new ObservationArchiveError();
  }
}

function buildLiveRecord(
  capture: CaptureSidecar,
  transactionId: string,
  captureMetadataSha256: string
): BundleBoundLiveObservation {
  return {
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId: capture.runId,
    workspaceFingerprint: capture.workspaceFingerprint,
    observationId: capture.observationId,
    publishedByTransactionId: transactionId,
    captureMetadataSha256,
    capturedAt: capture.capturedAt,
    expiresAt: capture.expiresAt,
    coordinateSpace: capture.coordinateSpace,
    source: { ...capture.source },
    environmentFingerprint: capture.environmentFingerprint,
    topologyFingerprint: capture.topologyFingerprint,
    image: { ...capture.image },
    state: "actionable",
    stateChangedAt: capture.capturedAt
  };
}

function archiveBundleForCapture(bundle: ValidatedCaptureBundle): ArchiveBundle {
  return {
    observationId: bundle.capture.observationId,
    captureMetadataSha256: bundle.captureMetadataSha256,
    imageSha256: bundle.capture.image.sha256,
    imageByteLength: bundle.capture.image.byteLength
  };
}

export async function publishCaptureObservation(
  lock: RunLock,
  workspaceRoot: string,
  runId: string,
  bundle: ValidatedCaptureBundle,
  options: PublishCaptureObservationOptions = {}
): Promise<PublishedCaptureObservation> {
  let preparedPublished = false;
  let cutoverCompleted = false;
  try {
    if (!isRunId(runId)) {
      throw new ObservationArchiveError();
    }
    const copied = copyValidatedCaptureBundleBytes(bundle);
    const root = realpathSync.native(resolve(workspaceRoot));
    const fingerprint = workspaceFingerprint(root);
    if (bundle.capture.runId !== runId || bundle.capture.workspaceFingerprint !== fingerprint) {
      throw new ObservationArchiveError();
    }
    revalidateRunLock(lock, root, runId);
    await recoverObservationArchive(lock, root, runId);
    const resolvesEffect = options.resolveEffect === undefined
      ? null
      : revalidateEffectResolutionDescriptor(options.resolveEffect, lock, root, runId);
    if (inspectArchiveTransactionWithWitness(root, runId) !== undefined) {
      throw new ObservationArchiveError();
    }
    let archiveState = await inspectRetainedArchive(root, runId, fingerprint);
    if (archiveState.retained.some((entry) => entry.capture.observationId === bundle.capture.observationId)) {
      throw new ObservationArchiveError();
    }
    const retentionPlan = planObservationRetention(
      archiveState.retained.map((entry) => ({
        observationId: entry.capture.observationId,
        capturedAt: entry.capture.capturedAt,
        committedBytes: entry.committedBytes
      })),
      archiveState.currentObservationId,
      copied.captureMetadata.length + copied.image.length
    );
    const selectedForEviction = retentionPlan.evictedObservationIds.map((id) => {
      const selected = archiveState.retained.find((entry) => entry.capture.observationId === id);
      if (selected === undefined) {
        throw new ObservationArchiveError();
      }
      return selected;
    });

    const transactionId = options.createTransactionId?.() ?? randomToken("txn");
    const createdAtDate = options.now?.() ?? new Date();
    const createdAtMilliseconds = createdAtDate.getTime();
    if (!Number.isFinite(createdAtMilliseconds)) {
      throw new ObservationArchiveError();
    }
    const updatedAt = createdAtDate.toISOString();
    const assetsUpdatedAt = new Date(createdAtMilliseconds + 1).toISOString();
    const cutoverUpdatedAt = new Date(createdAtMilliseconds + 2).toISOString();
    const historyEventIds = Array.from(
      { length: selectedForEviction.length + 1 + (resolvesEffect === null ? 0 : 1) },
      (_, index) => options.createHistoryEventId?.(index) ?? randomToken("hist", `_${index + 1}`)
    );
    if (
      !transactionIdPattern.test(transactionId) ||
      historyEventIds.some((id) => !historyEventIdPattern.test(id)) ||
      new Set(historyEventIds).size !== historyEventIds.length
    ) {
      throw new ObservationArchiveError();
    }
    const captureDescriptor = archiveBundleForCapture(bundle);
    const historyEvents: ArchiveHistoryEvent[] = [
      ...selectedForEviction.map((entry, index) => ({
        eventId: historyEventIds[index]!,
        at: updatedAt,
        eventType: "capture_evicted" as const,
        observationId: entry.capture.observationId,
        capturedAt: entry.capture.capturedAt
      })),
      {
        eventId: historyEventIds[selectedForEviction.length]!,
        at: updatedAt,
        eventType: "capture_retained",
        observationId: bundle.capture.observationId,
        capturedAt: bundle.capture.capturedAt
      },
      ...(resolvesEffect === null ? [] : [{
        eventId: historyEventIds[selectedForEviction.length + 1]!,
        at: updatedAt,
        eventType: "effect_recovered" as const,
        effectId: resolvesEffect.effectId,
        recoveryObservationId: bundle.capture.observationId
      }])
    ];
    const liveRecord = buildLiveRecord(bundle.capture, transactionId, bundle.captureMetadataSha256);
    validateBundleBoundLiveObservation(liveRecord, bundle.capture, bundle.captureMetadataSha256);
    const liveBytes = jsonBytes(liveRecord);
    parseLiveObservationBytes(liveBytes, { runId, workspaceFingerprint: fingerprint });
    const priorLive = archiveState.live === null
      ? null
      : {
          observationId: archiveState.live.observationId,
          liveRecordSha256: sha256(archiveState.liveBytes!)
        };

    const preparedTransaction: PublishArchiveTransaction = {
      kind: "cu.archive-transaction/v1",
      schemaVersion: 1,
      runId,
      workspaceFingerprint: fingerprint,
      transactionId,
      operation: "publish",
      state: "prepared",
      createdAt: updatedAt,
      updatedAt,
      priorLive,
      movedBundles: selectedForEviction.map((entry) => entry.descriptor),
      historyEvents,
      payload: {
        newBundle: captureDescriptor,
        newLiveRecordSha256: sha256(liveBytes),
        replacesObservationId: archiveState.live?.observationId ?? null,
        resolvesEffect
      }
    };
    validatePublishTransactionSemantics(preparedTransaction);
    const historyBytes = historyLinesForTransaction(preparedTransaction);
    const preparedBytes = jsonBytes(preparedTransaction);
    revalidateRunLock(lock, root, runId);
    if (requireHistoryCapacityBeforePrepared(
      preparedTransaction,
      archiveState,
      () => revalidateRunLock(lock, root, runId)
    )) {
      const refreshedArchiveState = await inspectRetainedArchive(root, runId, fingerprint);
      if (!retainedArchiveStatesMatch(archiveState, refreshedArchiveState, null)) {
        throw new ObservationArchiveError();
      }
      archiveState = refreshedArchiveState;
    }
    if (options.resolveEffect !== undefined) {
      const finalResolution = revalidateEffectResolutionDescriptor(
        options.resolveEffect,
        lock,
        root,
        runId
      );
      if (
        resolvesEffect === null ||
        finalResolution.effectId !== resolvesEffect.effectId ||
        finalResolution.journalSha256 !== resolvesEffect.journalSha256
      ) {
        throw new ObservationArchiveError();
      }
    }
    publishPreparedArchiveTransaction(lock, root, runId, preparedBytes);
    preparedPublished = true;
    const layout = prepareArchiveTransactionLayout(lock, root, runId);
    const layoutPaths = inspectArchiveTransactionLayout(layout, lock, root, runId);
    const captureJsonName = `${bundle.capture.observationId}.json`;
    const capturePngName = `${bundle.capture.observationId}.png`;
    const stagingMetadataPath = join(layoutPaths.stagingDirectory, captureJsonName);
    const stagingImagePath = join(layoutPaths.stagingDirectory, capturePngName);
    const stagingAncestors = Object.freeze([
      ...layoutPaths.ancestors,
      layoutPaths.archiveDirectory,
      layoutPaths.transactionDirectory,
      layoutPaths.stagingDirectory
    ]);
    const stagingMetadataIdentity = createOnceRegularFile(
      stagingMetadataPath,
      layoutPaths.stagingDirectory,
      stagingAncestors,
      copied.captureMetadata
    );
    const stagingImageIdentity = createOnceBinaryFile(
      stagingImagePath,
      layoutPaths.stagingDirectory,
      stagingAncestors,
      copied.image
    );

    revalidateRunLock(lock, root, runId);
    ensureDirectory(layoutPaths.capturesDirectory, layoutPaths.ancestors[1]!);
    const capturesAncestors = Object.freeze([...layoutPaths.ancestors, layoutPaths.capturesDirectory]);
    const captureMetadataPath = join(layoutPaths.capturesDirectory, captureJsonName);
    const imagePath = join(layoutPaths.capturesDirectory, capturePngName);
    publishStagedRegularFile(
      stagingMetadataPath,
      captureMetadataPath,
      capturesAncestors,
      stagingMetadataIdentity,
      copied.captureMetadata
    );
    publishStagedBinaryFile(
      stagingImagePath,
      imagePath,
      capturesAncestors,
      stagingImageIdentity,
      copied.image
    );

    const trashAncestors = Object.freeze([
      ...layoutPaths.ancestors,
      layoutPaths.archiveDirectory,
      layoutPaths.transactionDirectory,
      layoutPaths.trashDirectory
    ]);
    for (const entry of selectedForEviction) {
      moveRetainedCaptureToTrash(
        entry,
        capturesAncestors,
        layoutPaths.trashDirectory,
        trashAncestors
      );
    }

    const assetsTransaction: PublishArchiveTransaction = {
      ...preparedTransaction,
      state: "assets_staged",
      updatedAt: assetsUpdatedAt
    };
    const stagedAssets = stageValidatedControlRecord(
      layoutPaths.recordPath,
      layoutPaths.ancestors[1]!,
      layoutPaths.ancestors,
      jsonBytes(assetsTransaction),
      (candidate) => {
        const parsed = parseArchiveTransactionBytes(candidate, {
          runId,
          workspaceFingerprint: fingerprint
        });
        if (parsed.transactionId !== transactionId || parsed.state !== "assets_staged") {
          throw new ObservationArchiveError();
        }
      }
    );
    const activeBeforeAssets = inspectArchiveTransactionWithWitness(root, runId);
    if (
      activeBeforeAssets === undefined ||
      activeBeforeAssets.transaction.transactionId !== transactionId ||
      activeBeforeAssets.transaction.state !== "prepared"
    ) {
      throw new ObservationArchiveError();
    }
    replaceWitnessedControlRecord(
      layoutPaths.recordPath,
      layoutPaths.ancestors[1]!,
      layoutPaths.ancestors,
      activeBeforeAssets.witness,
      stagedAssets
    );

    revalidateRunLock(lock, root, runId);
    const liveAncestors = layoutPaths.ancestors;
    const stagedLive = stageValidatedControlRecord(
      layoutPaths.liveObservationPath,
      liveAncestors[1]!,
      liveAncestors,
      liveBytes,
      (candidate) => {
        parseLiveObservationBytes(candidate, { runId, workspaceFingerprint: fingerprint });
      }
    );
    const liveBaseline = captureStableAncestorBaseline(layoutPaths.liveObservationPath, liveAncestors);
    const existingLive = readStableOptionalRegularFileWithWitnessAgainstBaseline(
      layoutPaths.liveObservationPath,
      liveAncestors,
      liveBaseline
    );
    revalidateRunLock(lock, root, runId);
    if (existingLive === undefined) {
      const livePublished = publishStagedControlRecordCreateOnce(
        layoutPaths.liveObservationPath,
        liveAncestors[1]!,
        liveAncestors,
        stagedLive
      );
      if (livePublished === undefined) {
        throw new ObservationArchivePublicationUncertainError();
      }
    } else {
      replaceWitnessedControlRecord(
        layoutPaths.liveObservationPath,
        liveAncestors[1]!,
        liveAncestors,
        existingLive.witness,
        stagedLive
      );
    }

    cutoverCompleted = true;
    const cutoverTransaction: PublishArchiveTransaction = {
      ...preparedTransaction,
      state: "cutover_committed",
      updatedAt: cutoverUpdatedAt
    };
    const stagedCutover = stageValidatedControlRecord(
      layoutPaths.recordPath,
      layoutPaths.ancestors[1]!,
      layoutPaths.ancestors,
      jsonBytes(cutoverTransaction),
      (candidate) => {
        const parsed = parseArchiveTransactionBytes(candidate, {
          runId,
          workspaceFingerprint: fingerprint
        });
        if (parsed.transactionId !== transactionId || parsed.state !== "cutover_committed") {
          throw new ObservationArchiveError();
        }
      }
    );
    const activeBeforeCutoverState = inspectArchiveTransactionWithWitness(root, runId);
    if (
      activeBeforeCutoverState === undefined ||
      activeBeforeCutoverState.transaction.transactionId !== transactionId ||
      activeBeforeCutoverState.transaction.state !== "assets_staged"
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    replaceWitnessedControlRecord(
      layoutPaths.recordPath,
      layoutPaths.ancestors[1]!,
      layoutPaths.ancestors,
      activeBeforeCutoverState.witness,
      stagedCutover
    );
    const committedActive = inspectArchiveTransactionWithWitness(root, runId);
    if (
      committedActive === undefined ||
      committedActive.transaction.transactionId !== transactionId ||
      committedActive.transaction.operation !== "publish" ||
      committedActive.transaction.state !== "cutover_committed"
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    const committedActiveIdentity = privateFileIdentity(committedActive.recordPath);
    revalidateStableRegularFileWitness(
      committedActive.recordPath,
      committedActive.ancestors,
      committedActive.witness
    );
    const committedState = await inspectRetainedArchive(root, runId, fingerprint);
    const evictedIds = new Set(selectedForEviction.map((entry) => entry.capture.observationId));
    const expectedDescriptors = new Map(
      archiveState.retained
        .filter((entry) => !evictedIds.has(entry.capture.observationId))
        .map((entry) => [entry.capture.observationId, entry.descriptor])
    );
    expectedDescriptors.set(captureDescriptor.observationId, captureDescriptor);
    if (
      committedState.currentObservationId !== bundle.capture.observationId ||
      committedState.liveBytes === null ||
      sha256(committedState.liveBytes) !== preparedTransaction.payload.newLiveRecordSha256 ||
      committedState.retained.length !== expectedDescriptors.size ||
      committedState.retained.some((entry) => {
        const expected = expectedDescriptors.get(entry.capture.observationId);
        return expected === undefined || !descriptorMatches(expected, entry.descriptor);
      })
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    const privateProof = provePrivatePublishState(cutoverTransaction, committedState);
    const effectResolutionProof = cutoverTransaction.payload.resolvesEffect === null
      ? undefined
      : await proveEffectArchiveResolution(
          lock,
          root,
          runId,
          committedActive,
          options.resolveEffect
        );
    revalidateRunLock(lock, root, runId);
    appendHistoryEvents(
      layoutPaths.historyPath,
      liveAncestors[1]!,
      liveAncestors,
      historyBytes,
      runId,
      fingerprint
    );
    finalizePrivatePublishState(privateProof);
    const finalState = await inspectRetainedArchive(root, runId, fingerprint);
    if (!retainedArchiveStatesMatch(
      committedState,
      finalState,
      bundle.capture.observationId
    )) {
      throw new ObservationArchivePublicationUncertainError();
    }
    revalidateRunLock(lock, root, runId);
    const finalActive = inspectArchiveTransactionWithWitness(root, runId);
    if (
      finalActive === undefined ||
      finalActive.transaction.transactionId !== transactionId ||
      finalActive.transaction.operation !== "publish" ||
      finalActive.transaction.state !== "cutover_committed"
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    assertStableRegularFileWitnessContinuity(
      committedActive.recordPath,
      committedActive.ancestors,
      committedActive.witness,
      finalActive.witness
    );
    if (cutoverTransaction.payload.resolvesEffect !== null) {
      if (effectResolutionProof === undefined) {
        throw new ObservationArchivePublicationUncertainError();
      }
      finalizeEffectJournalForArchiveTransaction(
        lock,
        root,
        runId,
        effectResolutionProof
      );
    }
    removeOwnedFile(committedActive.recordPath, committedActiveIdentity);

    return Object.freeze({
      observationId: bundle.capture.observationId,
      transactionId,
      liveObservationPath: layoutPaths.liveObservationPath,
      captureMetadataPath,
      imagePath,
      historyPath: layoutPaths.historyPath,
      evictedHistoryCount: retentionPlan.evictedHistoryCount
    });
  } catch (error) {
    if (error instanceof ObservationArchiveQuotaError) {
      throw error;
    }
    if (
      preparedPublished ||
      cutoverCompleted ||
      error instanceof ObservationArchivePublicationUncertainError ||
      error instanceof ArchiveStorePublicationUncertainError ||
      error instanceof ControlRecordPublicationUncertainError ||
      error instanceof ControlRecordReplacementUncertainError
    ) {
      throw new ObservationArchivePublicationUncertainError();
    }
    throw new ObservationArchiveError();
  }
}
