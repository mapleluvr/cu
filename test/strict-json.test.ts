import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStrictJsonBytes,
  StrictJsonParseError
} from "../src/strict-json.js";

const options = { maxBytes: 64, maxDepth: 4 };

function parse(bytes: Uint8Array) {
  return parseStrictJsonBytes(bytes, options);
}

test("parses one strict JSON document into null-prototype objects", () => {
  const value = parse(Buffer.from('{"nested":{"items":[true,null,3]}}', "utf8"));

  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(value, Object.assign(Object.create(null), {
    nested: Object.assign(Object.create(null), { items: [true, null, 3] })
  }));
});

test("enforces exact byte and structural caps", () => {
  const exactByteCap = Buffer.from(`{"value":"${"x".repeat(52)}"}`, "utf8");
  const exactDepthCap = Buffer.from("[[[[0]]]]", "utf8");

  assert.equal(exactByteCap.byteLength, 64);
  assert.doesNotThrow(() => parse(exactByteCap));
  assert.doesNotThrow(() => parseStrictJsonBytes(exactDepthCap, { maxBytes: 64, maxDepth: 4 }));
  assert.throws(
    () => parseStrictJsonBytes(Buffer.from("[[[]]]", "utf8"), { maxBytes: 64, maxDepth: 2 }),
    StrictJsonParseError
  );
});

test("rejects malformed strict JSON transport before caller admission", () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]);
  const duplicateDecodedKey = Buffer.from('{"items":[{"a":1,"\\u0061":2}]}', "utf8");
  const trailing = Buffer.from("{}x", "utf8");
  const oversized = Buffer.alloc(65, 0x20);

  for (const bytes of [Buffer.from([0xff]), bom, duplicateDecodedKey, trailing, oversized]) {
    assert.throws(() => parse(bytes), StrictJsonParseError);
  }
});

test("rejects invalid runtime resource caps", () => {
  for (const options of [
    { maxBytes: Number.NaN, maxDepth: 4 },
    { maxBytes: 64, maxDepth: Number.NaN },
    { maxBytes: Number.POSITIVE_INFINITY, maxDepth: 4 },
    { maxBytes: 64, maxDepth: 1.5 },
    { maxBytes: -1, maxDepth: 4 },
    { maxBytes: 64, maxDepth: -1 }
  ]) {
    assert.throws(
      () => parseStrictJsonBytes(Buffer.from("{}", "utf8"), options),
      StrictJsonParseError
    );
  }
});
