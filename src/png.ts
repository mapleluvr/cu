import { createHash } from "node:crypto";
import { createInflate } from "node:zlib";

export class PngValidationError extends Error {}

export type ValidatedPng = Readonly<{
  width: number;
  height: number;
  sha256: string;
  byteLength: number;
}>;

type ParsedPng = {
  width: number;
  height: number;
  channels: number;
  compressedBytes: Buffer;
};

const MAX_PNG_BYTES = 67_108_864;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
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
const validatedBytes = new WeakMap<ValidatedPng, Buffer>();

function fail(): never {
  throw new PngValidationError();
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function crc32Chunk(bytes: Buffer, typeOffset: number, dataOffset: number, dataEnd: number): number {
  let current = 0xffffffff;
  for (let offset = typeOffset; offset < dataOffset; offset += 1) {
    current = CRC_TABLE[(current ^ bytes[offset]!) & 0xff]! ^ (current >>> 8);
  }
  for (let offset = dataOffset; offset < dataEnd; offset += 1) {
    current = CRC_TABLE[(current ^ bytes[offset]!) & 0xff]! ^ (current >>> 8);
  }
  return (current ^ 0xffffffff) >>> 0;
}

function collectCompressedBytes(bytes: Buffer, compressedLength: number): Buffer {
  const compressed = Buffer.allocUnsafe(compressedLength);
  let sourceOffset = PNG_SIGNATURE.length;
  let destinationOffset = 0;
  while (sourceOffset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(sourceOffset);
    const typeOffset = sourceOffset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const type = bytes.readUInt32BE(typeOffset);
    if (type === IDAT) {
      bytes.copy(compressed, destinationOffset, dataOffset, dataEnd);
      destinationOffset += length;
    }
    sourceOffset = dataEnd + 4;
    if (type === IEND) {
      break;
    }
  }
  if (destinationOffset !== compressedLength) {
    fail();
  }
  return compressed;
}

function parsePng(bytes: Buffer): ParsedPng {
  if (bytes.length < PNG_SIGNATURE.length) {
    fail();
  }
  for (let offset = 0; offset < PNG_SIGNATURE.length; offset += 1) {
    if (bytes[offset] !== PNG_SIGNATURE[offset]) {
      fail();
    }
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  let compressedLength = 0;

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const endOffset = dataEnd + 4;
    if (endOffset > bytes.length) {
      fail();
    }
    const firstTypeByte = bytes[typeOffset]!;
    const secondTypeByte = bytes[typeOffset + 1]!;
    const thirdTypeByte = bytes[typeOffset + 2]!;
    const fourthTypeByte = bytes[typeOffset + 3]!;
    if (
      !isAsciiLetter(firstTypeByte) ||
      !isAsciiLetter(secondTypeByte) ||
      thirdTypeByte < 0x41 ||
      thirdTypeByte > 0x5a ||
      !isAsciiLetter(fourthTypeByte)
    ) {
      fail();
    }
    const type = bytes.readUInt32BE(typeOffset);
    if (crc32Chunk(bytes, typeOffset, dataOffset, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      fail();
    }
    offset = endOffset;

    if (!sawIhdr && type !== IHDR) {
      fail();
    }
    if (type === IHDR) {
      if (sawIhdr || length !== 13) {
        fail();
      }
      width = bytes.readUInt32BE(dataOffset);
      height = bytes.readUInt32BE(dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      if (
        width < 1 ||
        width > 32_768 ||
        height < 1 ||
        height > 32_768 ||
        bitDepth !== 8 ||
        (colorType !== 2 && colorType !== 6) ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] !== 0
      ) {
        fail();
      }
      channels = colorType === 6 ? 4 : 3;
      sawIhdr = true;
    } else if (type === PLTE) {
      if (sawPlte || sawIdat || length < 3 || length > 768 || length % 3 !== 0) {
        fail();
      }
      sawPlte = true;
    } else if (type === IDAT) {
      if (idatEnded) {
        fail();
      }
      sawIdat = true;
      compressedLength += length;
    } else if (type === IEND) {
      if (!sawIdat || length !== 0) {
        fail();
      }
      sawIend = true;
      break;
    } else {
      if ((firstTypeByte & 0x20) === 0) {
        fail();
      }
      if (sawIdat) {
        idatEnded = true;
      }
    }
  }

  if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) {
    fail();
  }
  return {
    width,
    height,
    channels,
    compressedBytes: collectCompressedBytes(bytes, compressedLength)
  };
}

function validateScanlines(parsed: ParsedPng): Promise<void> {
  return new Promise((resolve, reject) => {
    const rowLength = parsed.width * parsed.channels + 1;
    const expectedLength = rowLength * parsed.height;
    const inflater = createInflate();
    let inflatedLength = 0;
    let positionInRow = 0;
    let settled = false;

    const rejectOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      inflater.destroy();
      reject(new PngValidationError());
    };

    inflater.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (inflatedLength >= expectedLength) {
          rejectOnce();
          return;
        }
        if (positionInRow === 0) {
          const filter = chunk[offset];
          if (filter === undefined || filter > 4) {
            rejectOnce();
            return;
          }
          offset += 1;
          inflatedLength += 1;
          positionInRow = 1;
          continue;
        }
        const take = Math.min(rowLength - positionInRow, chunk.length - offset);
        offset += take;
        inflatedLength += take;
        positionInRow = (positionInRow + take) % rowLength;
      }
    });
    inflater.on("error", rejectOnce);
    inflater.on("end", () => {
      if (settled) {
        return;
      }
      if (
        inflatedLength !== expectedLength ||
        positionInRow !== 0 ||
        inflater.bytesWritten !== parsed.compressedBytes.length
      ) {
        rejectOnce();
        return;
      }
      settled = true;
      resolve();
    });

    inflater.end(parsed.compressedBytes);
  });
}

export async function validatePngBytes(input: Buffer): Promise<ValidatedPng> {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > MAX_PNG_BYTES) {
    fail();
  }
  const bytes = Buffer.from(input);
  try {
    const parsed = parsePng(bytes);
    await validateScanlines(parsed);
    const validated = Object.freeze({
      width: parsed.width,
      height: parsed.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length
    });
    validatedBytes.set(validated, bytes);
    return validated;
  } catch {
    fail();
  }
}

export function copyValidatedPngBytes(validated: ValidatedPng): Buffer {
  const bytes = validatedBytes.get(validated);
  if (bytes === undefined) {
    fail();
  }
  return Buffer.from(bytes);
}
