import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { isAdmittedActionPlan } from "../src/action-file.js";
import { ActionInputError, readActionInput } from "../src/action-input.js";

function validBytes(observationId = "obs_example"): Buffer {
  return Buffer.from(
    JSON.stringify({
      kind: "cu.action/v1",
      observationId,
      coordinateSpace: "normalized_999_top_left",
      actions: [{ kind: "click", at: { x: 500, y: 500 } }]
    }),
    "utf8"
  );
}

async function expectFailure(
  operation: () => Promise<unknown>,
  code: ActionInputError["code"]
): Promise<void> {
  let actual: unknown;
  try {
    await operation();
  } catch (error) {
    actual = error;
  }
  assert.ok(actual instanceof ActionInputError);
  assert.equal(actual.message, "");
  assert.equal(actual.code, code);
}

test("admits one stable regular action file and one bounded raw stdin document", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cu-action-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actionPath = join(root, "action.json");
  const bytes = validBytes();
  writeFileSync(actionPath, bytes);

  const fromFile = await readActionInput("action.json", root);
  const fromStdin = await readActionInput("-", root, Readable.from([
    bytes.subarray(0, 17),
    bytes.subarray(17)
  ]));

  assert.equal(isAdmittedActionPlan(fromFile), true);
  assert.equal(isAdmittedActionPlan(fromStdin), true);
  assert.deepEqual(fromFile, fromStdin);
  assert.equal(Object.isFrozen(fromFile), true);
});

test("preserves strict action admission codes without exposing typed text", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cu-action-input-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = "private-action-text";
  const malformed = Buffer.from(
    JSON.stringify({
      kind: "cu.action/v1",
      observationId: "obs_example",
      coordinateSpace: "normalized_999_top_left",
      actions: [{ kind: "type_text", text: secret }],
      unexpected: true
    }),
    "utf8"
  );
  writeFileSync(join(root, "bad.json"), malformed);

  await expectFailure(() => readActionInput("bad.json", root), "action_file_invalid");
  await expectFailure(
    () => readActionInput("-", root, Readable.from([malformed])),
    "action_file_invalid"
  );
});

test("rejects oversized file and stdin input at the byte ceiling", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cu-action-input-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oversized = Buffer.alloc(65_537, 0x20);
  writeFileSync(join(root, "large.json"), oversized);

  await expectFailure(() => readActionInput("large.json", root), "action_file_too_large");
  await expectFailure(
    () => readActionInput("-", root, Readable.from([oversized.subarray(0, 65_536), oversized.subarray(65_536)])),
    "action_file_too_large"
  );
});

test("rejects missing, non-regular, and linked action paths content-free", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cu-action-input-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "directory"));
  const realPath = join(root, "real.json");
  writeFileSync(realPath, validBytes());

  await expectFailure(() => readActionInput("missing.json", root), "action_file_invalid");
  await expectFailure(() => readActionInput("directory", root), "action_file_invalid");

  const linkPath = join(root, "linked.json");
  try {
    symlinkSync(realPath, linkPath, "file");
  } catch (error) {
    if (
      process.platform === "win32" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code?: unknown }).code === "EPERM" ||
        (error as { code?: unknown }).code === "EACCES")
    ) {
      return;
    }
    throw error;
  }
  await expectFailure(() => readActionInput("linked.json", root), "action_file_invalid");
});

test("rejects non-byte and failing stdin streams content-free", async () => {
  await expectFailure(
    () => readActionInput("-", process.cwd(), Readable.from(["{}"])),
    "action_file_invalid"
  );
  const failing = Readable.from((async function* () {
    yield Buffer.from("{");
    throw new Error("private-stream-failure");
  })());
  await expectFailure(
    () => readActionInput("-", process.cwd(), failing),
    "action_file_invalid"
  );
});
