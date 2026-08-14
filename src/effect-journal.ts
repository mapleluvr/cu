import {
  parseStrictJsonBytes,
  type StrictJsonObject
} from "./strict-json.js";
import type { BundleBoundLiveObservation } from "./observation-record.js";

const MAX_RECORD_BYTES = 65_536;
const MAX_JSON_DEPTH = 64;
const journalRootKeys = [
  "kind",
  "schemaVersion",
  "runId",
  "workspaceFingerprint",
  "effectId",
  "createdAt",
  "state",
  "stateChangedAt",
  "observation",
  "plan"
];
const unresolvedJournalKeys = [...journalRootKeys, "reason"];
const observationKeys = [
  "observationId",
  "liveRecordSha256",
  "captureMetadataSha256",
  "imageSha256",
  "environmentFingerprint",
  "topologyFingerprint"
];
const planKeys = [
  "redactedDigest",
  "leafActionCount",
  "coordinateActionCount",
  "declaredDelayMs",
  "typeText",
  "terminalDecision"
];
const typeTextKeys = ["actionCount", "scalarCount", "utf8Bytes"];
const effectIdPattern = /^eff_[a-f0-9]{32}$/;
const observationIdPattern = /^obs_[a-f0-9]{32}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unresolvedReasons = new Set<string>([
  "helper_lost",
  "input_unproven",
  "cleanup_unproven",
  "checkpoint_capture_failed",
  "checkpoint_publish_failed"
]);

export class EffectJournalError extends Error {}

export type EffectJournalBinding = {
  runId: string;
  workspaceFingerprint: string;
};

export type EffectJournalObservation = {
  observationId: string;
  liveRecordSha256: string;
  captureMetadataSha256: string;
  imageSha256: string;
  environmentFingerprint: string;
  topologyFingerprint: string;
};

export type EffectJournalTypeText = {
  actionCount: number;
  scalarCount: number;
  utf8Bytes: number;
};

export type EffectJournalPlan = {
  redactedDigest: string;
  leafActionCount: number;
  coordinateActionCount: number;
  declaredDelayMs: number;
  typeText: EffectJournalTypeText;
  terminalDecision: "completed" | "checkpoint";
};

export type EffectJournalReason =
  | "helper_lost"
  | "input_unproven"
  | "cleanup_unproven"
  | "checkpoint_capture_failed"
  | "checkpoint_publish_failed";

type EffectJournalBase = {
  kind: "cu.effect-journal/v1";
  schemaVersion: 1;
  runId: string;
  workspaceFingerprint: string;
  effectId: string;
  createdAt: string;
  stateChangedAt: string;
  observation: EffectJournalObservation;
  plan: EffectJournalPlan;
};

export type IntentEffectJournal = EffectJournalBase & {
  state: "intent";
};

export type UnresolvedEffectJournal = EffectJournalBase & {
  state: "partial" | "indeterminate";
  reason: EffectJournalReason;
};

export type EffectJournal = IntentEffectJournal | UnresolvedEffectJournal;

function hasExactKeys(value: StrictJsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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

function requireObject(value: unknown): StrictJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EffectJournalError();
  }
  return value as StrictJsonObject;
}

function parseRecordObject(bytes: Uint8Array): StrictJsonObject {
  try {
    return requireObject(parseStrictJsonBytes(bytes, {
      maxBytes: MAX_RECORD_BYTES,
      maxDepth: MAX_JSON_DEPTH
    }));
  } catch {
    throw new EffectJournalError();
  }
}

export function validateEffectJournalLiveBinding(
  journal: EffectJournal,
  live: BundleBoundLiveObservation,
  liveRecordSha256: string
): void {
  if (
    !sha256Pattern.test(liveRecordSha256) ||
    journal.runId !== live.runId ||
    journal.workspaceFingerprint !== live.workspaceFingerprint ||
    journal.observation.observationId !== live.observationId ||
    journal.observation.liveRecordSha256 !== liveRecordSha256 ||
    journal.observation.captureMetadataSha256 !== live.captureMetadataSha256 ||
    journal.observation.imageSha256 !== live.image.sha256 ||
    journal.observation.environmentFingerprint !== live.environmentFingerprint ||
    journal.observation.topologyFingerprint !== live.topologyFingerprint ||
    (live.state === "consumed" && live.consumedByEffectId !== journal.effectId)
  ) {
    throw new EffectJournalError();
  }
}

export function parseEffectJournalBytes(
  bytes: Uint8Array,
  expected: EffectJournalBinding
): EffectJournal {
  const root = parseRecordObject(bytes);
  const isIntent = root.state === "intent";
  const isPartial = root.state === "partial";
  const isIndeterminate = root.state === "indeterminate";
  if (
    (!isIntent && !isPartial && !isIndeterminate) ||
    (isIntent && !hasExactKeys(root, journalRootKeys)) ||
    ((isPartial || isIndeterminate) && !hasExactKeys(root, unresolvedJournalKeys)) ||
    root.runId !== expected.runId ||
    root.workspaceFingerprint !== expected.workspaceFingerprint
  ) {
    throw new EffectJournalError();
  }
  const observation = requireObject(root.observation);
  const plan = requireObject(root.plan);
  const typeText = requireObject(plan.typeText);
  if (
    !hasExactKeys(observation, observationKeys) ||
    !hasExactKeys(plan, planKeys) ||
    !hasExactKeys(typeText, typeTextKeys) ||
    root.kind !== "cu.effect-journal/v1" ||
    root.schemaVersion !== 1 ||
    typeof root.effectId !== "string" ||
    !effectIdPattern.test(root.effectId) ||
    !isCanonicalTimestamp(root.createdAt) ||
    !isCanonicalTimestamp(root.stateChangedAt) ||
    typeof observation.observationId !== "string" ||
    !observationIdPattern.test(observation.observationId) ||
    typeof observation.liveRecordSha256 !== "string" ||
    !sha256Pattern.test(observation.liveRecordSha256) ||
    typeof observation.captureMetadataSha256 !== "string" ||
    !sha256Pattern.test(observation.captureMetadataSha256) ||
    typeof observation.imageSha256 !== "string" ||
    !sha256Pattern.test(observation.imageSha256) ||
    typeof observation.environmentFingerprint !== "string" ||
    !sha256Pattern.test(observation.environmentFingerprint) ||
    typeof observation.topologyFingerprint !== "string" ||
    !sha256Pattern.test(observation.topologyFingerprint) ||
    typeof plan.redactedDigest !== "string" ||
    !sha256Pattern.test(plan.redactedDigest) ||
    !isIntegerInRange(plan.leafActionCount, 1, 32) ||
    !isIntegerInRange(plan.coordinateActionCount, 0, 32) ||
    !isIntegerInRange(plan.declaredDelayMs, 0, 30_000) ||
    !isIntegerInRange(typeText.actionCount, 0, 32) ||
    !isIntegerInRange(typeText.scalarCount, 0, 65_536) ||
    !isIntegerInRange(typeText.utf8Bytes, 0, 65_536) ||
    (plan.terminalDecision !== "completed" && plan.terminalDecision !== "checkpoint") ||
    ((isPartial || isIndeterminate) &&
      (typeof root.reason !== "string" || !unresolvedReasons.has(root.reason)))
  ) {
    throw new EffectJournalError();
  }

  const common = {
    kind: root.kind as "cu.effect-journal/v1",
    schemaVersion: root.schemaVersion as 1,
    runId: root.runId as string,
    workspaceFingerprint: root.workspaceFingerprint as string,
    effectId: root.effectId as string,
    createdAt: root.createdAt as string,
    stateChangedAt: root.stateChangedAt as string,
    observation: {
      observationId: observation.observationId as string,
      liveRecordSha256: observation.liveRecordSha256 as string,
      captureMetadataSha256: observation.captureMetadataSha256 as string,
      imageSha256: observation.imageSha256 as string,
      environmentFingerprint: observation.environmentFingerprint as string,
      topologyFingerprint: observation.topologyFingerprint as string
    },
    plan: {
      redactedDigest: plan.redactedDigest as string,
      leafActionCount: plan.leafActionCount as number,
      coordinateActionCount: plan.coordinateActionCount as number,
      declaredDelayMs: plan.declaredDelayMs as number,
      typeText: {
        actionCount: typeText.actionCount as number,
        scalarCount: typeText.scalarCount as number,
        utf8Bytes: typeText.utf8Bytes as number
      },
      terminalDecision: plan.terminalDecision as "completed" | "checkpoint"
    }
  };
  if (isIntent) {
    return { ...common, state: "intent" };
  }
  return {
    ...common,
    state: isPartial ? "partial" : "indeterminate",
    reason: root.reason as EffectJournalReason
  };
}
