import { isRunId } from "./identifiers.js";
import {
  parseStrictJsonBytes,
  type StrictJsonObject
} from "./strict-json.js";

const MAX_RECORD_BYTES = 65_536;
const MAX_JSON_DEPTH = 64;
const captureSidecarKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "observationId",
  "capturedAt",
  "expiresAt",
  "coordinateSpace",
  "source",
  "environmentFingerprint",
  "topologyFingerprint",
  "image"
];
const captureSourceKeys = [
  "captureKind",
  "mapping",
  "leftPx",
  "topPx",
  "widthPx",
  "heightPx"
];
const captureImageKeys = ["mediaType", "sha256", "byteLength", "width", "height"];
const actionableLiveKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "observationId",
  "publishedByTransactionId",
  "captureMetadataSha256",
  "capturedAt",
  "expiresAt",
  "coordinateSpace",
  "source",
  "environmentFingerprint",
  "topologyFingerprint",
  "image",
  "state",
  "stateChangedAt"
];
const consumedLiveKeys = [...actionableLiveKeys, "consumedByEffectId"];
const tombstoneLiveKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "observationId",
  "previousLiveRecordSha256",
  "invalidatedReason",
  "invalidatedAt",
  "invalidatedByTransactionId"
];
const MAX_IMAGE_BYTES = 67_108_864;
const MAX_PIXEL_DIMENSION = 32_768;
const MAX_SOURCE_OFFSET = 1_000_000;
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const transactionIdPattern = /^txn_[a-f0-9]{32}$/;
const effectIdPattern = /^eff_[a-f0-9]{32}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class ObservationRecordError extends Error {}

export type RecordBinding = {
  runId: string;
  workspaceFingerprint: string;
};

export type CaptureSource = {
  captureKind: "full" | "region";
  mapping: "normalized_endpoint_centers/v1";
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
};

export type CaptureImage = {
  mediaType: "image/png";
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
};

function hasExactKeys(value: StrictJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireObject(value: unknown): StrictJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ObservationRecordError();
  }
  return value as StrictJsonObject;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
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

function hasCanonicalRecordBinding(
  root: StrictJsonObject,
  expected: RecordBinding
): boolean {
  return (
    typeof root.runId === "string" &&
    isRunId(root.runId) &&
    typeof root.workspaceFingerprint === "string" &&
    sha256Pattern.test(root.workspaceFingerprint) &&
    typeof expected?.runId === "string" &&
    isRunId(expected.runId) &&
    typeof expected?.workspaceFingerprint === "string" &&
    sha256Pattern.test(expected.workspaceFingerprint) &&
    root.runId === expected.runId &&
    root.workspaceFingerprint === expected.workspaceFingerprint
  );
}

function hasValidCaptureMetadata(
  root: StrictJsonObject,
  source: StrictJsonObject,
  image: StrictJsonObject,
  expected: RecordBinding
): boolean {
  return (
    hasExactKeys(source, captureSourceKeys) &&
    hasExactKeys(image, captureImageKeys) &&
    hasCanonicalRecordBinding(root, expected) &&
    typeof root.observationId === "string" &&
    observationIdPattern.test(root.observationId) &&
    isCanonicalTimestamp(root.capturedAt) &&
    isCanonicalTimestamp(root.expiresAt) &&
    new Date(root.expiresAt).getTime() === new Date(root.capturedAt).getTime() + 60_000 &&
    root.coordinateSpace === "normalized_999_top_left" &&
    (source.captureKind === "full" || source.captureKind === "region") &&
    source.mapping === "normalized_endpoint_centers/v1" &&
    isIntegerInRange(source.leftPx, -MAX_SOURCE_OFFSET, MAX_SOURCE_OFFSET) &&
    isIntegerInRange(source.topPx, -MAX_SOURCE_OFFSET, MAX_SOURCE_OFFSET) &&
    isIntegerInRange(source.widthPx, 1, MAX_PIXEL_DIMENSION) &&
    isIntegerInRange(source.heightPx, 1, MAX_PIXEL_DIMENSION) &&
    typeof root.environmentFingerprint === "string" &&
    sha256Pattern.test(root.environmentFingerprint) &&
    typeof root.topologyFingerprint === "string" &&
    sha256Pattern.test(root.topologyFingerprint) &&
    image.mediaType === "image/png" &&
    typeof image.sha256 === "string" &&
    sha256Pattern.test(image.sha256) &&
    isIntegerInRange(image.byteLength, 1, MAX_IMAGE_BYTES) &&
    isIntegerInRange(image.width, 1, MAX_PIXEL_DIMENSION) &&
    isIntegerInRange(image.height, 1, MAX_PIXEL_DIMENSION)
  );
}

function parseRecordObject(bytes: Uint8Array): StrictJsonObject {
  try {
    const value = parseStrictJsonBytes(bytes, {
      maxBytes: MAX_RECORD_BYTES,
      maxDepth: MAX_JSON_DEPTH
    });
    return requireObject(value);
  } catch {
    throw new ObservationRecordError();
  }
}

export type CaptureSidecar = {
  kind: "cu.capture/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  observationId: string;
  capturedAt: string;
  expiresAt: string;
  coordinateSpace: "normalized_999_top_left";
  source: CaptureSource;
  environmentFingerprint: string;
  topologyFingerprint: string;
  image: CaptureImage;
};

type BundleBoundLiveObservationBase = {
  kind: "cu.live-observation/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  observationId: string;
  publishedByTransactionId: string;
  captureMetadataSha256: string;
  capturedAt: string;
  expiresAt: string;
  coordinateSpace: "normalized_999_top_left";
  source: CaptureSource;
  environmentFingerprint: string;
  topologyFingerprint: string;
  image: CaptureImage;
  stateChangedAt: string;
};

export type ActionableBundleBoundLiveObservation = BundleBoundLiveObservationBase & {
  state: "actionable";
};

export type ConsumedBundleBoundLiveObservation = BundleBoundLiveObservationBase & {
  state: "consumed";
  consumedByEffectId: string;
};

export type BundleBoundLiveObservation =
  | ActionableBundleBoundLiveObservation
  | ConsumedBundleBoundLiveObservation;

export type LiveObservationTombstone = {
  kind: "cu.live-observation-tombstone/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  observationId: string;
  previousLiveRecordSha256: string;
  invalidatedReason: "expired" | "environment_changed" | "cleared";
  invalidatedAt: string;
  invalidatedByTransactionId: string | null;
};

export type LiveObservation = BundleBoundLiveObservation | LiveObservationTombstone;

export function parseCaptureSidecarBytes(
  bytes: Uint8Array,
  expected: RecordBinding
): CaptureSidecar {
  const root = parseRecordObject(bytes);
  if (!hasExactKeys(root, captureSidecarKeys)) {
    throw new ObservationRecordError();
  }
  const source = requireObject(root.source);
  const image = requireObject(root.image);
  if (
    root.kind !== "cu.capture/v1" ||
    root.schemaVersion !== 1 ||
    !hasValidCaptureMetadata(root, source, image, expected)
  ) {
    throw new ObservationRecordError();
  }

  return {
    kind: root.kind as "cu.capture/v1",
    schemaVersion: root.schemaVersion as 1,
    runId: root.runId as string,
    workspaceFingerprint: root.workspaceFingerprint as string,
    observationId: root.observationId as string,
    capturedAt: root.capturedAt as string,
    expiresAt: root.expiresAt as string,
    coordinateSpace: root.coordinateSpace as "normalized_999_top_left",
    source: {
      captureKind: source.captureKind as "full" | "region",
      mapping: source.mapping as "normalized_endpoint_centers/v1",
      leftPx: source.leftPx as number,
      topPx: source.topPx as number,
      widthPx: source.widthPx as number,
      heightPx: source.heightPx as number
    },
    environmentFingerprint: root.environmentFingerprint as string,
    topologyFingerprint: root.topologyFingerprint as string,
    image: {
      mediaType: image.mediaType as "image/png",
      sha256: image.sha256 as string,
      byteLength: image.byteLength as number,
      width: image.width as number,
      height: image.height as number
    }
  };
}

export function validateBundleBoundLiveObservation(
  live: BundleBoundLiveObservation,
  capture: CaptureSidecar,
  captureMetadataSha256: string
): void {
  if (
    !sha256Pattern.test(captureMetadataSha256) ||
    live.captureMetadataSha256 !== captureMetadataSha256 ||
    live.runId !== capture.runId ||
    live.workspaceFingerprint !== capture.workspaceFingerprint ||
    live.observationId !== capture.observationId ||
    live.capturedAt !== capture.capturedAt ||
    live.expiresAt !== capture.expiresAt ||
    live.coordinateSpace !== capture.coordinateSpace ||
    live.source.captureKind !== capture.source.captureKind ||
    live.source.mapping !== capture.source.mapping ||
    live.source.leftPx !== capture.source.leftPx ||
    live.source.topPx !== capture.source.topPx ||
    live.source.widthPx !== capture.source.widthPx ||
    live.source.heightPx !== capture.source.heightPx ||
    live.environmentFingerprint !== capture.environmentFingerprint ||
    live.topologyFingerprint !== capture.topologyFingerprint ||
    live.image.mediaType !== capture.image.mediaType ||
    live.image.sha256 !== capture.image.sha256 ||
    live.image.byteLength !== capture.image.byteLength ||
    live.image.width !== capture.image.width ||
    live.image.height !== capture.image.height
  ) {
    throw new ObservationRecordError();
  }
}

export function parseLiveObservationBytes(
  bytes: Uint8Array,
  expected: RecordBinding
): LiveObservation {
  const root = parseRecordObject(bytes);
  if (root.kind === "cu.live-observation-tombstone/v1") {
    if (
      !hasExactKeys(root, tombstoneLiveKeys) ||
      root.schemaVersion !== 1 ||
      !hasCanonicalRecordBinding(root, expected) ||
      typeof root.observationId !== "string" ||
      !observationIdPattern.test(root.observationId) ||
      typeof root.previousLiveRecordSha256 !== "string" ||
      !sha256Pattern.test(root.previousLiveRecordSha256) ||
      (root.invalidatedReason !== "expired" &&
        root.invalidatedReason !== "environment_changed" &&
        root.invalidatedReason !== "cleared") ||
      !isCanonicalTimestamp(root.invalidatedAt) ||
      (root.invalidatedByTransactionId !== null &&
        (typeof root.invalidatedByTransactionId !== "string" ||
          !transactionIdPattern.test(root.invalidatedByTransactionId))) ||
      (root.invalidatedReason === "cleared" && root.invalidatedByTransactionId === null) ||
      ((root.invalidatedReason === "expired" ||
        root.invalidatedReason === "environment_changed") &&
        root.invalidatedByTransactionId !== null)
    ) {
      throw new ObservationRecordError();
    }
    return {
      kind: root.kind,
      schemaVersion: root.schemaVersion as 1,
      runId: root.runId as string,
      workspaceFingerprint: root.workspaceFingerprint as string,
      observationId: root.observationId as string,
      previousLiveRecordSha256: root.previousLiveRecordSha256 as string,
      invalidatedReason: root.invalidatedReason as
        | "expired"
        | "environment_changed"
        | "cleared",
      invalidatedAt: root.invalidatedAt as string,
      invalidatedByTransactionId: root.invalidatedByTransactionId as string | null
    };
  }
  const isActionable = root.state === "actionable";
  const isConsumed = root.state === "consumed";
  if (
    (!isActionable && !isConsumed) ||
    (isActionable && !hasExactKeys(root, actionableLiveKeys)) ||
    (isConsumed && !hasExactKeys(root, consumedLiveKeys))
  ) {
    throw new ObservationRecordError();
  }
  const source = requireObject(root.source);
  const image = requireObject(root.image);
  if (
    root.kind !== "cu.live-observation/v1" ||
    root.schemaVersion !== 1 ||
    !hasValidCaptureMetadata(root, source, image, expected) ||
    typeof root.publishedByTransactionId !== "string" ||
    !transactionIdPattern.test(root.publishedByTransactionId) ||
    typeof root.captureMetadataSha256 !== "string" ||
    !sha256Pattern.test(root.captureMetadataSha256) ||
    (isActionable && root.stateChangedAt !== root.capturedAt) ||
    (isConsumed &&
      (typeof root.consumedByEffectId !== "string" ||
        !effectIdPattern.test(root.consumedByEffectId) ||
        !isCanonicalTimestamp(root.stateChangedAt)))
  ) {
    throw new ObservationRecordError();
  }

  const common = {
    kind: root.kind as "cu.live-observation/v1",
    schemaVersion: root.schemaVersion as 1,
    runId: root.runId as string,
    workspaceFingerprint: root.workspaceFingerprint as string,
    observationId: root.observationId as string,
    publishedByTransactionId: root.publishedByTransactionId as string,
    captureMetadataSha256: root.captureMetadataSha256 as string,
    capturedAt: root.capturedAt as string,
    expiresAt: root.expiresAt as string,
    coordinateSpace: root.coordinateSpace as "normalized_999_top_left",
    source: {
      captureKind: source.captureKind as "full" | "region",
      mapping: source.mapping as "normalized_endpoint_centers/v1",
      leftPx: source.leftPx as number,
      topPx: source.topPx as number,
      widthPx: source.widthPx as number,
      heightPx: source.heightPx as number
    },
    environmentFingerprint: root.environmentFingerprint as string,
    topologyFingerprint: root.topologyFingerprint as string,
    image: {
      mediaType: image.mediaType as "image/png",
      sha256: image.sha256 as string,
      byteLength: image.byteLength as number,
      width: image.width as number,
      height: image.height as number
    },
    stateChangedAt: root.stateChangedAt as string
  };
  if (isActionable) {
    return { ...common, state: "actionable" };
  }
  return {
    ...common,
    state: "consumed",
    consumedByEffectId: root.consumedByEffectId as string
  };
}
