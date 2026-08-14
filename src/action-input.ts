import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { admitActionBytes, type NormalizedActionPlan } from "./action-file.js";
import { readStableRegularFile } from "./regular-file.js";

const MAX_ACTION_INPUT_BYTES = 65_536;

export type ActionInputFailureCode =
  | "action_file_invalid"
  | "action_file_too_large"
  | "action_limit_exceeded"
  | "action_unbalanced"
  | "action_prohibited";

export class ActionInputError extends Error {
  public constructor(public readonly code: ActionInputFailureCode) {
    super("");
  }
}

type ByteInput = AsyncIterable<unknown>;

function fail(code: ActionInputFailureCode): never {
  throw new ActionInputError(code);
}

async function readBoundedStdin(input: ByteInput): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const value of input) {
      if (!(value instanceof Uint8Array)) fail("action_file_invalid");
      const chunk = Buffer.from(value);
      if (chunk.length > MAX_ACTION_INPUT_BYTES - total) {
        fail("action_file_too_large");
      }
      chunks.push(chunk);
      total += chunk.length;
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ActionInputError) throw error;
    fail("action_file_invalid");
  }
}

function readBoundedRegularFile(source: string, cwd: string): Buffer {
  const requestedPath = resolve(cwd, source);
  try {
    const canonicalParent = realpathSync.native(dirname(requestedPath));
    const actionPath = join(canonicalParent, basename(requestedPath));
    const initial = lstatSync(actionPath);
    if (initial.isFile() && !initial.isSymbolicLink() && initial.size > MAX_ACTION_INPUT_BYTES) {
      fail("action_file_too_large");
    }
    return readStableRegularFile(actionPath, [dirname(actionPath)]);
  } catch (error) {
    if (error instanceof ActionInputError) throw error;
    fail("action_file_invalid");
  }
}

export async function readActionInput(
  source: string,
  cwd: string,
  stdin: ByteInput = process.stdin
): Promise<NormalizedActionPlan> {
  if (typeof source !== "string" || source.length === 0 || typeof cwd !== "string") {
    fail("action_file_invalid");
  }
  const bytes = source === "-"
    ? await readBoundedStdin(stdin)
    : readBoundedRegularFile(source, cwd);
  const admitted = admitActionBytes(bytes);
  if (!admitted.ok) fail(admitted.error.code);
  return admitted.plan;
}
