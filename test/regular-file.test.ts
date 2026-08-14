import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BINARY_BUNDLE_BYTES,
  MAX_CONTROL_RECORD_BYTES,
  captureStableAncestorBaseline,
  readStableOptionalRegularFile,
  readStableOptionalRegularFileAgainstBaseline,
  readStableOptionalRegularFileWithWitnessAgainstBaseline,
  readStableOptionalBinaryFileWithWitnessAgainstBaseline,
  readStableBinaryFileWithWitness,
  readStableRegularFile,
  readStableRegularFileWithWitness,
  revalidateStableAncestorIdentitiesAgainstBaseline,
  revalidateStableBinaryFileWitness,
  revalidateStableRegularFileWitness,
  assertStableRegularFileWitnessContinuity,
  RegularFileAncestorChangedError,
  RegularFileError,
  type RegularFileOps,
  type RegularFileStat,
  type StableAncestorBaseline,
  type StableBinaryFileWitness,
  type StableRegularFileWitness
} from "../src/regular-file.js";

const workspaceDirectory = "C:\\workspace";
const stateDirectory = `${workspaceDirectory}\\.cu`;
const recordPath = `${stateDirectory}\\workspace.json`;
const runDirectory = `${stateDirectory}\\work-a`;
const archiveRecordPath = `${runDirectory}\\archive-transaction.json`;
const capturesDirectory = `${runDirectory}\\captures`;
const imagePath = `${capturesDirectory}\\obs_0123456789abcdef0123456789abcdef.png`;
const body = Buffer.from("{}", "utf8");

function stat(overrides: Partial<RegularFileStat> = {}): RegularFileStat {
  return {
    dev: 1n,
    ino: 1n,
    birthtimeNs: 1n,
    ctimeNs: 1n,
    mtimeNs: 1n,
    size: BigInt(body.length),
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    ...overrides
  };
}

function directory(overrides: Partial<RegularFileStat> = {}): RegularFileStat {
  return stat({ isFile: false, isDirectory: true, ...overrides });
}

function archiveOps(): RegularFileOps {
  const archiveStat = stat({ ino: 30n, birthtimeNs: 30n });
  const stateStat = directory({ ino: 10n, birthtimeNs: 10n });
  const runStat = directory({ ino: 20n, birthtimeNs: 20n });
  let cursor = 0;

  return {
    lstat(path) {
      if (path === stateDirectory) return stateStat;
      if (path === runDirectory) return runStat;
      if (path === archiveRecordPath) return archiveStat;
      throw new Error(`unexpected lstat: ${path}`);
    },
    realpath(path) {
      return path;
    },
    openRead(path) {
      assert.equal(path, archiveRecordPath);
      return 42;
    },
    fstat(descriptor) {
      assert.equal(descriptor, 42);
      return archiveStat;
    },
    read(descriptor, target, offset, length) {
      assert.equal(descriptor, 42);
      const chunk = body.subarray(cursor, cursor + length);
      chunk.copy(target, offset);
      cursor += chunk.length;
      return chunk.length;
    },
    close(descriptor) {
      assert.equal(descriptor, 42);
    }
  };
}

function stableOps(): RegularFileOps {
  const recordStat = stat();
  const directoryStat = directory();
  let cursor = 0;

  return {
    lstat(path) {
      if (path === stateDirectory) return directoryStat;
      if (path === recordPath) return recordStat;
      throw new Error(`unexpected lstat: ${path}`);
    },
    realpath(path) {
      return path;
    },
    openRead(path) {
      assert.equal(path, recordPath);
      return 41;
    },
    fstat(descriptor) {
      assert.equal(descriptor, 41);
      return recordStat;
    },
    read(descriptor, target, offset, length) {
      assert.equal(descriptor, 41);
      const chunk = body.subarray(cursor, cursor + length);
      chunk.copy(target, offset);
      cursor += chunk.length;
      return chunk.length;
    },
    close(descriptor) {
      assert.equal(descriptor, 41);
    }
  };
}

function binaryOps(bytes: Buffer, size = BigInt(bytes.length)): RegularFileOps {
  const imageStat = stat({ ino: 40n, birthtimeNs: 40n, size });
  const stateStat = directory({ ino: 10n, birthtimeNs: 10n });
  const runStat = directory({ ino: 20n, birthtimeNs: 20n });
  const capturesStat = directory({ ino: 30n, birthtimeNs: 30n });
  let cursor = 0;

  return {
    lstat(path) {
      if (path === stateDirectory) return stateStat;
      if (path === runDirectory) return runStat;
      if (path === capturesDirectory) return capturesStat;
      if (path === imagePath) return imageStat;
      throw new Error(`unexpected lstat: ${path}`);
    },
    realpath(path) {
      return path;
    },
    openRead(path) {
      assert.equal(path, imagePath);
      return 43;
    },
    fstat(descriptor) {
      assert.equal(descriptor, 43);
      return imageStat;
    },
    read(descriptor, target, offset, length) {
      assert.equal(descriptor, 43);
      const chunk = bytes.subarray(cursor, cursor + length);
      chunk.copy(target, offset);
      cursor += chunk.length;
      return chunk.length;
    },
    close(descriptor) {
      assert.equal(descriptor, 43);
    }
  };
}

test("binary witness admits and revalidates bytes above the control-record ceiling", () => {
  const bytes = Buffer.alloc(MAX_CONTROL_RECORD_BYTES + 1, 0x61);
  const ancestors = [stateDirectory, runDirectory, capturesDirectory];
  const admitted = readStableBinaryFileWithWitness(
    imagePath,
    ancestors,
    binaryOps(bytes)
  );

  assert.deepEqual(admitted.bytes, bytes);
  assert.doesNotThrow(() =>
    revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      admitted.witness,
      binaryOps(bytes)
    )
  );
  assert.throws(
    () => readStableRegularFileWithWitness(imagePath, ancestors, binaryOps(bytes)),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableRegularFileWitness(
      imagePath,
      ancestors,
      admitted.witness as unknown as StableRegularFileWitness,
      binaryOps(bytes)
    ),
    RegularFileError
  );

  const control = readStableRegularFileWithWitness(
    imagePath,
    ancestors,
    binaryOps(body)
  );
  assert.throws(
    () => revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      control.witness as unknown as StableBinaryFileWitness,
      binaryOps(body)
    ),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      {} as StableBinaryFileWitness,
      binaryOps(bytes)
    ),
    RegularFileError
  );
});

test("binary witness binds leaf identity, bytes, and every direct ancestor", () => {
  const ancestors = [stateDirectory, runDirectory, capturesDirectory];
  const admitted = readStableBinaryFileWithWitness(
    imagePath,
    ancestors,
    binaryOps(body)
  );

  const replaced = binaryOps(body);
  const replacement = stat({ ino: 41n, birthtimeNs: 41n });
  replaced.lstat = (path) => {
    if (path === stateDirectory) return directory({ ino: 10n, birthtimeNs: 10n });
    if (path === runDirectory) return directory({ ino: 20n, birthtimeNs: 20n });
    if (path === capturesDirectory) return directory({ ino: 30n, birthtimeNs: 30n });
    if (path === imagePath) return replacement;
    throw new Error(`unexpected lstat: ${path}`);
  };
  replaced.fstat = () => replacement;
  assert.throws(
    () => revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      admitted.witness,
      replaced
    ),
    RegularFileError
  );

  const changedBytes = binaryOps(Buffer.from("[]", "utf8"));
  assert.throws(
    () => revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      admitted.witness,
      changedBytes
    ),
    RegularFileError
  );

  const changedAncestor = binaryOps(body);
  changedAncestor.lstat = (path) => {
    if (path === stateDirectory) return directory({ ino: 10n, birthtimeNs: 10n });
    if (path === runDirectory) {
      return directory({ ino: 20n, birthtimeNs: 20n, mtimeNs: 2n });
    }
    if (path === capturesDirectory) return directory({ ino: 30n, birthtimeNs: 30n });
    if (path === imagePath) return stat({ ino: 40n, birthtimeNs: 40n });
    throw new Error(`unexpected lstat: ${path}`);
  };
  assert.throws(
    () => revalidateStableBinaryFileWitness(
      imagePath,
      ancestors,
      admitted.witness,
      changedAncestor
    ),
    RegularFileError
  );
});

test("binary admission includes the exact cap and rejects cap plus one before open", () => {
  assert.equal(MAX_BINARY_BUNDLE_BYTES, 67_108_864);
  const ancestors = [stateDirectory, runDirectory, capturesDirectory];
  for (const [size, expectedOpen] of [
    [MAX_BINARY_BUNDLE_BYTES, true],
    [MAX_BINARY_BUNDLE_BYTES + 1, false]
  ] as const) {
    const ops = binaryOps(body, BigInt(size));
    let opened = false;
    ops.openRead = () => {
      opened = true;
      throw new Error("stop after size admission");
    };

    assert.throws(
      () => readStableBinaryFileWithWitness(imagePath, ancestors, ops),
      RegularFileError
    );
    assert.equal(opened, expectedOpen);
  }
});

test("stable record witness rejects a byte-identical replacement inode after admission", () => {
  const admitted = readStableRegularFileWithWitness(recordPath, [stateDirectory], stableOps());
  const replacementOps = stableOps();
  const replacement = stat({ ino: 2n, birthtimeNs: 2n });
  replacementOps.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) return replacement;
    throw new Error(`unexpected lstat: ${path}`);
  };
  replacementOps.fstat = () => replacement;

  assert.deepEqual(admitted.bytes, body);
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], admitted.witness, replacementOps),
    RegularFileError
  );
});

test("stable record witness accepts only unchanged path, ancestor, snapshot, and byte state", () => {
  const admitted = readStableRegularFileWithWitness(recordPath, [stateDirectory], stableOps());

  assert.doesNotThrow(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], admitted.witness, stableOps())
  );
  assert.throws(
    () => revalidateStableRegularFileWitness(archiveRecordPath, [stateDirectory], admitted.witness, stableOps()),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [workspaceDirectory], admitted.witness, stableOps()),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], {} as StableRegularFileWitness, stableOps()),
    RegularFileError
  );

  const metadataChangedOps = stableOps();
  const metadataChanged = stat({ mtimeNs: 2n });
  metadataChangedOps.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) return metadataChanged;
    throw new Error(`unexpected lstat: ${path}`);
  };
  metadataChangedOps.fstat = () => metadataChanged;
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], admitted.witness, metadataChangedOps),
    RegularFileError
  );

  const ancestorChangedOps = stableOps();
  ancestorChangedOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ctimeNs: 2n });
    if (path === recordPath) return stat();
    throw new Error(`unexpected lstat: ${path}`);
  };
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], admitted.witness, ancestorChangedOps),
    RegularFileError
  );

  const bytesChangedOps = stableOps();
  const replacementBytes = Buffer.from("[]", "utf8");
  let cursor = 0;
  bytesChangedOps.read = (descriptor, target, offset, length) => {
    assert.equal(descriptor, 41);
    const chunk = replacementBytes.subarray(cursor, cursor + length);
    chunk.copy(target, offset);
    cursor += chunk.length;
    return chunk.length;
  };
  assert.throws(
    () => revalidateStableRegularFileWitness(recordPath, [stateDirectory], admitted.witness, bytesChangedOps),
    RegularFileError
  );
});

test("stable witness continuity keeps one record across expected ancestor metadata churn", () => {
  const initial = readStableRegularFileWithWitness(
    recordPath,
    [stateDirectory],
    stableOps()
  );
  const churnOps = stableOps();
  churnOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ctimeNs: 2n, mtimeNs: 2n });
    if (path === recordPath) return stat();
    throw new Error(`unexpected lstat: ${path}`);
  };
  const afterAncestorChurn = readStableRegularFileWithWitness(
    recordPath,
    [stateDirectory],
    churnOps
  );

  assert.doesNotThrow(() =>
    assertStableRegularFileWitnessContinuity(
      recordPath,
      [stateDirectory],
      initial.witness,
      afterAncestorChurn.witness
    )
  );

  const replacementOps = stableOps();
  const replacement = stat({ ino: 2n, birthtimeNs: 2n });
  replacementOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ctimeNs: 2n, mtimeNs: 2n });
    if (path === recordPath) return replacement;
    throw new Error(`unexpected lstat: ${path}`);
  };
  replacementOps.fstat = () => replacement;
  const replaced = readStableRegularFileWithWitness(
    recordPath,
    [stateDirectory],
    replacementOps
  );
  assert.throws(
    () =>
      assertStableRegularFileWitnessContinuity(
        recordPath,
        [stateDirectory],
        initial.witness,
        replaced.witness
      ),
    RegularFileError
  );

  const recordMetadataOps = stableOps();
  const changedRecordMetadata = stat({ mtimeNs: 2n });
  recordMetadataOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ctimeNs: 2n, mtimeNs: 2n });
    if (path === recordPath) return changedRecordMetadata;
    throw new Error(`unexpected lstat: ${path}`);
  };
  recordMetadataOps.fstat = () => changedRecordMetadata;
  const recordMetadataChanged = readStableRegularFileWithWitness(
    recordPath,
    [stateDirectory],
    recordMetadataOps
  );
  assert.throws(
    () =>
      assertStableRegularFileWitnessContinuity(
        recordPath,
        [stateDirectory],
        initial.witness,
        recordMetadataChanged.witness
      ),
    RegularFileError
  );

  const changedBytesOps = stableOps();
  const changedBytes = Buffer.from("[]", "utf8");
  let changedBytesCursor = 0;
  changedBytesOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ctimeNs: 2n, mtimeNs: 2n });
    if (path === recordPath) return stat();
    throw new Error(`unexpected lstat: ${path}`);
  };
  changedBytesOps.read = (descriptor, target, offset, length) => {
    assert.equal(descriptor, 41);
    const chunk = changedBytes.subarray(changedBytesCursor, changedBytesCursor + length);
    chunk.copy(target, offset);
    changedBytesCursor += chunk.length;
    return chunk.length;
  };
  const bytesChanged = readStableRegularFileWithWitness(
    recordPath,
    [stateDirectory],
    changedBytesOps
  );
  assert.throws(
    () =>
      assertStableRegularFileWitnessContinuity(
        recordPath,
        [stateDirectory],
        initial.witness,
        bytesChanged.witness
      ),
    RegularFileError
  );

  assert.throws(
    () =>
      assertStableRegularFileWitnessContinuity(
        archiveRecordPath,
        [stateDirectory],
        initial.witness,
        afterAncestorChurn.witness
      ),
    RegularFileError
  );
  assert.throws(
    () =>
      assertStableRegularFileWitnessContinuity(
        recordPath,
        [stateDirectory],
        {} as StableRegularFileWitness,
        afterAncestorChurn.witness
      ),
    RegularFileError
  );
});

test("readStableOptionalRegularFileAgainstBaseline returns undefined for a stable absent leaf under its captured ancestor baseline", () => {
  const ops = stableOps();
  let opened = false;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  ops.openRead = () => {
    opened = true;
    throw new Error("missing leaf must not be opened");
  };
  const baseline = captureStableAncestorBaseline(recordPath, [stateDirectory], ops);

  assert.equal(
    readStableOptionalRegularFileAgainstBaseline(recordPath, [stateDirectory], baseline, ops),
    undefined
  );
  assert.equal(opened, false);
});

test("readStableOptionalRegularFileAgainstBaseline rejects a persistent ancestor replacement before probing the leaf", () => {
  const ops = stableOps();
  let replacementActive = false;
  let leafProbed = false;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      return replacementActive
        ? directory({ ino: 2n, birthtimeNs: 2n, ctimeNs: 2n })
        : directory();
    }
    if (path === recordPath) {
      leafProbed = true;
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  const baseline = captureStableAncestorBaseline(recordPath, [stateDirectory], ops);
  replacementActive = true;

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(recordPath, [stateDirectory], baseline, ops),
    RegularFileError
  );
  assert.equal(leafProbed, false);
});

test("readStableOptionalRegularFileAgainstBaseline rejects an ancestor replacement that persists after its precheck", () => {
  const ops = stableOps();
  let ancestorReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      ancestorReads += 1;
      return ancestorReads <= 2
        ? directory()
        : directory({ ino: 2n, birthtimeNs: 2n, ctimeNs: 2n });
    }
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  const baseline = captureStableAncestorBaseline(recordPath, [stateDirectory], ops);

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(recordPath, [stateDirectory], baseline, ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFileAgainstBaseline rejects a baseline reused for another record path", () => {
  const alternateRecordPath = `${stateDirectory}\\archive-transaction.json`;
  const ops = stableOps();
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === alternateRecordPath) {
      throw Object.assign(new Error("simulated missing alternate leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  const baseline = captureStableAncestorBaseline(recordPath, [stateDirectory], ops);

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(alternateRecordPath, [stateDirectory], baseline, ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFileAgainstBaseline rejects a persistent .cu replacement in a direct multi-ancestor chain", () => {
  const ops = archiveOps();
  const originalLstat = ops.lstat;
  let replaced = false;
  let leafProbed = false;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      return replaced
        ? directory({ ino: 11n, birthtimeNs: 11n, ctimeNs: 11n })
        : directory({ ino: 10n, birthtimeNs: 10n });
    }
    if (path === archiveRecordPath) leafProbed = true;
    return originalLstat(path);
  };
  const baseline = captureStableAncestorBaseline(
    archiveRecordPath,
    [stateDirectory, runDirectory],
    ops
  );
  replaced = true;

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [stateDirectory, runDirectory],
      baseline,
      ops
    ),
    RegularFileError
  );
  assert.equal(leafProbed, false);
});

test("readStableOptionalRegularFileAgainstBaseline rejects a persistent run-directory replacement in a direct multi-ancestor chain", () => {
  const ops = archiveOps();
  const originalLstat = ops.lstat;
  let replaced = false;
  let leafProbed = false;
  ops.lstat = (path) => {
    if (path === runDirectory) {
      return replaced
        ? directory({ ino: 21n, birthtimeNs: 21n, ctimeNs: 21n })
        : directory({ ino: 20n, birthtimeNs: 20n });
    }
    if (path === archiveRecordPath) leafProbed = true;
    return originalLstat(path);
  };
  const baseline = captureStableAncestorBaseline(
    archiveRecordPath,
    [stateDirectory, runDirectory],
    ops
  );
  replaced = true;

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [stateDirectory, runDirectory],
      baseline,
      ops
    ),
    RegularFileError
  );
  assert.equal(leafProbed, false);
});

test("readStableOptionalRegularFileAgainstBaseline rejects a persistent replacement after its precheck for a present leaf", () => {
  const ops = archiveOps();
  const originalLstat = ops.lstat;
  let stateReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      stateReads += 1;
      return stateReads <= 2
        ? directory({ ino: 10n, birthtimeNs: 10n })
        : directory({ ino: 11n, birthtimeNs: 11n, ctimeNs: 11n });
    }
    return originalLstat(path);
  };
  const baseline = captureStableAncestorBaseline(
    archiveRecordPath,
    [stateDirectory, runDirectory],
    ops
  );

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [stateDirectory, runDirectory],
      baseline,
      ops
    ),
    RegularFileError
  );
});

test("readStableOptionalRegularFileAgainstBaseline admits descriptor-bound present bytes under an unchanged baseline", () => {
  const ops = archiveOps();
  const baseline = captureStableAncestorBaseline(
    archiveRecordPath,
    [stateDirectory, runDirectory],
    ops
  );

  assert.deepEqual(
    readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [stateDirectory, runDirectory],
      baseline,
      ops
    ),
    body
  );
});

test("baseline-bound optional present read returns the witness from its descriptor admission", () => {
  const ops = archiveOps();
  const ancestors = [stateDirectory, runDirectory];
  const baseline = captureStableAncestorBaseline(archiveRecordPath, ancestors, ops);

  const admitted = readStableOptionalRegularFileWithWitnessAgainstBaseline(
    archiveRecordPath,
    ancestors,
    baseline,
    ops
  );

  if (admitted === undefined) {
    assert.fail("expected present stable record admission");
  }
  assert.deepEqual(admitted.bytes, body);
  assert.doesNotThrow(() =>
    revalidateStableRegularFileWitness(
      archiveRecordPath,
      ancestors,
      admitted.witness,
      archiveOps()
    )
  );
});

test("baseline-bound optional binary present read returns a binary witness", () => {
  const ops = archiveOps();
  const ancestors = [stateDirectory, runDirectory];
  const baseline = captureStableAncestorBaseline(archiveRecordPath, ancestors, ops);
  const admitted = readStableOptionalBinaryFileWithWitnessAgainstBaseline(
    archiveRecordPath,
    ancestors,
    baseline,
    ops
  );
  if (admitted === undefined) {
    assert.fail("expected present stable binary admission");
  }
  assert.deepEqual(admitted.bytes, body);
  assert.doesNotThrow(() => revalidateStableBinaryFileWitness(
    archiveRecordPath,
    ancestors,
    admitted.witness,
    archiveOps()
  ));
  assert.throws(() => readStableOptionalBinaryFileWithWitnessAgainstBaseline(
    archiveRecordPath,
    ancestors,
    {} as StableAncestorBaseline,
    archiveOps()
  ), RegularFileError);
});

test("baseline-bound optional witness retains the full ordered ancestor chain", () => {
  const ops = archiveOps();
  const ancestors = [stateDirectory, runDirectory];
  const baseline = captureStableAncestorBaseline(archiveRecordPath, ancestors, ops);
  const admitted = readStableOptionalRegularFileWithWitnessAgainstBaseline(
    archiveRecordPath,
    ancestors,
    baseline,
    ops
  );
  if (admitted === undefined) {
    assert.fail("expected present stable record admission");
  }

  const replacedRunOps = archiveOps();
  replacedRunOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ino: 10n, birthtimeNs: 10n });
    if (path === runDirectory) return directory({ ino: 21n, birthtimeNs: 21n });
    if (path === archiveRecordPath) return stat({ ino: 30n, birthtimeNs: 30n });
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => revalidateStableRegularFileWitness(
      archiveRecordPath,
      ancestors,
      admitted.witness,
      replacedRunOps
    ),
    RegularFileError
  );
});

test("readStableOptionalRegularFileAgainstBaseline rejects forged and reordered baseline use", () => {
  const ops = archiveOps();
  const baseline = captureStableAncestorBaseline(
    archiveRecordPath,
    [stateDirectory, runDirectory],
    ops
  );

  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [runDirectory, stateDirectory],
      baseline,
      ops
    ),
    RegularFileError
  );
  assert.throws(
    () => readStableOptionalRegularFileAgainstBaseline(
      archiveRecordPath,
      [stateDirectory, runDirectory],
      {} as StableAncestorBaseline,
      ops
    ),
    RegularFileError
  );
});

test("baseline ancestor identity revalidation ignores metadata churn but rejects replacement and misuse", () => {
  const ancestors = [stateDirectory, runDirectory];
  const baseline = captureStableAncestorBaseline(archiveRecordPath, ancestors, archiveOps());
  const churnedOps = archiveOps();
  churnedOps.lstat = (path) => {
    if (path === stateDirectory) {
      return directory({ ino: 10n, birthtimeNs: 10n, ctimeNs: 101n, mtimeNs: 101n });
    }
    if (path === runDirectory) {
      return directory({ ino: 20n, birthtimeNs: 20n, ctimeNs: 202n, mtimeNs: 202n });
    }
    if (path === archiveRecordPath) return stat({ ino: 30n, birthtimeNs: 30n });
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.doesNotThrow(() =>
    revalidateStableAncestorIdentitiesAgainstBaseline(
      archiveRecordPath,
      ancestors,
      baseline,
      churnedOps
    )
  );

  const replacedRunOps = archiveOps();
  replacedRunOps.lstat = (path) => {
    if (path === stateDirectory) return directory({ ino: 10n, birthtimeNs: 10n });
    if (path === runDirectory) return directory({ ino: 21n, birthtimeNs: 21n });
    if (path === archiveRecordPath) return stat({ ino: 30n, birthtimeNs: 30n });
    throw new Error(`unexpected lstat: ${path}`);
  };
  assert.throws(
    () => revalidateStableAncestorIdentitiesAgainstBaseline(
      archiveRecordPath,
      ancestors,
      baseline,
      replacedRunOps
    ),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableAncestorIdentitiesAgainstBaseline(
      archiveRecordPath,
      [...ancestors].reverse(),
      baseline,
      archiveOps()
    ),
    RegularFileError
  );
  assert.throws(
    () => revalidateStableAncestorIdentitiesAgainstBaseline(
      archiveRecordPath,
      ancestors,
      {} as StableAncestorBaseline,
      archiveOps()
    ),
    RegularFileError
  );
});

test("readStableOptionalRegularFile returns undefined for a stable absent leaf without opening it", () => {
  const ops = stableOps();
  let opened = false;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  ops.openRead = () => {
    opened = true;
    throw new Error("missing leaf must not be opened");
  };

  assert.equal(
    readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    undefined
  );
  assert.equal(opened, false);
});

test("readStableOptionalRegularFile rejects a non-ENOENT leaf inspection failure", () => {
  const ops = stableOps();
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated access failure"), { code: "EACCES" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile classifies an ancestor changed after a missing-leaf probe", () => {
  const ops = stableOps();
  let ancestorReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      ancestorReads += 1;
      return ancestorReads === 1 ? directory() : directory({ ctimeNs: 2n });
    }
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileAncestorChangedError
  );
});

test("readStableOptionalRegularFile applies descriptor-bound admission to a present leaf", () => {
  assert.deepEqual(
    readStableOptionalRegularFile(recordPath, [stateDirectory], stableOps()),
    body
  );
});

test("readStableOptionalRegularFile rejects a noncanonical ancestor before treating its leaf as absent", () => {
  const ops = stableOps();
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  ops.realpath = (path) => path === stateDirectory ? "C:\\redirected\\.cu" : path;

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile treats a leaf removed after presence sampling as uncertain", () => {
  const ops = stableOps();
  let recordReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      recordReads += 1;
      if (recordReads === 1) return stat();
      throw Object.assign(new Error("simulated removed leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile rejects an ancestor removed after a missing-leaf probe", () => {
  const ops = stableOps();
  let ancestorReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      ancestorReads += 1;
      if (ancestorReads === 1) return directory();
      throw Object.assign(new Error("simulated removed ancestor"), { code: "ENOENT" });
    }
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile rejects a replaced ancestor after a missing-leaf probe", () => {
  const ops = stableOps();
  let ancestorReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      ancestorReads += 1;
      return ancestorReads === 1 ? directory() : directory({ ino: 2n, birthtimeNs: 2n });
    }
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile rejects a final ancestor realpath redirect after a missing-leaf probe", () => {
  const ops = stableOps();
  let stateRealpathReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };
  ops.realpath = (path) => {
    if (path !== stateDirectory) return path;
    stateRealpathReads += 1;
    return stateRealpathReads === 1 ? stateDirectory : "C:\\redirected\\.cu";
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableOptionalRegularFile rejects an outer ancestor changed in a direct multi-ancestor chain", () => {
  const ops = stableOps();
  let workspaceReads = 0;
  ops.lstat = (path) => {
    if (path === workspaceDirectory) {
      workspaceReads += 1;
      return workspaceReads === 1 ? directory() : directory({ ctimeNs: 2n });
    }
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      throw Object.assign(new Error("simulated missing leaf"), { code: "ENOENT" });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableOptionalRegularFile(recordPath, [workspaceDirectory, stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile returns descriptor-bound bytes after all snapshots agree", () => {
  assert.deepEqual(
    readStableRegularFile(recordPath, [stateDirectory], stableOps()),
    body
  );
});

test("readStableRegularFile rejects an identity mismatch at open", () => {
  const ops = stableOps();
  let closed = false;
  ops.fstat = () => stat({ ino: 2n });
  ops.close = () => {
    closed = true;
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
  assert.equal(closed, true);
});

test("readStableRegularFile rejects a record larger than the fixed byte ceiling", () => {
  const ops = stableOps();
  let opened = false;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) return stat({ size: BigInt(MAX_CONTROL_RECORD_BYTES + 1) });
    throw new Error(`unexpected lstat: ${path}`);
  };
  ops.openRead = () => {
    opened = true;
    return 41;
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
  assert.equal(opened, false);
});

test("readStableRegularFile rejects size changes while reading", () => {
  const ops = stableOps();
  let fstatCalls = 0;
  ops.fstat = () => {
    fstatCalls += 1;
    return fstatCalls === 1 ? stat() : stat({ size: BigInt(body.length + 1) });
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile rejects a record shrink while reading", () => {
  const ops = stableOps();
  let fstatCalls = 0;
  ops.fstat = () => {
    fstatCalls += 1;
    return fstatCalls === 1 ? stat() : stat({ size: BigInt(body.length - 1) });
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile rejects descriptor metadata mutation while reading", () => {
  const ops = stableOps();
  let fstatCalls = 0;
  ops.fstat = () => {
    fstatCalls += 1;
    return fstatCalls === 1 ? stat() : stat({ mtimeNs: 2n });
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile rejects a final pathname identity change", () => {
  const ops = stableOps();
  let recordReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) return directory();
    if (path === recordPath) {
      recordReads += 1;
      return recordReads === 1 ? stat() : stat({ ino: 2n });
    }
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile rejects a non-canonical ancestor", () => {
  const ops = stableOps();
  ops.realpath = (path) => path === stateDirectory ? "C:\\redirected\\.cu" : path;

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});

test("readStableRegularFile rejects a changed ancestor snapshot", () => {
  const ops = stableOps();
  let ancestorReads = 0;
  ops.lstat = (path) => {
    if (path === stateDirectory) {
      ancestorReads += 1;
      return ancestorReads === 1 ? directory() : directory({ ctimeNs: 2n });
    }
    if (path === recordPath) return stat();
    throw new Error(`unexpected lstat: ${path}`);
  };

  assert.throws(
    () => readStableRegularFile(recordPath, [stateDirectory], ops),
    RegularFileError
  );
});
