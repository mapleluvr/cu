import { createHash } from "node:crypto";

import {
  isAdmittedActionPlan,
  segmentActionPlan,
  type D2Segment,
  type NormalizedAction,
  type NormalizedActionPlan,
  type Point
} from "./action-file.js";

export class EffectPlanError extends Error {
  public constructor() {
    super("");
  }
}

export type EffectSegmentPlan = Readonly<{
  actionCount: number;
  leafCount: number;
  totalDelayMs: number;
  redactedDigest: string;
  terminalDecision: "completed" | "checkpoint";
}>;

export type EffectJournalPlan = Readonly<{
  redactedDigest: string;
  leafActionCount: number;
  coordinateActionCount: number;
  declaredDelayMs: number;
  typeText: Readonly<{
    actionCount: number;
    scalarCount: number;
    utf8Bytes: number;
  }>;
  terminalDecision: "completed" | "checkpoint";
}>;

type EffectSegmentPlanState = {
  observationId: string;
  journalPlan: EffectJournalPlan;
};

const effectSegmentPlans = new WeakMap<EffectSegmentPlan, EffectSegmentPlanState>();
const pointKeys = ["x", "y"];

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EffectPlanError();
  }
  return value as Record<string, unknown>;
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new EffectPlanError();
  }
  return value;
}

function redactPoint(value: unknown): Point {
  const point = requireRecord(value);
  if (!hasExactKeys(point, pointKeys)) {
    throw new EffectPlanError();
  }
  return {
    x: requireInteger(point.x, 0, 999),
    y: requireInteger(point.y, 0, 999)
  };
}

function textCounts(text: unknown): { scalarCount: number; utf8Bytes: number } {
  if (typeof text !== "string") {
    throw new EffectPlanError();
  }
  let scalarCount = 0;
  for (const scalar of text) {
    if (scalar === "") {
      throw new EffectPlanError();
    }
    scalarCount += 1;
  }
  if (scalarCount < 1 || scalarCount > 2_048) {
    throw new EffectPlanError();
  }
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  if (utf8Bytes < 1 || utf8Bytes > 8_192) {
    throw new EffectPlanError();
  }
  return { scalarCount, utf8Bytes };
}

type RedactedActionMetrics = {
  action: unknown;
  leafCount: number;
  coordinateActionCount: number;
  delayMs: number;
  typeTextActionCount: number;
  typeTextScalarCount: number;
  typeTextUtf8Bytes: number;
};

function noTextMetrics(action: unknown, leafCount: number, coordinateActionCount: number, delayMs = 0): RedactedActionMetrics {
  return {
    action,
    leafCount,
    coordinateActionCount,
    delayMs,
    typeTextActionCount: 0,
    typeTextScalarCount: 0,
    typeTextUtf8Bytes: 0
  };
}

function redactAtomicAction(value: unknown, allowTransitions: boolean): RedactedActionMetrics {
  const action = requireRecord(value);
  if (typeof action.kind !== "string") {
    throw new EffectPlanError();
  }
  switch (action.kind) {
    case "pointer_move":
      if (!hasExactKeys(action, ["kind", "to"])) throw new EffectPlanError();
      return noTextMetrics({ kind: "pointer_move", to: redactPoint(action.to) }, 1, 1);
    case "click": {
      if (!hasExactKeys(action, ["kind", "at", "button", "count"])) throw new EffectPlanError();
      if ((action.button !== "left" && action.button !== "middle" && action.button !== "right") ||
          (action.count !== 1 && action.count !== 2)) {
        throw new EffectPlanError();
      }
      return noTextMetrics({
        kind: "click",
        at: redactPoint(action.at),
        button: action.button,
        count: action.count
      }, 1, 1);
    }
    case "drag": {
      if (!hasExactKeys(action, ["kind", "from", "to", "button", "durationMs"])) {
        throw new EffectPlanError();
      }
      if (action.button !== "left" && action.button !== "right") {
        throw new EffectPlanError();
      }
      const durationMs = requireInteger(action.durationMs, 100, 5_000);
      const from = redactPoint(action.from);
      const to = redactPoint(action.to);
      if (from.x === to.x && from.y === to.y) throw new EffectPlanError();
      return noTextMetrics({ kind: "drag", from, to, button: action.button, durationMs }, 1, 1);
    }
    case "wheel": {
      if (!hasExactKeys(action, ["kind", "at", "deltaY"])) throw new EffectPlanError();
      const deltaY = requireInteger(action.deltaY, -100, 100);
      if (deltaY === 0) throw new EffectPlanError();
      return noTextMetrics({ kind: "wheel", at: redactPoint(action.at), deltaY }, 1, 1);
    }
    case "key":
      if (!hasExactKeys(action, ["kind", "key"]) || typeof action.key !== "string") {
        throw new EffectPlanError();
      }
      return noTextMetrics({ kind: "key", key: action.key }, 1, 0);
    case "type_text": {
      if (allowTransitions || !hasExactKeys(action, ["kind", "text"])) throw new EffectPlanError();
      const counts = textCounts(action.text);
      return {
        action: { kind: "type_text", ...counts },
        leafCount: 1,
        coordinateActionCount: 0,
        delayMs: 0,
        typeTextActionCount: 1,
        typeTextScalarCount: counts.scalarCount,
        typeTextUtf8Bytes: counts.utf8Bytes
      };
    }
    case "chord": {
      if (allowTransitions || !hasExactKeys(action, ["kind", "keys"]) || !Array.isArray(action.keys) ||
          action.keys.length < 2 || action.keys.length > 6 ||
          action.keys.some((key) => typeof key !== "string") ||
          new Set(action.keys).size !== action.keys.length) {
        throw new EffectPlanError();
      }
      return noTextMetrics({ kind: "chord", keys: [...action.keys] }, 1, 0);
    }
    case "key_down":
    case "key_up":
      if (!allowTransitions || !hasExactKeys(action, ["kind", "key"]) ||
          (action.key !== "Control" && action.key !== "Alt" && action.key !== "Shift")) {
        throw new EffectPlanError();
      }
      return noTextMetrics({ kind: action.kind, key: action.key }, 1, 0);
    case "button_down":
      if (!allowTransitions || !hasExactKeys(action, ["kind", "button", "at"]) ||
          (action.button !== "left" && action.button !== "middle" && action.button !== "right")) {
        throw new EffectPlanError();
      }
      return noTextMetrics({ kind: "button_down", button: action.button, at: redactPoint(action.at) }, 1, 1);
    case "button_up":
      if (!allowTransitions || !hasExactKeys(action, ["kind", "button"]) ||
          (action.button !== "left" && action.button !== "middle" && action.button !== "right")) {
        throw new EffectPlanError();
      }
      return noTextMetrics({ kind: "button_up", button: action.button }, 1, 0);
    default:
      throw new EffectPlanError();
  }
}

function redactAction(value: NormalizedAction): RedactedActionMetrics {
  if (value.kind !== "sequence") {
    return redactAtomicAction(value, false);
  }
  const sequence = requireRecord(value);
  if (!hasExactKeys(sequence, ["kind", "coordinateKind", "steps"]) || !Array.isArray(sequence.steps)) {
    throw new EffectPlanError();
  }
  if (sequence.coordinateKind !== "pointer_move" && sequence.coordinateKind !== "click" &&
      sequence.coordinateKind !== "drag" && sequence.coordinateKind !== "wheel" &&
      sequence.coordinateKind !== "button_down") {
    throw new EffectPlanError();
  }
  if (sequence.steps.length < 1 || sequence.steps.length > 32) {
    throw new EffectPlanError();
  }

  const steps: Array<{ action: unknown; delayAfterMs: number }> = [];
  let leafCount = 0;
  let coordinateActionCount = 0;
  let delayMs = 0;
  for (const value of sequence.steps) {
    const step = requireRecord(value);
    if (!hasExactKeys(step, ["action", "delayAfterMs"])) throw new EffectPlanError();
    const delayAfterMs = requireInteger(step.delayAfterMs, 0, 5_000);
    const redacted = redactAtomicAction(step.action, true);
    leafCount += redacted.leafCount;
    coordinateActionCount += redacted.coordinateActionCount;
    delayMs += delayAfterMs;
    steps.push({ action: redacted.action, delayAfterMs });
  }
  if (coordinateActionCount !== 1 || leafCount > 32 || delayMs > 30_000) {
    throw new EffectPlanError();
  }
  return noTextMetrics({
    kind: "sequence",
    coordinateKind: sequence.coordinateKind,
    steps
  }, leafCount, coordinateActionCount, delayMs);
}

function sameSegment(left: D2Segment, right: D2Segment): boolean {
  return left.outcome === right.outcome &&
    left.prefixLength === right.prefixLength &&
    (left.outcome === "completed" || right.outcome === "completed" || left.reason === right.reason);
}

export function buildEffectSegmentPlan(
  plan: NormalizedActionPlan,
  segment: D2Segment
): EffectSegmentPlan {
  try {
    if (!isAdmittedActionPlan(plan)) {
      throw new EffectPlanError();
    }
    const root = requireRecord(plan);
    if (!hasExactKeys(root, ["observationId", "coordinateSpace", "actions", "leafCount", "totalDelayMs"]) ||
        typeof plan.observationId !== "string" ||
        !/^obs_[a-z0-9][a-z0-9_-]{0,95}$/.test(plan.observationId) ||
        plan.coordinateSpace !== "normalized_999_top_left" ||
        !Array.isArray(plan.actions) ||
        plan.actions.length < 1 || plan.actions.length > 32 ||
        !Number.isSafeInteger(plan.leafCount) || plan.leafCount < 1 || plan.leafCount > 32 ||
        !Number.isSafeInteger(plan.totalDelayMs) || plan.totalDelayMs < 0 || plan.totalDelayMs > 30_000) {
      throw new EffectPlanError();
    }
    const expectedSegment = segmentActionPlan(plan);
    if (!sameSegment(segment, expectedSegment) || segment.prefixLength < 1 ||
        segment.prefixLength > plan.actions.length) {
      throw new EffectPlanError();
    }

    const redactedActions: unknown[] = [];
    let leafCount = 0;
    let coordinateActionCount = 0;
    let totalDelayMs = 0;
    let typeTextActionCount = 0;
    let typeTextScalarCount = 0;
    let typeTextUtf8Bytes = 0;
    for (const action of plan.actions.slice(0, segment.prefixLength)) {
      const redacted = redactAction(action);
      redactedActions.push(redacted.action);
      leafCount += redacted.leafCount;
      coordinateActionCount += redacted.coordinateActionCount;
      totalDelayMs += redacted.delayMs;
      typeTextActionCount += redacted.typeTextActionCount;
      typeTextScalarCount += redacted.typeTextScalarCount;
      typeTextUtf8Bytes += redacted.typeTextUtf8Bytes;
    }
    if (leafCount < 1 || leafCount > 32 || coordinateActionCount > 32 || totalDelayMs > 30_000 ||
        typeTextActionCount > 32 || typeTextScalarCount > 65_536 || typeTextUtf8Bytes > 65_536) {
      throw new EffectPlanError();
    }
    const redactedDigest = createHash("sha256")
      .update(JSON.stringify(redactedActions), "utf8")
      .digest("hex");
    const terminalDecision = segment.outcome;
    const journalPlan = Object.freeze({
      redactedDigest,
      leafActionCount: leafCount,
      coordinateActionCount,
      declaredDelayMs: totalDelayMs,
      typeText: Object.freeze({
        actionCount: typeTextActionCount,
        scalarCount: typeTextScalarCount,
        utf8Bytes: typeTextUtf8Bytes
      }),
      terminalDecision
    });
    const effectPlan = Object.freeze({
      actionCount: segment.prefixLength,
      leafCount,
      totalDelayMs,
      redactedDigest,
      terminalDecision
    });
    effectSegmentPlans.set(effectPlan, {
      observationId: plan.observationId,
      journalPlan
    });
    return effectPlan;
  } catch (error) {
    if (error instanceof EffectPlanError) {
      throw error;
    }
    throw new EffectPlanError();
  }
}

export function assertEffectSegmentPlanObservation(
  segment: EffectSegmentPlan,
  observationId: string
): void {
  const state = effectSegmentPlans.get(segment);
  if (state === undefined || state.observationId !== observationId) {
    throw new EffectPlanError();
  }
}

export function effectJournalPlanFor(segment: EffectSegmentPlan): EffectJournalPlan {
  const state = effectSegmentPlans.get(segment);
  if (state === undefined) {
    throw new EffectPlanError();
  }
  return state.journalPlan;
}
