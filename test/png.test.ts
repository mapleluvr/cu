import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  copyValidatedPngBytes,
  PngValidationError,
  type ValidatedPng,
  validatePngBytes
} from "../src/png.js";

const MAX_PNG_BYTES = 67_108_864;
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

function encodePng(options: {
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  compression?: number;
  filterMethod?: number;
  interlace?: number;
  filters?: number[];
} = {}): Buffer {
  const width = options.width ?? 2;
  const height = options.height ?? 1;
  const colorType = options.colorType ?? 2;
  const channels = colorType === 6 ? 4 : 3;
  const filters = options.filters ?? Array.from({ length: height }, () => 0);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = colorType;
  ihdr[10] = options.compression ?? 0;
  ihdr[11] = options.filterMethod ?? 0;
  ihdr[12] = options.interlace ?? 0;
  const rows: Buffer[] = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(Buffer.from([filters[row] ?? 0]));
    rows.push(Buffer.alloc(width * channels, row + 1));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function splitChunks(bytes: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    chunks.push(Buffer.from(bytes.subarray(offset, end)));
    offset = end;
  }
  return chunks;
}

function assemblePng(chunks: readonly Buffer[], trailing = Buffer.alloc(0)): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...chunks, trailing]);
}

function chunkData(encodedChunk: Buffer): Buffer {
  const length = encodedChunk.readUInt32BE(0);
  return Buffer.from(encodedChunk.subarray(8, 8 + length));
}

function encodeFragmentedPng(fragmentCount: number): Buffer {
  const [ihdr, idat, iend] = splitChunks(encodePng({ width: 1, height: 1 }));
  assert.ok(ihdr && idat && iend);
  const emptyIdat = chunk("IDAT", Buffer.alloc(0));
  const output = Buffer.allocUnsafe(
    PNG_SIGNATURE.length + ihdr.length + emptyIdat.length * fragmentCount + idat.length + iend.length
  );
  let offset = 0;
  for (const part of [PNG_SIGNATURE, ihdr]) {
    part.copy(output, offset);
    offset += part.length;
  }
  for (let index = 0; index < fragmentCount; index += 1) {
    emptyIdat.copy(output, offset);
    offset += emptyIdat.length;
  }
  for (const part of [idat, iend]) {
    part.copy(output, offset);
    offset += part.length;
  }
  assert.equal(offset, output.length);
  return output;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function capturePngError(pending: Promise<unknown>): Promise<PngValidationError> {
  try {
    await pending;
  } catch (error) {
    assert.equal(error instanceof PngValidationError, true);
    return error as PngValidationError;
  }
  assert.fail("expected PNG validation to fail");
}

test("admits one complete PNG into an owned opaque byte capability", async () => {
  const input = encodePng();
  const admittedBytes = Buffer.from(input);

  const pending = validatePngBytes(input);
  input.fill(0);
  const validated = await pending;

  assert.deepEqual(validated, {
    width: 2,
    height: 1,
    sha256: sha256(admittedBytes),
    byteLength: admittedBytes.length
  });
  assert.equal(Object.isFrozen(validated), true);

  const firstCopy = copyValidatedPngBytes(validated);
  assert.deepEqual(firstCopy, admittedBytes);
  firstCopy.fill(0);
  assert.deepEqual(copyValidatedPngBytes(validated), admittedBytes);
});

test("rejects an invalid PNG signature without disclosing parser details", async () => {
  const invalid = encodePng();
  invalid[0] = 0;

  const error = await capturePngError(validatePngBytes(invalid));

  assert.equal(error.message, "");
});

test("rejects encoded PNG bytes above the 64 MiB ceiling before decoding", async () => {
  const valid = encodePng();
  const oversized = Buffer.alloc(MAX_PNG_BYTES + 1);
  valid.copy(oversized);

  const error = await capturePngError(validatePngBytes(oversized));

  assert.equal(error.message, "");
});

test("rejects a PNG chunk whose CRC does not match its type and data", async () => {
  const invalid = encodePng();
  const ihdrCrcOffset = PNG_SIGNATURE.length + 4 + 4 + 13;
  invalid[ihdrCrcOffset] ^= 0xff;

  const error = await capturePngError(validatePngBytes(invalid));

  assert.equal(error.message, "");
});

test("enforces exact PNG container type and terminal chunk grammar", async () => {
  const [ihdr, idat, iend] = splitChunks(encodePng());
  assert.ok(ihdr && idat && iend);
  const invalidCandidates = [
    assemblePng([chunk("tEXt", Buffer.from("x")), ihdr, idat, iend]),
    assemblePng([ihdr, ihdr, idat, iend]),
    assemblePng([ihdr, idat]),
    assemblePng([ihdr, idat, iend], Buffer.from([0])),
    assemblePng([ihdr, chunk("ABCD", Buffer.alloc(0)), idat, iend]),
    assemblePng([ihdr, chunk("ab1d", Buffer.alloc(0)), idat, iend]),
    assemblePng([ihdr, chunk("abcd", Buffer.alloc(0)), idat, iend])
  ];

  for (const candidate of invalidCandidates) {
    const error = await capturePngError(validatePngBytes(candidate));
    assert.equal(error.message, "");
  }
});

test("admits only bounded noninterlaced 8-bit RGB or RGBA IHDR fields", async () => {
  const invalidCandidates = [
    encodePng({ width: 0 }),
    encodePng({ height: 0 }),
    encodePng({ width: 32_769 }),
    encodePng({ width: 1, height: 32_769 }),
    encodePng({ bitDepth: 16 }),
    encodePng({ colorType: 0 }),
    encodePng({ compression: 1 }),
    encodePng({ filterMethod: 1 }),
    encodePng({ interlace: 1 })
  ];

  for (const candidate of invalidCandidates) {
    const error = await capturePngError(validatePngBytes(candidate));
    assert.equal(error.message, "");
  }
});

test("enforces optional PLTE grammar and consecutive IDAT chunks", async () => {
  const [ihdr, idat, iend] = splitChunks(encodePng());
  assert.ok(ihdr && idat && iend);
  const compressed = chunkData(idat);
  const splitAt = Math.max(1, Math.floor(compressed.length / 2));
  const firstIdat = chunk("IDAT", compressed.subarray(0, splitAt));
  const secondIdat = chunk("IDAT", compressed.subarray(splitAt));
  const validPalette = chunk("PLTE", Buffer.from([0, 0, 0]));

  await assert.doesNotReject(validatePngBytes(assemblePng([ihdr, validPalette, idat, iend])));
  await assert.doesNotReject(validatePngBytes(assemblePng([ihdr, firstIdat, secondIdat, iend])));

  const invalidCandidates = [
    assemblePng([ihdr, chunk("PLTE", Buffer.alloc(0)), idat, iend]),
    assemblePng([ihdr, chunk("PLTE", Buffer.alloc(2)), idat, iend]),
    assemblePng([ihdr, chunk("PLTE", Buffer.alloc(769)), idat, iend]),
    assemblePng([ihdr, validPalette, validPalette, idat, iend]),
    assemblePng([ihdr, idat, validPalette, iend]),
    assemblePng([
      ihdr,
      firstIdat,
      chunk("tEXt", Buffer.from("separator")),
      secondIdat,
      iend
    ])
  ];

  for (const candidate of invalidCandidates) {
    const error = await capturePngError(validatePngBytes(candidate));
    assert.equal(error.message, "");
  }
});

test("streams exact RGB and RGBA scanlines with only PNG filters zero through four", async () => {
  for (const colorType of [2, 6] as const) {
    const valid = encodePng({
      width: 3,
      height: 5,
      colorType,
      filters: [0, 1, 2, 3, 4]
    });
    const admitted = await validatePngBytes(valid);
    assert.equal(admitted.width, 3);
    assert.equal(admitted.height, 5);
  }

  for (const filter of [5, 255]) {
    const error = await capturePngError(
      validatePngBytes(encodePng({ filters: [filter] }))
    );
    assert.equal(error.message, "");
  }
});

test("rejects unconsumed bytes after the exact zlib datastream", async () => {
  const [ihdr, idat, iend] = splitChunks(encodePng());
  assert.ok(ihdr && idat && iend);
  const invalidIdat = chunk(
    "IDAT",
    Buffer.concat([chunkData(idat), Buffer.from([1, 2, 3])])
  );

  const error = await capturePngError(
    validatePngBytes(assemblePng([ihdr, invalidIdat, iend]))
  );

  assert.equal(error.message, "");
});

test("contains invalid runtime input and rejects forged PNG capabilities", async () => {
  for (const candidate of [null, new Uint8Array(encodePng())]) {
    const error = await capturePngError(
      validatePngBytes(candidate as unknown as Buffer)
    );
    assert.equal(error.message, "");
  }

  const forged = Object.freeze({
    width: 2,
    height: 1,
    sha256: "0".repeat(64),
    byteLength: 1
  }) as ValidatedPng;
  assert.throws(
    () => copyValidatedPngBytes(forged),
    (error: unknown) => error instanceof PngValidationError && error.message === ""
  );
});

test("contains malformed compression, scanline lengths, and chunk truncation", async () => {
  const [ihdr, idat, iend] = splitChunks(encodePng());
  assert.ok(ihdr && idat && iend);
  const compressed = chunkData(idat);
  const invalidCandidates = [
    assemblePng([ihdr, chunk("IDAT", Buffer.from("not-zlib")), iend]),
    assemblePng([ihdr, chunk("IDAT", compressed.subarray(0, -1)), iend]),
    assemblePng([ihdr, chunk("IDAT", deflateSync(Buffer.alloc(6))), iend]),
    assemblePng([ihdr, chunk("IDAT", deflateSync(Buffer.alloc(8))), iend]),
    Buffer.from(encodePng().subarray(0, -1))
  ];

  for (const candidate of invalidCandidates) {
    const error = await capturePngError(validatePngBytes(candidate));
    assert.equal(error.message, "");
  }
});

test("enforces exact critical lengths and declared chunk bounds", async () => {
  const [ihdr, idat, iend] = splitChunks(encodePng());
  assert.ok(ihdr && idat && iend);
  const oversizedClaim = Buffer.from(idat);
  oversizedClaim.writeUInt32BE(0xffffffff, 0);
  const invalidCandidates = [
    assemblePng([chunk("IHDR", Buffer.alloc(12)), idat, iend]),
    assemblePng([ihdr, idat, chunk("IEND", Buffer.from([0]))]),
    assemblePng([ihdr, iend]),
    assemblePng([ihdr, oversizedClaim, iend])
  ];

  await assert.doesNotReject(
    validatePngBytes(
      assemblePng([ihdr, idat, chunk("tEXt", Buffer.from("after")), iend])
    )
  );
  for (const candidate of invalidCandidates) {
    const error = await capturePngError(validatePngBytes(candidate));
    assert.equal(error.message, "");
  }
});

test("does not retain or allocate one Buffer view per fragmented IDAT chunk", async () => {
  const candidate = encodeFragmentedPng(10_000);
  const originalFrom = Buffer.from;
  const originalSubarray = Buffer.prototype.subarray;
  let fromCalls = 0;
  let subarrayCalls = 0;
  Object.defineProperty(Buffer, "from", {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      fromCalls += 1;
      return Reflect.apply(originalFrom, Buffer, args);
    }
  });
  Object.defineProperty(Buffer.prototype, "subarray", {
    configurable: true,
    writable: true,
    value: function (...args: unknown[]) {
      subarrayCalls += 1;
      return Reflect.apply(originalSubarray, this, args);
    }
  });

  try {
    const admitted = await validatePngBytes(candidate);
    assert.equal(admitted.width, 1);
    assert.equal(admitted.height, 1);
  } finally {
    Object.defineProperty(Buffer, "from", {
      configurable: true,
      writable: true,
      value: originalFrom
    });
    Object.defineProperty(Buffer.prototype, "subarray", {
      configurable: true,
      writable: true,
      value: originalSubarray
    });
  }

  assert.equal(fromCalls, 1);
  assert.ok(subarrayCalls <= 1, `unexpected Buffer views: ${subarrayCalls}`);
});
