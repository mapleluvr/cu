import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservationRecordError,
  parseCaptureSidecarBytes,
  parseLiveObservationBytes,
  validateBundleBoundLiveObservation,
} from "../src/observation-record.js";
import {
  expirationFor,
  isObservationTtlMs,
  isValidObservationExpiry,
} from "../src/observation-expiry.js";

const binding = {
  runId: "work-a",
  workspaceFingerprint: "a".repeat(64),
};

function captureSidecar(): Record<string, unknown> {
  return {
    kind: "cu.capture/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    observationId: "obs_0123456789abcdef0123456789abcdef",
    capturedAt: "2026-07-24T00:00:00.000Z",
    expiresAt: "2026-07-24T00:01:00.000Z",
    coordinateSpace: "normalized_999_top_left",
    source: {
      captureKind: "full",
      mapping: "normalized_endpoint_centers/v1",
      leftPx: 0,
      topPx: 0,
      widthPx: 1920,
      heightPx: 1080,
    },
    environmentFingerprint: "b".repeat(64),
    topologyFingerprint: "c".repeat(64),
    image: {
      mediaType: "image/png",
      sha256: "d".repeat(64),
      byteLength: 12345,
      width: 1920,
      height: 1080,
    },
  };
}

function parse(sidecar = captureSidecar(), expected = binding) {
  return parseCaptureSidecarBytes(
    Buffer.from(JSON.stringify(sidecar), "utf8"),
    expected,
  );
}

function captureObservationError(
  operation: () => void,
): ObservationRecordError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ObservationRecordError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected ObservationRecordError");
}

function actionableLiveRecord(): Record<string, unknown> {
  const capture = captureSidecar();
  return {
    kind: "cu.live-observation/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    observationId: capture.observationId,
    publishedByTransactionId: "txn_0123456789abcdef0123456789abcdef",
    captureMetadataSha256: "e".repeat(64),
    capturedAt: capture.capturedAt,
    expiresAt: capture.expiresAt,
    coordinateSpace: capture.coordinateSpace,
    source: capture.source,
    environmentFingerprint: capture.environmentFingerprint,
    topologyFingerprint: capture.topologyFingerprint,
    image: capture.image,
    state: "actionable",
    stateChangedAt: capture.capturedAt,
  };
}

function consumedLiveRecord(): Record<string, unknown> {
  return {
    ...actionableLiveRecord(),
    state: "consumed",
    stateChangedAt: "2026-07-24T00:00:00.500Z",
    consumedByEffectId: "eff_0123456789abcdef0123456789abcdef",
  };
}

function clearedTombstone(): Record<string, unknown> {
  return {
    kind: "cu.live-observation-tombstone/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    observationId: "obs_0123456789abcdef0123456789abcdef",
    previousLiveRecordSha256: "e".repeat(64),
    invalidatedReason: "cleared",
    invalidatedAt: "2026-07-24T00:01:00.000Z",
    invalidatedByTransactionId: "txn_0123456789abcdef0123456789abcdef",
  };
}

const bindingAdmissionVariants = [
  {
    name: "capture sidecar",
    record: captureSidecar,
    admit: (bytes: Buffer, expected: typeof binding) =>
      parseCaptureSidecarBytes(bytes, expected),
  },
  {
    name: "bundle-bound live observation",
    record: actionableLiveRecord,
    admit: (bytes: Buffer, expected: typeof binding) =>
      parseLiveObservationBytes(bytes, expected),
  },
  {
    name: "live-observation tombstone",
    record: clearedTombstone,
    admit: (bytes: Buffer, expected: typeof binding) =>
      parseLiveObservationBytes(bytes, expected),
  },
];

for (const variant of bindingAdmissionVariants) {
  test(`rejects a matching malformed run ID in ${variant.name}`, () => {
    const runId = "WORK-A";
    const error = captureObservationError(() =>
      variant.admit(
        Buffer.from(JSON.stringify({ ...variant.record(), runId }), "utf8"),
        { ...binding, runId },
      ),
    );

    assert.equal(error.message, "");
  });

  test(`rejects a matching malformed workspace fingerprint in ${variant.name}`, () => {
    const workspaceFingerprint = "A".repeat(64);
    const error = captureObservationError(() =>
      variant.admit(
        Buffer.from(
          JSON.stringify({ ...variant.record(), workspaceFingerprint }),
          "utf8",
        ),
        { ...binding, workspaceFingerprint },
      ),
    );

    assert.equal(error.message, "");
  });
}

test("contains malformed runtime expected bindings as record errors", () => {
  const bytes = Buffer.from(JSON.stringify(captureSidecar()), "utf8");
  const invalid = [
    null,
    { runId: 1, workspaceFingerprint: binding.workspaceFingerprint },
    { runId: binding.runId, workspaceFingerprint: null },
  ];

  for (const expected of invalid) {
    const error = captureObservationError(() =>
      parseCaptureSidecarBytes(bytes, expected as unknown as typeof binding),
    );
    assert.equal(error.message, "");
  }
});

test("admits a complete workspace-bound immutable capture sidecar", () => {
  const record = parse();

  assert.equal(record.kind, "cu.capture/v1");
  assert.equal(record.observationId, "obs_0123456789abcdef0123456789abcdef");
  assert.equal(record.expiresAt, "2026-07-24T00:01:00.000Z");
  assert.deepEqual({ ...record.source }, captureSidecar().source);
  assert.deepEqual({ ...record.image }, captureSidecar().image);
});

test("accepts an unlimited capture expiration", () => {
  const sidecar = captureSidecar();
  sidecar.expiresAt = null;

  const parsed = parse(sidecar);

  assert.equal(parsed.expiresAt, null);
});

test("accepts configurable whole-second and unlimited expiration values", () => {
  const wholeSecond = captureSidecar();
  wholeSecond.expiresAt = "2026-07-24T00:05:00.000Z";
  assert.equal(parse(wholeSecond).expiresAt, "2026-07-24T00:05:00.000Z");

  const unlimited = captureSidecar();
  unlimited.expiresAt = null;
  assert.equal(parse(unlimited).expiresAt, null);

  for (const expiresAt of [
    "2026-07-24T00:00:00.000Z",
    "2026-07-23T23:59:59.000Z",
    "2026-07-24T00:01:00.001Z",
    "invalid",
  ]) {
    const sidecar = captureSidecar();
    sidecar.expiresAt = expiresAt;
    assert.throws(() => parse(sidecar), ObservationRecordError);
  }
});

test("bounds observation TTL values and computes expiration deterministically", () => {
  assert.equal(isObservationTtlMs(null), true);
  assert.equal(isObservationTtlMs(300_000), true);
  assert.equal(isObservationTtlMs(999), false);
  assert.equal(isObservationTtlMs(-1_000), false);
  assert.equal(isObservationTtlMs(2_147_483_647_000), true);
  assert.equal(isObservationTtlMs(2_147_483_648_000), false);
  assert.equal(
    expirationFor(new Date("2026-07-24T00:00:00.000Z"), 300_000),
    "2026-07-24T00:05:00.000Z",
  );
  assert.equal(expirationFor(new Date("2026-07-24T00:00:00.000Z"), null), null);
  assert.equal(
    isValidObservationExpiry("2026-07-24T00:00:00.000Z", null),
    true,
  );
});
test("admits an actionable bundle-bound live observation", () => {
  const record = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(actionableLiveRecord()), "utf8"),
    binding,
  );

  assert.equal(record.kind, "cu.live-observation/v1");
  assert.equal(record.state, "actionable");
  assert.equal(
    record.publishedByTransactionId,
    "txn_0123456789abcdef0123456789abcdef",
  );
});

test("admits a consumed bundle-bound live observation", () => {
  const record = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(consumedLiveRecord()), "utf8"),
    binding,
  );

  assert.equal(record.kind, "cu.live-observation/v1");
  if (record.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  assert.equal(record.state, "consumed");
  if (record.state !== "consumed") {
    assert.fail("expected consumed state");
  }
  const effectId: string = record.consumedByEffectId;
  assert.equal(effectId, "eff_0123456789abcdef0123456789abcdef");
});

test("admits a no-bundle live-observation tombstone", () => {
  const record = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(clearedTombstone()), "utf8"),
    binding,
  );

  assert.equal(record.kind, "cu.live-observation-tombstone/v1");
  if (record.kind !== "cu.live-observation-tombstone/v1") {
    assert.fail("expected tombstone");
  }
  assert.equal(record.invalidatedReason, "cleared");
  assert.equal(
    record.invalidatedByTransactionId,
    "txn_0123456789abcdef0123456789abcdef",
  );
});

test("binds a bundle-bound live record to its immutable sidecar", () => {
  const capture = parse();
  const live = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(actionableLiveRecord()), "utf8"),
    binding,
  );

  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  assert.doesNotThrow(() =>
    validateBundleBoundLiveObservation(live, capture, "e".repeat(64)),
  );
});

test("rejects bundle-bound live records with sidecar binding mismatches", () => {
  const capture = parse();
  const valid = actionableLiveRecord();
  const source = valid.source as Record<string, unknown>;
  const image = valid.image as Record<string, unknown>;
  const invalid = [
    { ...valid, observationId: "obs_1123456789abcdef0123456789abcdef" },
    {
      ...valid,
      capturedAt: "2026-07-24T00:00:00.100Z",
      expiresAt: "2026-07-24T00:01:00.100Z",
      stateChangedAt: "2026-07-24T00:00:00.100Z",
    },
    { ...valid, captureMetadataSha256: "f".repeat(64) },
    { ...valid, source: { ...source, leftPx: 1 } },
    { ...valid, environmentFingerprint: "f".repeat(64) },
    { ...valid, topologyFingerprint: "f".repeat(64) },
    { ...valid, image: { ...image, sha256: "f".repeat(64) } },
  ];

  for (const raw of invalid) {
    const live = parseLiveObservationBytes(
      Buffer.from(JSON.stringify(raw), "utf8"),
      binding,
    );
    assert.equal(live.kind, "cu.live-observation/v1");
    if (live.kind !== "cu.live-observation/v1") {
      assert.fail("expected bundle-bound live record");
    }
    assert.throws(
      () => validateBundleBoundLiveObservation(live, capture, "e".repeat(64)),
      ObservationRecordError,
    );
  }
  const live = parseLiveObservationBytes(
    Buffer.from(JSON.stringify(valid), "utf8"),
    binding,
  );
  assert.equal(live.kind, "cu.live-observation/v1");
  if (live.kind !== "cu.live-observation/v1") {
    assert.fail("expected bundle-bound live record");
  }
  assert.throws(
    () => validateBundleBoundLiveObservation(live, capture, "E".repeat(64)),
    ObservationRecordError,
  );
});

test("rejects malformed or copied tombstones without sidecar lookup", () => {
  const valid = clearedTombstone();
  const invalid = [
    { ...valid, workspaceFingerprint: "e".repeat(64) },
    { ...valid, unexpected: true },
    { ...valid, observationId: "obs_wrong" },
    { ...valid, previousLiveRecordSha256: "E".repeat(64) },
    { ...valid, invalidatedReason: "superseded" },
    { ...valid, invalidatedAt: "2026-07-24T00:01:00Z" },
    { ...valid, invalidatedByTransactionId: "txn_wrong" },
    { ...valid, invalidatedByTransactionId: 1 },
  ];

  for (const tombstone of invalid) {
    assert.throws(
      () =>
        parseLiveObservationBytes(
          Buffer.from(JSON.stringify(tombstone), "utf8"),
          binding,
        ),
      ObservationRecordError,
    );
  }

  const expired = parseLiveObservationBytes(
    Buffer.from(
      JSON.stringify({
        ...valid,
        invalidatedReason: "expired",
        invalidatedByTransactionId: null,
      }),
      "utf8",
    ),
    binding,
  );
  assert.equal(expired.kind, "cu.live-observation-tombstone/v1");
});

test("requires tombstone reason and transaction linkage to agree", () => {
  const valid = clearedTombstone();
  const invalid = [
    { ...valid, invalidatedByTransactionId: null },
    { ...valid, invalidatedReason: "expired" },
    { ...valid, invalidatedReason: "environment_changed" },
  ];

  for (const tombstone of invalid) {
    assert.throws(
      () =>
        parseLiveObservationBytes(
          Buffer.from(JSON.stringify(tombstone), "utf8"),
          binding,
        ),
      ObservationRecordError,
    );
  }
});

test("rejects malformed consumed live-record state", () => {
  const valid = consumedLiveRecord();
  const invalid = [
    { ...valid, consumedByEffectId: "eff_wrong" },
    { ...valid, stateChangedAt: "2026-07-24T00:00:00Z" },
  ];

  for (const live of invalid) {
    assert.throws(
      () =>
        parseLiveObservationBytes(
          Buffer.from(JSON.stringify(live), "utf8"),
          binding,
        ),
      ObservationRecordError,
    );
  }
});

test("rejects actionable live-record shape and state violations", () => {
  const valid = actionableLiveRecord();
  const source = valid.source as Record<string, unknown>;
  const image = valid.image as Record<string, unknown>;
  const invalid = [
    { ...valid, unexpected: true },
    { ...valid, state: "expired" },
    { ...valid, stateChangedAt: "2026-07-24T00:00:00.001Z" },
    { ...valid, publishedByTransactionId: "txn_wrong" },
    { ...valid, captureMetadataSha256: "E".repeat(64) },
    { ...valid, source: { ...source, unexpected: true } },
    { ...valid, image: { ...image, unexpected: true } },
  ];

  for (const live of invalid) {
    assert.throws(
      () =>
        parseLiveObservationBytes(
          Buffer.from(JSON.stringify(live), "utf8"),
          binding,
        ),
      ObservationRecordError,
    );
  }
});

test("rejects a live observation copied from another workspace", () => {
  assert.throws(
    () =>
      parseLiveObservationBytes(
        Buffer.from(JSON.stringify(actionableLiveRecord()), "utf8"),
        { ...binding, workspaceFingerprint: "e".repeat(64) },
      ),
    ObservationRecordError,
  );
});

test("rejects a capture sidecar copied from another workspace", () => {
  assert.throws(
    () =>
      parse(captureSidecar(), {
        ...binding,
        workspaceFingerprint: "e".repeat(64),
      }),
    ObservationRecordError,
  );
});

test("rejects an uncontracted capture-sidecar root field", () => {
  assert.throws(
    () => parse({ ...captureSidecar(), unexpected: true }),
    ObservationRecordError,
  );
});

test("enforces the strict control-record byte ceiling at the record boundary", () => {
  const encoded = Buffer.from(JSON.stringify(captureSidecar()), "utf8");
  const exact = Buffer.concat([
    encoded,
    Buffer.from(" ".repeat(65_536 - encoded.byteLength), "utf8"),
  ]);

  assert.equal(exact.byteLength, 65_536);
  assert.doesNotThrow(() => parseCaptureSidecarBytes(exact, binding));
  const error = captureObservationError(() =>
    parseCaptureSidecarBytes(
      Buffer.concat([exact, Buffer.from(" ", "utf8")]),
      binding,
    ),
  );
  assert.equal(error.message, "");
});

test("contains malformed capture bytes as a content-free record error", () => {
  for (const bytes of [
    Buffer.from('{"private":"secret"', "utf8"),
    Buffer.from("null", "utf8"),
  ]) {
    const error = captureObservationError(() =>
      parseCaptureSidecarBytes(bytes, binding),
    );

    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /secret/);
  }
});

test("rejects capture sidecar shape and discriminator violations", () => {
  const valid = captureSidecar();
  const source = valid.source as Record<string, unknown>;
  const image = valid.image as Record<string, unknown>;
  const invalid = [
    { ...valid, kind: "cu.capture/v2" },
    { ...valid, schemaVersion: 2 },
    { ...valid, coordinateSpace: "pixel" },
    { ...valid, source: null },
    { ...valid, source: { ...source, captureKind: "window" } },
    { ...valid, source: { ...source, mapping: "other/v1" } },
    { ...valid, source: { ...source, unexpected: true } },
    { ...valid, image: [] },
    { ...valid, image: { ...image, mediaType: "image/jpeg" } },
    { ...valid, image: { ...image, unexpected: true } },
  ];

  for (const sidecar of invalid) {
    assert.throws(() => parse(sidecar), ObservationRecordError);
  }
});

test("rejects noncanonical immutable capture metadata", () => {
  const valid = captureSidecar();
  const source = valid.source as Record<string, unknown>;
  const image = valid.image as Record<string, unknown>;
  const invalid = [
    { ...valid, observationId: "obs_0123456789abcdef0123456789abcdef0" },
    { ...valid, capturedAt: "2026-07-24T00:00:00Z" },
    { ...valid, expiresAt: "2026-07-24T00:01:00.001Z" },
    { ...valid, environmentFingerprint: "B".repeat(64) },
    { ...valid, topologyFingerprint: "not-a-digest" },
    { ...valid, source: { ...source, leftPx: 1.5 } },
    { ...valid, source: { ...source, topPx: -1_000_001 } },
    { ...valid, source: { ...source, widthPx: 0 } },
    { ...valid, source: { ...source, heightPx: 32_769 } },
    { ...valid, image: { ...image, sha256: "D".repeat(64) } },
    { ...valid, image: { ...image, byteLength: 67_108_865 } },
    { ...valid, image: { ...image, width: 0 } },
    { ...valid, image: { ...image, height: 32_769 } },
  ];

  for (const sidecar of invalid) {
    assert.throws(() => parse(sidecar), ObservationRecordError);
  }
});
