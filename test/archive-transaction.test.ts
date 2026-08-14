import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveTransactionError,
  parseArchiveTransactionBytes
} from "../src/archive-transaction.js";

const binding = {
  runId: "work-a",
  workspaceFingerprint: "a".repeat(64)
};

function captureArchiveError(operation: () => void): ArchiveTransactionError {
  try {
    operation();
  } catch (error) {
    if (error instanceof ArchiveTransactionError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected ArchiveTransactionError");
}

function bundle(observationId: string): Record<string, unknown> {
  return {
    observationId,
    captureMetadataSha256: "b".repeat(64),
    imageSha256: "c".repeat(64),
    imageByteLength: 12345
  };
}

function publishTransaction(): Record<string, unknown> {
  return {
    kind: "cu.archive-transaction/v1",
    schemaVersion: 1,
    runId: binding.runId,
    workspaceFingerprint: binding.workspaceFingerprint,
    transactionId: "txn_0123456789abcdef0123456789abcdef",
    operation: "publish",
    state: "prepared",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    priorLive: null,
    movedBundles: [bundle("obs_1123456789abcdef0123456789abcdef")],
    historyEvents: [
      {
        eventId: "hist_0123456789abcdef0123456789abcdef_1",
        at: "2026-07-24T00:00:00.000Z",
        eventType: "capture_evicted",
        observationId: "obs_1123456789abcdef0123456789abcdef",
        capturedAt: "2026-07-23T23:00:00.000Z"
      }
    ],
    payload: {
      newBundle: bundle("obs_0123456789abcdef0123456789abcdef"),
      newLiveRecordSha256: "d".repeat(64),
      replacesObservationId: null,
      resolvesEffect: null
    }
  };
}

test("enforces strict bounded archive-transaction transport without content disclosure", () => {
  const encoded = Buffer.from(JSON.stringify(publishTransaction()), "utf8");
  const exact = Buffer.concat([
    encoded,
    Buffer.from(" ".repeat(65_536 - encoded.byteLength), "utf8")
  ]);
  assert.equal(exact.byteLength, 65_536);
  assert.doesNotThrow(() => parseArchiveTransactionBytes(exact, binding));

  const duplicate = Buffer.from(
    JSON.stringify(publishTransaction()).replace(
      '"transactionId":"txn_0123456789abcdef0123456789abcdef"',
      '"transactionId":"txn_0123456789abcdef0123456789abcdef","\\u0074ransactionId":"txn_0123456789abcdef0123456789abcdef"'
    ),
    "utf8"
  );
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}", "utf8")]);
  const tooDeep = Buffer.from(`${"[".repeat(65)}0${"]".repeat(65)}`, "utf8");
  for (const bytes of [
    Buffer.concat([exact, Buffer.from(" ", "utf8")]),
    Buffer.from([0xff]),
    bom,
    duplicate,
    tooDeep,
    Buffer.from('{"private":"keyboard input"', "utf8")
  ]) {
    const error = captureArchiveError(() => parseArchiveTransactionBytes(bytes, binding));
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /keyboard input/);
  }
});

test("rejects noncanonical nested archive-transaction fields", () => {
  const publish = publishTransaction();
  const priorLive = {
    observationId: "obs_2123456789abcdef0123456789abcdef",
    liveRecordSha256: "e".repeat(64)
  };
  const movedBundle = (publish.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  const capture = (publish.historyEvents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const recovery = {
    eventId: "hist_1123456789abcdef0123456789abcdef_2",
    at: "2026-07-24T00:00:01.000Z",
    eventType: "effect_recovered",
    effectId: "eff_0123456789abcdef0123456789abcdef",
    recoveryObservationId: "obs_0123456789abcdef0123456789abcdef"
  };
  const publishPayload = publish.payload as Record<string, unknown>;
  const clearRange = clearRangeTransaction();
  const clearRangePayload = clearRange.payload as Record<string, unknown>;
  const clearAll = clearAllTransaction();
  const clearAllPayload = clearAll.payload as Record<string, unknown>;
  const invalid = [
    { ...publish, priorLive: { ...priorLive, observationId: "obs_wrong" } },
    { ...publish, priorLive: { ...priorLive, liveRecordSha256: "E".repeat(64) } },
    { ...publish, movedBundles: [{ ...movedBundle, observationId: "obs_wrong" }] },
    { ...publish, movedBundles: [{ ...movedBundle, captureMetadataSha256: "B".repeat(64) }] },
    { ...publish, movedBundles: [{ ...movedBundle, imageByteLength: 67_108_865 }] },
    { ...publish, movedBundles: { unexpected: true } },
    { ...publish, historyEvents: [{ ...capture, eventId: "hist_wrong" }] },
    { ...publish, historyEvents: [{ ...capture, eventType: "unknown" }] },
    { ...publish, historyEvents: { unexpected: true } },
    { ...publish, historyEvents: [{ ...capture, at: "2026-07-24T00:00:00Z" }] },
    { ...publish, historyEvents: [{ ...capture, observationId: "obs_wrong" }] },
    { ...publish, historyEvents: [{ ...capture, capturedAt: "2026-07-24T00:00:00Z" }] },
    { ...publish, historyEvents: [{ ...recovery, recoveryObservationId: "obs_wrong" }] },
    { ...publish, payload: { ...publishPayload, newLiveRecordSha256: "D".repeat(64) } },
    { ...publish, payload: { ...publishPayload, replacesObservationId: "obs_wrong" } },
    {
      ...publish,
      payload: {
        ...publishPayload,
        resolvesEffect: { effectId: "eff_0123456789abcdef012345678abcdef", journalSha256: "E".repeat(64) }
      }
    },
    { ...publish, payload: null },
    { ...clearRange, payload: { ...clearRangePayload, invalidatesLive: "false" } },
    { ...clearRange, payload: { ...clearRangePayload, extra: true } },
    { ...clearRange, payload: { ...clearRangePayload, selectedObservationIds: ["obs_wrong"] } },
    { ...clearAll, payload: { ...clearAllPayload, selectedObservationIds: ["obs_wrong"] } },
    { ...clearAll, payload: { ...clearAllPayload, extra: true } }
  ];

  for (const transaction of invalid) {
    assert.throws(
      () => parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding),
      ArchiveTransactionError
    );
  }
});

test("admits only distinct exact transaction history descriptors", () => {
  const source = publishTransaction();
  const capture = (source.historyEvents as Record<string, unknown>[])[0] as Record<string, unknown>;
  const recovery = {
    eventId: "hist_1123456789abcdef0123456789abcdef_2",
    at: "2026-07-24T00:00:01.000Z",
    eventType: "effect_recovered",
    effectId: "eff_0123456789abcdef0123456789abcdef",
    recoveryObservationId: "obs_0123456789abcdef0123456789abcdef"
  };
  const valid: Record<string, unknown> = {
    ...source,
    historyEvents: [capture, recovery]
  };
  assert.doesNotThrow(() =>
    parseArchiveTransactionBytes(Buffer.from(JSON.stringify(valid), "utf8"), binding)
  );

  const invalid = [
    { ...valid, historyEvents: [{ ...capture, rawTypedText: "private keyboard input" }] },
    { ...valid, historyEvents: [{ ...recovery, effectId: "eff_wrong" }] },
    { ...valid, historyEvents: [capture, { ...capture }] }
  ];

  for (const transaction of invalid) {
    const error = captureArchiveError(() =>
      parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding)
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("admits only exact immutable prior-live and moved-bundle snapshots", () => {
  const valid: Record<string, unknown> = {
    ...publishTransaction(),
    priorLive: {
      observationId: "obs_2123456789abcdef0123456789abcdef",
      liveRecordSha256: "e".repeat(64)
    }
  };
  assert.doesNotThrow(() =>
    parseArchiveTransactionBytes(Buffer.from(JSON.stringify(valid), "utf8"), binding)
  );

  const movedBundle = (valid.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  const invalid = [
    {
      ...valid,
      priorLive: { ...(valid.priorLive as Record<string, unknown>), unexpected: true }
    },
    {
      ...valid,
      movedBundles: [{ ...movedBundle, imageByteLength: 0 }]
    },
    {
      ...valid,
      movedBundles: [{ ...movedBundle, imageSha256: "C".repeat(64) }]
    },
    {
      ...valid,
      movedBundles: [{ ...movedBundle, extra: true }]
    }
  ];

  for (const transaction of invalid) {
    assert.throws(
      () => parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding),
      ArchiveTransactionError
    );
  }
});

test("rejects noncanonical archive-transaction common fields", () => {
  const valid = publishTransaction();
  const invalid = [
    { transaction: { ...valid, kind: "cu.archive-transaction/v2" }, expected: binding },
    { transaction: { ...valid, schemaVersion: 2 }, expected: binding },
    { transaction: { ...valid, transactionId: "txn_wrong" }, expected: binding },
    { transaction: { ...valid, operation: "unknown" }, expected: binding },
    { transaction: { ...valid, state: "complete" }, expected: binding },
    { transaction: { ...valid, createdAt: "2026-07-24T00:00:00Z" }, expected: binding },
    { transaction: { ...valid, updatedAt: "2026-07-23T23:59:59.999Z" }, expected: binding },
    {
      transaction: { ...valid, runId: "private keyboard input" },
      expected: { ...binding, runId: "private keyboard input" }
    },
    {
      transaction: { ...valid, workspaceFingerprint: "private keyboard input" },
      expected: { ...binding, workspaceFingerprint: "private keyboard input" }
    }
  ];

  for (const { transaction, expected } of invalid) {
    const error = captureArchiveError(() =>
      parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), expected)
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("contains malformed transaction transport as a content-free domain error", () => {
  for (const bytes of [
    Buffer.from('{"private":"keyboard input"', "utf8"),
    Buffer.from("null", "utf8")
  ]) {
    const error = captureArchiveError(() => parseArchiveTransactionBytes(bytes, binding));
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /keyboard input/);
  }
});

test("rejects uncontracted transaction fields without disclosing candidate text", () => {
  const error = captureArchiveError(() =>
    parseArchiveTransactionBytes(
      Buffer.from(JSON.stringify({ ...publishTransaction(), rawTypedText: "private keyboard input" }), "utf8"),
      binding
    )
  );

  assert.equal(error.message, "");
  assert.doesNotMatch(error.message, /private keyboard input/);
});

test("rejects a publish transaction copied from another admitted workspace", () => {
  assert.throws(
    () => parseArchiveTransactionBytes(
      Buffer.from(JSON.stringify(publishTransaction()), "utf8"),
      { ...binding, workspaceFingerprint: "0".repeat(64) }
    ),
    ArchiveTransactionError
  );
});

function clearRangeTransaction(): Record<string, unknown> {
  const source = publishTransaction();
  const moved = (source.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  return {
    ...source,
    operation: "clear_range",
    state: "assets_staged",
    payload: {
      invalidatesLive: false,
      selectedObservationIds: [moved.observationId]
    }
  };
}

function clearAllTransaction(): Record<string, unknown> {
  const source = publishTransaction();
  const moved = (source.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  return {
    ...source,
    operation: "clear_all",
    state: "cutover_committed",
    historyEvents: [],
    payload: {
      deletesLiveRecord: true,
      selectedObservationIds: [moved.observationId]
    }
  };
}

function assertClearAllConsistencyError(transaction: Record<string, unknown>): void {
  const error = captureArchiveError(() =>
    parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding)
  );
  assert.equal(error.message, "");
}

test("rejects a clear-all selection with a mismatched moved-bundle value", () => {
  const clearAll = clearAllTransaction();
  const payload = clearAll.payload as Record<string, unknown>;
  assertClearAllConsistencyError({
    ...clearAll,
    payload: {
      ...payload,
      selectedObservationIds: ["obs_2123456789abcdef0123456789abcdef"]
    }
  });
});

test("rejects a clear-all selection shorter than its moved-bundle list", () => {
  const clearAll = clearAllTransaction();
  const payload = clearAll.payload as Record<string, unknown>;
  assertClearAllConsistencyError({
    ...clearAll,
    payload: {
      ...payload,
      selectedObservationIds: []
    }
  });
});

test("rejects a clear-all selection ordered differently from its moved bundles", () => {
  const clearAll = clearAllTransaction();
  const payload = clearAll.payload as Record<string, unknown>;
  const moved = (clearAll.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  const second = bundle("obs_2123456789abcdef0123456789abcdef");
  assertClearAllConsistencyError({
    ...clearAll,
    movedBundles: [moved, second],
    payload: {
      ...payload,
      selectedObservationIds: [second.observationId, moved.observationId]
    }
  });
});

test("rejects duplicate moved bundles despite a distinct clear-all selection", () => {
  const clearAll = clearAllTransaction();
  const payload = clearAll.payload as Record<string, unknown>;
  const moved = (clearAll.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  const second = bundle("obs_2123456789abcdef0123456789abcdef");
  assertClearAllConsistencyError({
    ...clearAll,
    movedBundles: [moved, { ...moved }],
    payload: {
      ...payload,
      selectedObservationIds: [moved.observationId, second.observationId]
    }
  });
});

test("admits exact operation payload variants and direct cleanup relations", () => {
  const publish = publishTransaction();
  const publishPayload = publish.payload as Record<string, unknown>;
  const publishWithRecovery: Record<string, unknown> = {
    ...publish,
    payload: {
      ...publishPayload,
      replacesObservationId: "obs_2123456789abcdef0123456789abcdef",
      resolvesEffect: {
        effectId: "eff_0123456789abcdef0123456789abcdef",
        journalSha256: "e".repeat(64)
      }
    }
  };
  const clearRange = clearRangeTransaction();
  const clearAll = clearAllTransaction();

  for (const transaction of [publishWithRecovery, clearRange, clearAll]) {
    assert.doesNotThrow(() =>
      parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding)
    );
  }

  const clearRangePayload = clearRange.payload as Record<string, unknown>;
  const clearAllPayload = clearAll.payload as Record<string, unknown>;
  const oldBundle = (clearRange.movedBundles as Record<string, unknown>[])[0] as Record<string, unknown>;
  const secondBundle = bundle("obs_2123456789abcdef0123456789abcdef");
  const invalid = [
    { ...publish, payload: { ...publishPayload, rawTypedText: "private keyboard input" } },
    {
      ...publishWithRecovery,
      payload: {
        ...(publishWithRecovery.payload as Record<string, unknown>),
        resolvesEffect: { effectId: "eff_wrong", journalSha256: "e".repeat(64) }
      }
    },
    { ...clearRange, payload: { ...clearRangePayload, selectedObservationIds: [] } },
    {
      ...clearRange,
      movedBundles: [oldBundle, secondBundle],
      payload: {
        ...clearRangePayload,
        selectedObservationIds: [secondBundle.observationId, oldBundle.observationId]
      }
    },
    { ...clearAll, payload: { ...clearAllPayload, deletesLiveRecord: false } },
    {
      ...clearAll,
      payload: {
        ...clearAllPayload,
        selectedObservationIds: [oldBundle.observationId, oldBundle.observationId]
      }
    },
    { ...clearAll, historyEvents: publish.historyEvents }
  ];

  for (const transaction of invalid) {
    const error = captureArchiveError(() =>
      parseArchiveTransactionBytes(Buffer.from(JSON.stringify(transaction), "utf8"), binding)
    );
    assert.equal(error.message, "");
    assert.doesNotMatch(error.message, /private keyboard input/);
  }
});

test("admits a complete workspace-bound publish archive transaction", () => {
  const transaction = parseArchiveTransactionBytes(
    Buffer.from(JSON.stringify(publishTransaction()), "utf8"),
    binding
  );

  assert.equal(transaction.operation, "publish");
  if (transaction.operation !== "publish") {
    assert.fail("expected publish transaction");
  }
  assert.equal(transaction.payload.newBundle.observationId, "obs_0123456789abcdef0123456789abcdef");
  assert.equal(transaction.historyEvents[0]?.eventType, "capture_evicted");
  assert.deepEqual(Object.keys(transaction).sort(), [
    "createdAt",
    "historyEvents",
    "kind",
    "movedBundles",
    "operation",
    "payload",
    "priorLive",
    "runId",
    "schemaVersion",
    "state",
    "transactionId",
    "updatedAt",
    "workspaceFingerprint"
  ]);
  assert.deepEqual(Object.keys(transaction.payload).sort(), [
    "newBundle",
    "newLiveRecordSha256",
    "replacesObservationId",
    "resolvesEffect"
  ]);
});
