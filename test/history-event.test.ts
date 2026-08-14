import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryEventError,
  parseHistoryEventBytes
} from "../src/history-event.js";

const binding = {
  runId: "work-a",
  workspaceFingerprint: "a".repeat(64)
};

function captureHistoryError(operation: () => void): HistoryEventError {
  try {
    operation();
  } catch (error) {
    if (error instanceof HistoryEventError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected HistoryEventError");
}

function captureEvent(): Record<string, unknown> {
  return {
    kind: "cu.history.event/v1",
    schemaVersion: 1,
    eventId: "hist_0123456789abcdef0123456789abcdef_1",
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    at: "2026-07-24T00:00:00.000Z",
    eventType: "capture_retained",
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    observationId: "obs_0123456789abcdef0123456789abcdef",
    capturedAt: "2026-07-24T00:00:00.000Z"
  };
}

function effectRecoveryEvent(): Record<string, unknown> {
  return {
    kind: "cu.history.event/v1",
    schemaVersion: 1,
    eventId: "hist_0123456789abcdef0123456789abcdef_2",
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    at: "2026-07-24T00:00:01.000Z",
    eventType: "effect_recovered",
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    effectId: "eff_0123456789abcdef0123456789abcdef",
    recoveryObservationId: "obs_0123456789abcdef0123456789abcdef"
  };
}

test("admits a complete workspace-bound effect-recovery history event", () => {
  const event = parseHistoryEventBytes(
    Buffer.from(JSON.stringify(effectRecoveryEvent()), "utf8"),
    binding
  );

  assert.equal(event.eventType, "effect_recovered");
  if (event.eventType !== "effect_recovered") {
    assert.fail("expected effect-recovery event");
  }
  assert.equal(event.effectId, "eff_0123456789abcdef0123456789abcdef");
  assert.equal(event.recoveryObservationId, "obs_0123456789abcdef0123456789abcdef");
});

test("rejects noncanonical effect-recovery event fields", () => {
  const valid = effectRecoveryEvent();
  const invalid = [
    { ...valid, effectId: "eff_wrong" },
    { ...valid, recoveryObservationId: "obs_wrong" },
    { ...valid, rawTypedText: "private keyboard input" }
  ];

  for (const event of invalid) {
    const error = captureHistoryError(() =>
      parseHistoryEventBytes(Buffer.from(JSON.stringify(event), "utf8"), binding)
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("admits every capture event type", () => {
  for (const eventType of ["capture_retained", "capture_evicted", "capture_cleared"]) {
    const event = parseHistoryEventBytes(
      Buffer.from(JSON.stringify({ ...captureEvent(), eventType }), "utf8"),
      binding
    );
    assert.equal(event.eventType, eventType);
  }
});

test("enforces strict bounded history-event transport", () => {
  const encoded = Buffer.from(JSON.stringify(captureEvent()), "utf8");
  const exact = Buffer.concat([
    encoded,
    Buffer.from(" ".repeat(8_192 - encoded.byteLength), "utf8")
  ]);
  assert.equal(exact.byteLength, 8_192);
  assert.doesNotThrow(() => parseHistoryEventBytes(exact, binding));

  const duplicate = Buffer.from(
    JSON.stringify(captureEvent()).replace(
      '"eventId":"hist_0123456789abcdef0123456789abcdef_1"',
      '"eventId":"hist_0123456789abcdef0123456789abcdef_1","\\u0065ventId":"hist_0123456789abcdef0123456789abcdef_1"'
    ),
    "utf8"
  );
  for (const bytes of [Buffer.concat([exact, Buffer.from(" ", "utf8")]), duplicate]) {
    assert.throws(() => parseHistoryEventBytes(bytes, binding), HistoryEventError);
  }
});

test("contains malformed history-event transport as a content-free domain error", () => {
  for (const bytes of [
    Buffer.from('{"private":"keyboard input"', "utf8"),
    Buffer.from("null", "utf8")
  ]) {
    const error = captureHistoryError(() => parseHistoryEventBytes(bytes, binding));
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /keyboard input/);
  }
});

test("rejects uncontracted history-event fields without disclosing candidate text", () => {
  const error = captureHistoryError(() =>
    parseHistoryEventBytes(
      Buffer.from(JSON.stringify({ ...captureEvent(), rawTypedText: "private keyboard input" }), "utf8"),
      binding
    )
  );

  assert.equal(error.message, "");
  assert.doesNotMatch(error.message, /private keyboard input/);
});

test("rejects noncanonical capture event fields", () => {
  const valid = captureEvent();
  const invalid = [
    { ...valid, kind: "cu.history.event/v2" },
    { ...valid, schemaVersion: 2 },
    { ...valid, eventId: "hist_wrong" },
    { ...valid, transactionId: "txn_wrong" },
    { ...valid, at: "2026-07-24T00:00:00Z" },
    { ...valid, eventType: "capture_unknown" },
    { ...valid, observationId: "obs_wrong" },
    { ...valid, capturedAt: "2026-07-24T00:00:00Z" }
  ];

  for (const event of invalid) {
    assert.throws(
      () => parseHistoryEventBytes(Buffer.from(JSON.stringify(event), "utf8"), binding),
      HistoryEventError
    );
  }
});

test("rejects matching malformed bindings without returning candidate text", () => {
  const malformedBindings = [
    {
      runId: "private keyboard input",
      workspaceFingerprint: "a".repeat(64)
    },
    {
      runId: binding.runId,
      workspaceFingerprint: "private keyboard input"
    }
  ];

  for (const malformedBinding of malformedBindings) {
    const error = captureHistoryError(() =>
      parseHistoryEventBytes(
        Buffer.from(JSON.stringify({ ...captureEvent(), ...malformedBinding }), "utf8"),
        malformedBinding
      )
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("rejects a history event copied from another run or workspace", () => {
  for (const expected of [
    { ...binding, runId: "work-b" },
    { ...binding, workspaceFingerprint: "0".repeat(64) }
  ]) {
    assert.throws(
      () => parseHistoryEventBytes(Buffer.from(JSON.stringify(captureEvent()), "utf8"), expected),
      HistoryEventError
    );
  }
});

test("admits a complete workspace-bound capture history event", () => {
  const event = parseHistoryEventBytes(
    Buffer.from(JSON.stringify(captureEvent()), "utf8"),
    binding
  );

  assert.equal(event.kind, "cu.history.event/v1");
  assert.equal(event.eventType, "capture_retained");
  assert.equal(event.observationId, "obs_0123456789abcdef0123456789abcdef");
});
