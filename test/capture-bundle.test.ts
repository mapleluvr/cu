import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  CaptureBundleError,
  copyValidatedCaptureBundleBytes,
  type ValidatedCaptureBundle,
  validateCaptureBundleBytes
} from "../src/capture-bundle.js";

const binding = {
  runId: "work-a",
  workspaceFingerprint: "a".repeat(64)
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let current = 0xffffffff;
  for (const byte of bytes) {
    current = CRC_TABLE[(current ^ byte) & 0xff]! ^ (current >>> 8);
  }
  return (current ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function pngBytes(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3]))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureMetadata(image: Buffer): Record<string, unknown> {
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
      widthPx: 1,
      heightPx: 1
    },
    environmentFingerprint: "b".repeat(64),
    topologyFingerprint: "c".repeat(64),
    image: {
      mediaType: "image/png",
      sha256: sha256(image),
      byteLength: image.length,
      width: 1,
      height: 1
    }
  };
}

function metadataBytes(image: Buffer): Buffer {
  return Buffer.from(JSON.stringify(captureMetadata(image)), "utf8");
}

async function captureBundleError(pending: Promise<unknown>): Promise<CaptureBundleError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof CaptureBundleError) {
      return error;
    }
    throw error;
  }
  assert.fail("expected CaptureBundleError");
}

test("admits exact sidecar and PNG bytes into one owned opaque capture bundle", async () => {
  const image = pngBytes();
  const metadata = metadataBytes(image);
  const admittedImage = Buffer.from(image);
  const admittedMetadata = Buffer.from(metadata);

  const pending = validateCaptureBundleBytes(metadata, image, binding);
  metadata.fill(0);
  image.fill(0);
  const bundle = await pending;

  assert.equal(bundle.capture.observationId, "obs_0123456789abcdef0123456789abcdef");
  assert.equal(bundle.captureMetadataSha256, sha256(admittedMetadata));
  assert.deepEqual(bundle.capture.image, captureMetadata(admittedImage).image);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.capture), true);
  assert.equal(Object.isFrozen(bundle.capture.source), true);
  assert.equal(Object.isFrozen(bundle.capture.image), true);

  const first = copyValidatedCaptureBundleBytes(bundle);
  assert.deepEqual(first.captureMetadata, admittedMetadata);
  assert.deepEqual(first.image, admittedImage);
  first.captureMetadata.fill(0);
  first.image.fill(0);
  const second = copyValidatedCaptureBundleBytes(bundle);
  assert.deepEqual(second.captureMetadata, admittedMetadata);
  assert.deepEqual(second.image, admittedImage);
});

test("binds the metadata digest and copy to exact admitted sidecar bytes", async () => {
  const image = pngBytes();
  const metadata = Buffer.concat([
    Buffer.from(" \r\n", "utf8"),
    metadataBytes(image),
    Buffer.from("\n", "utf8")
  ]);

  const bundle = await validateCaptureBundleBytes(metadata, image, binding);

  assert.equal(bundle.captureMetadataSha256, sha256(metadata));
  assert.deepEqual(copyValidatedCaptureBundleBytes(bundle).captureMetadata, metadata);
});

for (const [field, value] of [
  ["sha256", "e".repeat(64)],
  ["byteLength", 1],
  ["width", 2],
  ["height", 2]
] as const) {
  test(`rejects a sidecar whose image ${field} does not match the PNG`, async () => {
    const image = pngBytes();
    const metadata = captureMetadata(image);
    metadata.image = {
      ...(metadata.image as Record<string, unknown>),
      [field]: value
    };

    const error = await captureBundleError(validateCaptureBundleBytes(
      Buffer.from(JSON.stringify(metadata), "utf8"),
      image,
      binding
    ));

    assert.equal(error.message, "");
  });
}

test("contains malformed sidecar transport as a content-free bundle error", async () => {
  const error = await captureBundleError(validateCaptureBundleBytes(
    Buffer.from('{"private":"secret"', "utf8"),
    pngBytes(),
    binding
  ));

  assert.equal(error.message, "");
  assert.doesNotMatch(error.message, /secret/);
});

test("contains invalid PNG transport as a content-free bundle error", async () => {
  const validImage = pngBytes();
  const error = await captureBundleError(validateCaptureBundleBytes(
    metadataBytes(validImage),
    Buffer.from("not-png"),
    binding
  ));

  assert.equal(error.message, "");
});

test("contains foreign and malformed runtime bundle inputs", async () => {
  const image = pngBytes();
  const metadata = metadataBytes(image);
  const operations = [
    () => validateCaptureBundleBytes(metadata, image, {
      ...binding,
      workspaceFingerprint: "e".repeat(64)
    }),
    () => validateCaptureBundleBytes(null as unknown as Buffer, image, binding),
    () => validateCaptureBundleBytes(metadata, null as unknown as Buffer, binding),
    () => validateCaptureBundleBytes(
      metadata,
      new Uint8Array(image) as unknown as Buffer,
      binding
    )
  ];

  for (const operation of operations) {
    const error = await captureBundleError(operation());
    assert.equal(error.message, "");
  }
});

test("rejects a forged capture-bundle capability without disclosure", () => {
  const image = pngBytes();
  const forged = Object.freeze({
    capture: captureMetadata(image),
    captureMetadataSha256: "e".repeat(64)
  }) as unknown as ValidatedCaptureBundle;

  assert.throws(
    () => copyValidatedCaptureBundleBytes(forged),
    (error: unknown) => error instanceof CaptureBundleError && error.message === ""
  );
});
