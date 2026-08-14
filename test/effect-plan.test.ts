import assert from "node:assert/strict";
import test from "node:test";

import {
  admitActionBytes,
  segmentActionPlan,
  type NormalizedActionPlan
} from "../src/action-file.js";
import {
  assertEffectSegmentPlanObservation,
  buildEffectSegmentPlan
} from "../src/effect-plan.js";

function admittedPlan(text: string) {
  const result = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId: "obs_0123456789abcdef0123456789abcdef",
    coordinateSpace: "normalized_999_top_left",
    actions: [
      { kind: "click", at: { x: 420, y: 318 } },
      { kind: "type_text", text }
    ]
  }), "utf8"));
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected admitted action plan");
  return result.plan;
}

test("builds frozen privacy-safe accounting for the admitted finite segment", () => {
  const firstPlan = admittedPlan("secret-one");
  const secondPlan = admittedPlan("secret-two");
  const first = buildEffectSegmentPlan(firstPlan, segmentActionPlan(firstPlan));
  const second = buildEffectSegmentPlan(secondPlan, segmentActionPlan(secondPlan));

  assert.deepEqual(first, {
    actionCount: 2,
    leafCount: 2,
    totalDelayMs: 0,
    redactedDigest: first.redactedDigest,
    terminalDecision: "completed"
  });
  assert.match(first.redactedDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.redactedDigest, second.redactedDigest);
  assert.equal(Object.isFrozen(first), true);
  assert.doesNotMatch(JSON.stringify(first), /secret-one|secret-two/);
});

test("accounts only the admitted D2 prefix and rejects a forged segment", () => {
  const admitted = admitActionBytes(Buffer.from(JSON.stringify({
    kind: "cu.action/v1",
    observationId: "obs_0123456789abcdef0123456789abcdef",
    coordinateSpace: "normalized_999_top_left",
    actions: [
      { kind: "type_text", text: "first" },
      { kind: "wheel", at: { x: 1, y: 2 }, deltaY: 1 },
      { kind: "type_text", text: "not-emitted" }
    ]
  }), "utf8"));
  assert.equal(admitted.ok, true);
  if (!admitted.ok) assert.fail("expected admitted action plan");

  const segment = segmentActionPlan(admitted.plan);
  assert.deepEqual(segment, { outcome: "checkpoint", prefixLength: 2, reason: "wheel" });
  const effectPlan = buildEffectSegmentPlan(admitted.plan, segment);
  assert.deepEqual(effectPlan, {
    actionCount: 2,
    leafCount: 2,
    totalDelayMs: 0,
    redactedDigest: effectPlan.redactedDigest,
    terminalDecision: "checkpoint"
  });
  assert.throws(() => buildEffectSegmentPlan(admitted.plan, {
    outcome: "completed",
    prefixLength: 1
  }));
});

test("binds the opaque segment to its admitted observation and rejects forged normalized actions", () => {
  const plan = admittedPlan("private-value");
  const effectPlan = buildEffectSegmentPlan(plan, segmentActionPlan(plan));
  assert.doesNotThrow(() => assertEffectSegmentPlanObservation(
    effectPlan,
    "obs_0123456789abcdef0123456789abcdef"
  ));
  assert.throws(() => assertEffectSegmentPlanObservation(
    effectPlan,
    "obs_fedcba9876543210fedcba9876543210"
  ));

  const forged = {
    ...plan,
    actions: [{ kind: "key", key: "NotAPortableKey" }],
    leafCount: 1,
    totalDelayMs: 0
  } as unknown as NormalizedActionPlan;
  assert.throws(() => buildEffectSegmentPlan(forged, segmentActionPlan(forged)));
});
