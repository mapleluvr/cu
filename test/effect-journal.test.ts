import assert from "node:assert/strict";
import test from "node:test";

import {
  EffectJournalError,
  parseEffectJournalBytes,
  validateEffectJournalLiveBinding
} from "../src/effect-journal.js";
import { parseLiveObservationBytes } from "../src/observation-record.js";

const binding = {
  runId: "work-a",
  workspaceFingerprint: "a".repeat(64)
};

function captureJournalError(operation: () => void): EffectJournalError {
  try {
    operation();
  } catch (error) {
    if (error instanceof EffectJournalError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected EffectJournalError");
}

function intentJournal(): Record<string, unknown> {
  return {
    kind: "cu.effect-journal/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    effectId: "eff_0123456789abcdef0123456789abcdef",
    createdAt: "2026-07-24T00:00:00.000Z",
    state: "intent",
    stateChangedAt: "2026-07-24T00:00:00.000Z",
    observation: {
      observationId: "obs_0123456789abcdef0123456789abcdef",
      liveRecordSha256: "b".repeat(64),
      captureMetadataSha256: "c".repeat(64),
      imageSha256: "d".repeat(64),
      environmentFingerprint: "e".repeat(64),
      topologyFingerprint: "f".repeat(64)
    },
    plan: {
      redactedDigest: "1".repeat(64),
      leafActionCount: 1,
      coordinateActionCount: 1,
      declaredDelayMs: 0,
      typeText: {
        actionCount: 0,
        scalarCount: 0,
        utf8Bytes: 0
      },
      terminalDecision: "completed"
    }
  };
}

function actionableLiveRecord(): Record<string, unknown> {
  return {
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    observationId: "obs_0123456789abcdef0123456789abcdef",
    publishedByTransactionId: "txn_0123456789abcdef0123456789abcdef",
    captureMetadataSha256: "c".repeat(64),
    capturedAt: "2026-07-24T00:00:00.000Z",
    expiresAt: "2026-07-24T00:01:00.000Z",
    coordinateSpace: "normalized_999_top_left",
    source: {
      captureKind: "full",
      mapping: "normalized_endpoint_centers/v1",
      leftPx: 0,
      topPx: 0,
      widthPx: 1920,
      heightPx: 1080
    },
    environmentFingerprint: "e".repeat(64),
    topologyFingerprint: "f".repeat(64),
    image: {
      mediaType: "image/png",
      sha256: "d".repeat(64),
      byteLength: 12345,
      width: 1920,
      height: 1080
    },
    state: "actionable",
    stateChangedAt: "2026-07-24T00:00:00.000Z"
  };
}

test("binds an intent journal to its actionable live evidence", () => {
  const journal = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(intentJournal()), "utf8"),
    binding
  );
  const live = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(actionableLiveRecord()), "utf8"),
    binding
  );

  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  assert.doesNotThrow(() =>
    validateEffectJournalLiveBinding(journal, live, "b".repeat(64))
  );
});

function consumedLiveRecord(effectId = "eff_0123456789abcdef0123456789abcdef"): Record<string, unknown> {
  return {
    ...actionableLiveRecord(),
    state: "consumed",
    stateChangedAt: "2026-07-24T00:00:00.500Z",
    consumedByEffectId: effectId
  };
}

test("rejects a live record from another admitted workspace binding", () => {
  const journal = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(intentJournal()), "utf8"),
    binding
  );
  const otherBinding = {
    runId: "work-b",
    workspaceFingerprint: "0".repeat(64)
  };
  const live = parseLiveObservationBytes(
    Buffer.from(JSON.stringify({
      ...actionableLiveRecord(),
      runId: otherBinding.runId,
      workspaceFingerprint: otherBinding.workspaceFingerprint
    }), "utf8"),
    otherBinding
  );

  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  assert.throws(
    () => validateEffectJournalLiveBinding(journal, live, "b".repeat(64)),
    EffectJournalError
  );
});

test("requires a consumed live record to name the journal effect", () => {
  const journal = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(intentJournal()), "utf8"),
    binding
  );
  const matching = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(consumedLiveRecord()), "utf8"),
    binding
  );
  const mismatched = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(consumedLiveRecord("eff_1123456789abcdef0123456789abcdef")), "utf8"),
    binding
  );

  assert.equal(matching.kind, "cu.live-observation/v1");
  assert.equal(mismatched.kind, "cu.live-observation/v1");
  if (matching.kind !== "cu.live-observation/v1" || mismatched.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live records");
  }
  assert.doesNotThrow(() =>
    validateEffectJournalLiveBinding(journal, matching, "b".repeat(64))
  );
  assert.throws(
    () => validateEffectJournalLiveBinding(journal, mismatched, "b".repeat(64)),
    EffectJournalError
  );
});

test("rejects journal evidence that does not match its live record", () => {
  const live = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(actionableLiveRecord()), "utf8"),
    binding
  );
  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  const valid = intentJournal();
  const observation = valid.observation as Record<string, unknown>;
  const invalid = [
    { ...valid, observation: { ...observation, observationId: "obs_1123456789abcdef0123456789abcdef" } },
    { ...valid, observation: { ...observation, liveRecordSha256: "1".repeat(64) } },
    { ...valid, observation: { ...observation, captureMetadataSha256: "1".repeat(64) } },
    { ...valid, observation: { ...observation, imageSha256: "1".repeat(64) } },
    { ...valid, observation: { ...observation, environmentFingerprint: "1".repeat(64) } },
    { ...valid, observation: { ...observation, topologyFingerprint: "1".repeat(64) } }
  ];

  for (const raw of invalid) {
    const journal = parseEffectJournalBytes(Buffer.from(JSON.stringify(raw), "utf8"), binding);
    assert.throws(
      () => validateEffectJournalLiveBinding(journal, live, "b".repeat(64)),
      EffectJournalError
    );
  }
  const journal = parseEffectJournalBytes(Buffer.from(JSON.stringify(valid), "utf8"), binding);
  assert.throws(
    () => validateEffectJournalLiveBinding(journal, live, "B".repeat(64)),
    EffectJournalError
  );
});

function partialJournal(): Record<string, unknown> {
  return {
    ...intentJournal(),
    state: "partial",
    stateChangedAt: "2026-07-24T00:00:00.500Z",
    reason: "helper_lost"
  };
}

function indeterminateJournal(): Record<string, unknown> {
  return {
    ...intentJournal(),
    state: "indeterminate",
    stateChangedAt: "2026-07-24T00:00:00.500Z",
    reason: "input_unproven"
  };
}

test("admits partial and indeterminate journals with explicit reasons", () => {
  const partial = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(partialJournal()), "utf8"),
    binding
  );
  const indeterminate = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(indeterminateJournal()), "utf8"),
    binding
  );

  assert.equal(partial.state, "partial");
  if (partial.state !== "partial") {
    assert.fail("expected partial state");
  }
  const partialReason: string = partial.reason;
  assert.equal(partialReason, "helper_lost");
  assert.equal(indeterminate.state, "indeterminate");
  if (indeterminate.state !== "indeterminate") {
    assert.fail("expected indeterminate state");
  }
  const indeterminateReason: string = indeterminate.reason;
  assert.equal(indeterminateReason, "input_unproven");
});

test("requires exact unresolved-state reasons and forbids them on intent", () => {
  const invalid = [
    { ...intentJournal(), reason: "helper_lost" },
    { ...partialJournal(), reason: "unknown" },
    { ...indeterminateJournal(), reason: "private keyboard input" }
  ];

  for (const journal of invalid) {
    const error = captureJournalError(() =>
      parseEffectJournalBytes(Buffer.from(JSON.stringify(journal), "utf8"), binding)
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("rejects an intent journal copied from another workspace", () => {
  assert.throws(
    () => parseEffectJournalBytes(
      Buffer.from(JSON.stringify(intentJournal()), "utf8"),
      { ...binding, workspaceFingerprint: "0".repeat(64) }
    ),
    EffectJournalError
  );
});

test("rejects uncontracted journal fields without disclosing candidate typed text", () => {
  const error = captureJournalError(() =>
    parseEffectJournalBytes(
      Buffer.from(JSON.stringify({ ...intentJournal(), rawTypedText: "private keyboard input" }), "utf8"),
      binding
    )
  );

  assert.equal(error.message, "");
  assert.doesNotMatch(error.message, /private keyboard input/);
});

test("rejects intent journal shape and discriminator violations", () => {
  const valid = intentJournal();
  const observation = valid.observation as Record<string, unknown>;
  const plan = valid.plan as Record<string, unknown>;
  const typeText = plan.typeText as Record<string, unknown>;
  const invalid = [
    { ...valid, kind: "cu.effect-journal/v2" },
    { ...valid, schemaVersion: 2 },
    { ...valid, state: "complete" },
    { ...valid, observation: { ...observation, unexpected: true } },
    { ...valid, plan: { ...plan, unexpected: true } },
    { ...valid, plan: { ...plan, typeText: { ...typeText, rawText: "secret" } } },
    { ...valid, plan: { ...plan, terminalDecision: "later" } }
  ];

  for (const journal of invalid) {
    assert.throws(
      () => parseEffectJournalBytes(Buffer.from(JSON.stringify(journal), "utf8"), binding),
      EffectJournalError
    );
  }
});

test("rejects noncanonical journal identifiers, times, digests, and accounting", () => {
  const valid = intentJournal();
  const observation = valid.observation as Record<string, unknown>;
  const plan = valid.plan as Record<string, unknown>;
  const typeText = plan.typeText as Record<string, unknown>;
  const invalid = [
    { ...valid, effectId: "eff_wrong" },
    { ...valid, createdAt: "2026-07-24T00:00:00Z" },
    { ...valid, stateChangedAt: "2026-07-24T00:00:00Z" },
    { ...valid, observation: { ...observation, observationId: "obs_wrong" } },
    { ...valid, observation: { ...observation, liveRecordSha256: "B".repeat(64) } },
    { ...valid, observation: { ...observation, captureMetadataSha256: "short" } },
    { ...valid, observation: { ...observation, imageSha256: "D".repeat(64) } },
    { ...valid, observation: { ...observation, environmentFingerprint: "short" } },
    { ...valid, observation: { ...observation, topologyFingerprint: "F".repeat(64) } },
    { ...valid, plan: { ...plan, redactedDigest: "1".repeat(63) } },
    { ...valid, plan: { ...plan, leafActionCount: 0 } },
    { ...valid, plan: { ...plan, coordinateActionCount: 33 } },
    { ...valid, plan: { ...plan, declaredDelayMs: 30_001 } },
    { ...valid, plan: { ...plan, typeText: { ...typeText, actionCount: 33 } } },
    { ...valid, plan: { ...plan, typeText: { ...typeText, scalarCount: 65_537 } } },
    { ...valid, plan: { ...plan, typeText: { ...typeText, utf8Bytes: 1.5 } } }
  ];

  for (const journal of invalid) {
    assert.throws(
      () => parseEffectJournalBytes(Buffer.from(JSON.stringify(journal), "utf8"), binding),
      EffectJournalError
    );
  }
});

test("enforces strict journal transport boundaries without content disclosure", () => {
  const encoded = Buffer.from(JSON.stringify(intentJournal()), "utf8");
  const exact = Buffer.concat([
    encoded,
    Buffer.from(" ".repeat(65_536 - encoded.byteLength), "utf8")
  ]);

  assert.equal(exact.byteLength, 65_536);
  assert.doesNotThrow(() => parseEffectJournalBytes(exact, binding));
  for (const bytes of [
    Buffer.concat([exact, Buffer.from(" ", "utf8")]),
    Buffer.from('{"private":"keyboard input"', "utf8"),
    Buffer.from("null", "utf8"),
    Buffer.from(
      JSON.stringify(intentJournal()).replace(
        '"effectId":"eff_0123456789abcdef0123456789abcdef"',
        '"effectId":"eff_0123456789abcdef0123456789abcdef","\\u0065ffectId":"eff_0123456789abcdef0123456789abcdef"'
      ),
      "utf8"
    )
  ]) {
    const error = captureJournalError(() => parseEffectJournalBytes(bytes, binding));
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /keyboard input/);
  }
});

test("admits a complete workspace-bound intent journal without raw typed text", () => {
  const journal = parseEffectJournalBytes(
    Buffer.from(JSON.stringify(intentJournal()), "utf8"),
    binding
  );

  assert.equal(journal.kind, "cu.effect-journal/v1");
  assert.equal(journal.state, "intent");
  assert.equal(journal.effectId, "eff_0123456789abcdef0123456789abcdef");
  assert.deepEqual(Object.keys(journal.plan).sort(), [
    "coordinateActionCount",
    "declaredDelayMs",
    "leafActionCount",
    "redactedDigest",
    "terminalDecision",
    "typeText"
  ]);
});
