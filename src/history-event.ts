import {
  parseStrictJsonBytes,
  type StrictJsonObject
} from "./strict-json.js";
import { isRunId } from "./identifiers.js";

const captureEventKeys = [
  "kind",
  "schemaVersion",
  "eventId",
  "transactionId",
  "at",
  "eventType",
  "runId",
  "workspaceFingerprint",
  "observationId",
  "capturedAt"
];
const effectRecoveryEventKeys = [
  "kind",
  "schemaVersion",
  "eventId",
  "transactionId",
  "at",
  "eventType",
  "runId",
  "workspaceFingerprint",
  "effectId",
  "recoveryObservationId"
];
const eventIdPattern = /^hist_[a-f0-9]{32}_[1-9][0-9]{0,3}$/;
const transactionIdPattern = /^txn_[a-f0-9]{32}$/;
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const effectIdPattern = /^eff_[a-f0-9]{32}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const captureEventTypes = new Set([
  "capture_retained",
  "capture_evicted",
  "capture_cleared"
]);

export class HistoryEventError extends Error {}

export type HistoryEventBinding = {
  runId: string;
  workspaceFingerprint: string;
};

type HistoryEventBase = {
  kind: "cu.history.event/v1";
  schemaVersion: 1;
  eventId: string;
  transactionId: string;
  at: string;
  runId: string;
  workspaceFingerprint: string;
};

export type CaptureHistoryEvent = HistoryEventBase & {
  eventType: "capture_retained" | "capture_evicted" | "capture_cleared";
  observationId: string;
  capturedAt: string;
};

export type EffectRecoveryHistoryEvent = HistoryEventBase & {
  eventType: "effect_recovered";
  effectId: string;
  recoveryObservationId: string;
};

export type HistoryEvent = CaptureHistoryEvent | EffectRecoveryHistoryEvent;

function hasExactKeys(value: StrictJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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

function parseRecordObject(bytes: Uint8Array): StrictJsonObject {
  try {
    const value = parseStrictJsonBytes(bytes, { maxBytes: 8_192, maxDepth: 64 });
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new HistoryEventError();
    }
    return value as StrictJsonObject;
  } catch {
    throw new HistoryEventError();
  }
}

export function parseHistoryEventBytes(
  bytes: Uint8Array,
  expected: HistoryEventBinding
): HistoryEvent {
  const root = parseRecordObject(bytes);
  const isCaptureEvent = typeof root.eventType === "string" && captureEventTypes.has(root.eventType);
  const isEffectRecoveryEvent = root.eventType === "effect_recovered";
  if (
    (!isCaptureEvent && !isEffectRecoveryEvent) ||
    (isCaptureEvent && !hasExactKeys(root, captureEventKeys)) ||
    (isEffectRecoveryEvent && !hasExactKeys(root, effectRecoveryEventKeys)) ||
    typeof root.runId !== "string" ||
    !isRunId(root.runId) ||
    typeof root.workspaceFingerprint !== "string" ||
    !sha256Pattern.test(root.workspaceFingerprint) ||
    root.runId !== expected.runId ||
    root.workspaceFingerprint !== expected.workspaceFingerprint ||
    root.kind !== "cu.history.event/v1" ||
    root.schemaVersion !== 1 ||
    typeof root.eventId !== "string" ||
    !eventIdPattern.test(root.eventId) ||
    typeof root.transactionId !== "string" ||
    !transactionIdPattern.test(root.transactionId) ||
    !isCanonicalTimestamp(root.at)
  ) {
    throw new HistoryEventError();
  }
  const common = {
    kind: root.kind as "cu.history.event/v1",
    schemaVersion: root.schemaVersion as 1,
    eventId: root.eventId as string,
    transactionId: root.transactionId as string,
    at: root.at as string,
    runId: root.runId as string,
    workspaceFingerprint: root.workspaceFingerprint as string
  };
  if (isCaptureEvent) {
    if (
      typeof root.observationId !== "string" ||
      !observationIdPattern.test(root.observationId) ||
      !isCanonicalTimestamp(root.capturedAt)
    ) {
      throw new HistoryEventError();
    }
    return {
      ...common,
      eventType: root.eventType as CaptureHistoryEvent["eventType"],
      observationId: root.observationId,
      capturedAt: root.capturedAt
    };
  }
  if (
    typeof root.effectId !== "string" ||
    !effectIdPattern.test(root.effectId) ||
    typeof root.recoveryObservationId !== "string" ||
    !observationIdPattern.test(root.recoveryObservationId)
  ) {
    throw new HistoryEventError();
  }
  return {
    ...common,
    eventType: "effect_recovered",
    effectId: root.effectId,
    recoveryObservationId: root.recoveryObservationId
  };
}
