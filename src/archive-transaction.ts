import {
  parseStrictJsonBytes,
  type StrictJsonObject
} from "./strict-json.js";
import { isRunId } from "./identifiers.js";

const transactionIdPattern = /^txn_[a-f0-9]{32}$/;
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const effectIdPattern = /^eff_[a-f0-9]{32}$/;
const historyEventIdPattern = /^hist_[a-f0-9]{32}_[1-9][0-9]{0,3}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const priorLiveKeys = ["observationId", "liveRecordSha256"];
const bundleKeys = [
  "observationId",
  "captureMetadataSha256",
  "imageSha256",
  "imageByteLength"
];
const MAX_IMAGE_BYTES = 67_108_864;
const captureHistoryEventKeys = ["eventId", "at", "eventType", "observationId", "capturedAt"];
const effectRecoveryHistoryEventKeys = [
  "eventId",
  "at",
  "eventType",
  "effectId",
  "recoveryObservationId"
];
const captureHistoryEventTypes = new Set([
  "capture_retained",
  "capture_evicted",
  "capture_cleared"
]);
const publishPayloadKeys = [
  "newBundle",
  "newLiveRecordSha256",
  "replacesObservationId",
  "resolvesEffect"
];
const resolvesEffectKeys = ["effectId", "journalSha256"];
const clearRangePayloadKeys = ["invalidatesLive", "selectedObservationIds"];
const clearAllPayloadKeys = ["deletesLiveRecord", "selectedObservationIds"];

const transactionRootKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "transactionId",
  "operation",
  "state",
  "createdAt",
  "updatedAt",
  "priorLive",
  "movedBundles",
  "historyEvents",
  "payload"
];

export class ArchiveTransactionError extends Error {}

export type ArchiveTransactionBinding = {
  runId: string;
  workspaceFingerprint: string;
};

export type ArchivePriorLive = {
  observationId: string;
  liveRecordSha256: string;
} | null;

export type ArchiveBundle = {
  observationId: string;
  captureMetadataSha256: string;
  imageSha256: string;
  imageByteLength: number;
};

export type CaptureArchiveHistoryEvent = {
  eventId: string;
  at: string;
  eventType: "capture_retained" | "capture_evicted" | "capture_cleared";
  observationId: string;
  capturedAt: string;
};

export type EffectRecoveryArchiveHistoryEvent = {
  eventId: string;
  at: string;
  eventType: "effect_recovered";
  effectId: string;
  recoveryObservationId: string;
};

export type ArchiveHistoryEvent =
  | CaptureArchiveHistoryEvent
  | EffectRecoveryArchiveHistoryEvent;

type ArchiveTransactionBase = {
  kind: "cu.archive-transaction/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  transactionId: string;
  state: "prepared" | "assets_staged" | "cutover_committed";
  createdAt: string;
  updatedAt: string;
  priorLive: ArchivePriorLive;
  movedBundles: ArchiveBundle[];
  historyEvents: ArchiveHistoryEvent[];
};

export type ArchiveResolvesEffect = {
  effectId: string;
  journalSha256: string;
};

export type PublishArchiveTransaction = ArchiveTransactionBase & {
  operation: "publish";
  payload: {
    newBundle: ArchiveBundle;
    newLiveRecordSha256: string;
    replacesObservationId: string | null;
    resolvesEffect: ArchiveResolvesEffect | null;
  };
};

export type ClearRangeArchiveTransaction = ArchiveTransactionBase & {
  operation: "clear_range";
  payload: {
    invalidatesLive: boolean;
    selectedObservationIds: string[];
  };
};

export type ClearAllArchiveTransaction = ArchiveTransactionBase & {
  operation: "clear_all";
  payload: {
    deletesLiveRecord: true;
    selectedObservationIds: string[];
  };
};

export type ArchiveTransaction =
  | PublishArchiveTransaction
  | ClearRangeArchiveTransaction
  | ClearAllArchiveTransaction;

function hasExactKeys(value: StrictJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireObject(value: unknown): StrictJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchiveTransactionError();
  }
  return value as StrictJsonObject;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
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

function parsePriorLive(value: unknown): ArchivePriorLive {
  if (value === null) {
    return null;
  }
  const priorLive = requireObject(value);
  if (
    !hasExactKeys(priorLive, priorLiveKeys) ||
    typeof priorLive.observationId !== "string" ||
    !observationIdPattern.test(priorLive.observationId) ||
    typeof priorLive.liveRecordSha256 !== "string" ||
    !sha256Pattern.test(priorLive.liveRecordSha256)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    observationId: priorLive.observationId,
    liveRecordSha256: priorLive.liveRecordSha256
  };
}

function parseBundle(value: unknown): ArchiveBundle {
  const bundle = requireObject(value);
  if (
    !hasExactKeys(bundle, bundleKeys) ||
    typeof bundle.observationId !== "string" ||
    !observationIdPattern.test(bundle.observationId) ||
    typeof bundle.captureMetadataSha256 !== "string" ||
    !sha256Pattern.test(bundle.captureMetadataSha256) ||
    typeof bundle.imageSha256 !== "string" ||
    !sha256Pattern.test(bundle.imageSha256) ||
    !isIntegerInRange(bundle.imageByteLength, 1, MAX_IMAGE_BYTES)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    observationId: bundle.observationId,
    captureMetadataSha256: bundle.captureMetadataSha256,
    imageSha256: bundle.imageSha256,
    imageByteLength: bundle.imageByteLength
  };
}

function parseBundles(value: unknown): ArchiveBundle[] {
  if (!Array.isArray(value)) {
    throw new ArchiveTransactionError();
  }
  return value.map(parseBundle);
}

function parseHistoryEvent(value: unknown): ArchiveHistoryEvent {
  const event = requireObject(value);
  const isCapture = typeof event.eventType === "string" && captureHistoryEventTypes.has(event.eventType);
  const isEffectRecovery = event.eventType === "effect_recovered";
  if (
    (!isCapture && !isEffectRecovery) ||
    (isCapture && !hasExactKeys(event, captureHistoryEventKeys)) ||
    (isEffectRecovery && !hasExactKeys(event, effectRecoveryHistoryEventKeys)) ||
    typeof event.eventId !== "string" ||
    !historyEventIdPattern.test(event.eventId) ||
    !isCanonicalTimestamp(event.at)
  ) {
    throw new ArchiveTransactionError();
  }
  if (isCapture) {
    if (
      typeof event.observationId !== "string" ||
      !observationIdPattern.test(event.observationId) ||
      !isCanonicalTimestamp(event.capturedAt)
    ) {
      throw new ArchiveTransactionError();
    }
    return {
      eventId: event.eventId,
      at: event.at,
      eventType: event.eventType as CaptureArchiveHistoryEvent["eventType"],
      observationId: event.observationId,
      capturedAt: event.capturedAt
    };
  }
  if (
    typeof event.effectId !== "string" ||
    !effectIdPattern.test(event.effectId) ||
    typeof event.recoveryObservationId !== "string" ||
    !observationIdPattern.test(event.recoveryObservationId)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    eventId: event.eventId,
    at: event.at,
    eventType: "effect_recovered",
    effectId: event.effectId,
    recoveryObservationId: event.recoveryObservationId
  };
}

function parseHistoryEvents(value: unknown): ArchiveHistoryEvent[] {
  if (!Array.isArray(value)) {
    throw new ArchiveTransactionError();
  }
  const eventIds = new Set<string>();
  return value.map((event) => {
    const parsed = parseHistoryEvent(event);
    if (eventIds.has(parsed.eventId)) {
      throw new ArchiveTransactionError();
    }
    eventIds.add(parsed.eventId);
    return parsed;
  });
}

function parseResolvesEffect(value: unknown): ArchiveResolvesEffect | null {
  if (value === null) {
    return null;
  }
  const resolvesEffect = requireObject(value);
  if (
    !hasExactKeys(resolvesEffect, resolvesEffectKeys) ||
    typeof resolvesEffect.effectId !== "string" ||
    !effectIdPattern.test(resolvesEffect.effectId) ||
    typeof resolvesEffect.journalSha256 !== "string" ||
    !sha256Pattern.test(resolvesEffect.journalSha256)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    effectId: resolvesEffect.effectId,
    journalSha256: resolvesEffect.journalSha256
  };
}

function parseSelectedObservationIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ArchiveTransactionError();
  }
  const observationIds = new Set<string>();
  return value.map((observationId) => {
    if (
      typeof observationId !== "string" ||
      !observationIdPattern.test(observationId) ||
      observationIds.has(observationId)
    ) {
      throw new ArchiveTransactionError();
    }
    observationIds.add(observationId);
    return observationId;
  });
}

function parsePublishPayload(value: unknown): PublishArchiveTransaction["payload"] {
  const payload = requireObject(value);
  if (
    !hasExactKeys(payload, publishPayloadKeys) ||
    typeof payload.newLiveRecordSha256 !== "string" ||
    !sha256Pattern.test(payload.newLiveRecordSha256) ||
    (payload.replacesObservationId !== null &&
      (typeof payload.replacesObservationId !== "string" ||
        !observationIdPattern.test(payload.replacesObservationId)))
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    newBundle: parseBundle(payload.newBundle),
    newLiveRecordSha256: payload.newLiveRecordSha256,
    replacesObservationId: payload.replacesObservationId,
    resolvesEffect: parseResolvesEffect(payload.resolvesEffect)
  };
}

function parseClearRangePayload(
  value: unknown,
  movedBundles: ArchiveBundle[]
): ClearRangeArchiveTransaction["payload"] {
  const payload = requireObject(value);
  if (!hasExactKeys(payload, clearRangePayloadKeys) || typeof payload.invalidatesLive !== "boolean") {
    throw new ArchiveTransactionError();
  }
  const selectedObservationIds = parseSelectedObservationIds(payload.selectedObservationIds);
  if (
    selectedObservationIds.length !== movedBundles.length ||
    selectedObservationIds.some((observationId, index) => observationId !== movedBundles[index]?.observationId)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    invalidatesLive: payload.invalidatesLive,
    selectedObservationIds
  };
}

function parseClearAllPayload(
  value: unknown,
  historyEvents: ArchiveHistoryEvent[],
  movedBundles: ArchiveBundle[]
): ClearAllArchiveTransaction["payload"] {
  const payload = requireObject(value);
  if (
    !hasExactKeys(payload, clearAllPayloadKeys) ||
    payload.deletesLiveRecord !== true ||
    historyEvents.length !== 0
  ) {
    throw new ArchiveTransactionError();
  }
  const selectedObservationIds = parseSelectedObservationIds(payload.selectedObservationIds);
  if (
    selectedObservationIds.length !== movedBundles.length ||
    selectedObservationIds.some((observationId, index) => observationId !== movedBundles[index]?.observationId)
  ) {
    throw new ArchiveTransactionError();
  }
  return {
    deletesLiveRecord: true,
    selectedObservationIds
  };
}

function parseRecordObject(bytes: Uint8Array): StrictJsonObject {
  try {
    return requireObject(parseStrictJsonBytes(bytes, {
      maxBytes: 65_536,
      maxDepth: 64
    }));
  } catch {
    throw new ArchiveTransactionError();
  }
}

export function parseArchiveTransactionBytes(
  bytes: Uint8Array,
  expected: ArchiveTransactionBinding
): ArchiveTransaction {
  const record = parseRecordObject(bytes);
  if (
    !hasExactKeys(record, transactionRootKeys) ||
    record.kind !== "cu.archive-transaction/v1" ||
    record.schemaVersion !== 1 ||
    typeof record.runId !== "string" ||
    !isRunId(record.runId) ||
    typeof record.workspaceFingerprint !== "string" ||
    !sha256Pattern.test(record.workspaceFingerprint) ||
    record.runId !== expected.runId ||
    record.workspaceFingerprint !== expected.workspaceFingerprint ||
    typeof record.transactionId !== "string" ||
    !transactionIdPattern.test(record.transactionId) ||
    (record.operation !== "publish" &&
      record.operation !== "clear_range" &&
      record.operation !== "clear_all") ||
    (record.state !== "prepared" &&
      record.state !== "assets_staged" &&
      record.state !== "cutover_committed") ||
    !isCanonicalTimestamp(record.createdAt) ||
    !isCanonicalTimestamp(record.updatedAt) ||
    new Date(record.updatedAt).getTime() < new Date(record.createdAt).getTime()
  ) {
    throw new ArchiveTransactionError();
  }
  const common = {
    kind: "cu.archive-transaction/v1" as const,
    schemaVersion: 1 as const,
    runId: record.runId as string,
    workspaceFingerprint: record.workspaceFingerprint as string,
    transactionId: record.transactionId as string,
    state: record.state as ArchiveTransactionBase["state"],
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    priorLive: parsePriorLive(record.priorLive),
    movedBundles: parseBundles(record.movedBundles),
    historyEvents: parseHistoryEvents(record.historyEvents)
  };
  if (record.operation === "publish") {
    return {
      ...common,
      operation: "publish",
      payload: parsePublishPayload(record.payload)
    };
  }
  if (record.operation === "clear_range") {
    return {
      ...common,
      operation: "clear_range",
      payload: parseClearRangePayload(record.payload, common.movedBundles)
    };
  }
  return {
    ...common,
    operation: "clear_all",
    payload: parseClearAllPayload(record.payload, common.historyEvents, common.movedBundles)
  };
}
