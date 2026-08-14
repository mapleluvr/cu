import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAllObservations,
  clearRangeObservations
} from "../src/archive-cleanup.js";

test("archive cleanup exports the held-lock clear operations", () => {
  assert.equal(typeof clearRangeObservations, "function");
  assert.equal(typeof clearAllObservations, "function");
});
