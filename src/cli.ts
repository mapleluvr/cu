#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  actRegion,
  ActBlockedError,
  ActIndeterminateError,
  ActInternalError,
  ActPartialError,
  type ActRegionResult
} from "./act.js";
import {
  ActionInputError,
  readActionInput
} from "./action-input.js";
import {
  ArchiveCleanupError,
  ArchiveCleanupPublicationUncertainError,
  clearAllObservations,
  clearRangeObservations
} from "./archive-cleanup.js";
import {
  ArchiveQueryBlockedError,
  ArchiveQueryEffectJournalInvalidError,
  ArchiveQueryError,
  inspectRunStatus,
  listRunHistory,
  listWorkspaceRuns,
  showRunHistory,
  type RunStatusResult,
  type WorkspaceRunSummary
} from "./archive-query.js";
import { type NormalizedActionPlan } from "./action-file.js";
import {
  bindRegionSelectorToDisplay,
  isDisplayId,
  type CaptureSelector,
  type DisplayInventory
} from "./display.js";
import { isRunId } from "./identifiers.js";
import {
  observeRegion,
  ObserveArchiveError,
  ObserveCaptureError,
  ObserveQuotaError,
  ObserveWorkspaceError
} from "./observe.js";
import { parseRegionSelector, type RegionSelector } from "./region.js";
import { queryWindowsDisplays, WindowsDisplayError } from "./windows-capture.js";
import { inspectRun, RunStateError } from "./run.js";
import { acquireRunLock, RunLockBusyError } from "./run-lock.js";
import { initializeWorkspace, inspectWorkspace } from "./workspace.js";

const helpEntries: Readonly<Record<string, string>> = Object.freeze({
  init: [
    "cu init [--json]",
    "Initialize or validate the workspace control record without desktop effects.",
    "JSON success: cu.init.result/v1"
  ].join("\n"),
  displays: [
    "cu displays [--json]",
    "List topology-bound display placements without capture or workspace state.",
    "JSON success: cu.displays.result/v1"
  ].join("\n"),
  observe: [
    "cu observe <run_id> [--region <normalized-or-pixel-rectangle>] [--display <display_id>] [--json]",
    "Capture and publish one validated observation for the current workspace run.",
    "--display requires --region and binds it to one topology-bound display placement.",
    "JSON success: cu.observe.result/v1"
  ].join("\n"),
  act: [
    "cu act <run_id> --action-file <path|-> [--json]",
    "Successful completed or checkpoint outcomes use cu.act.result/v1.",
    "Blocked, partial, or indeterminate outcomes use cu.error/v1 with exit 3, 4, or 5."
  ].join("\n"),
  "action-file": [
    "cu.action/v1 action file",
    "{",
    "  \"kind\": \"cu.action/v1\",",
    "  \"observationId\": \"obs_example\",",
    "  \"coordinateSpace\": \"normalized_999_top_left\",",
    "  \"actions\": [",
    "    { \"kind\": \"click\", \"at\": { \"x\": 500, \"y\": 500 } }",
    "  ]",
    "}",
    "The file is bounded, exact-key JSON and never persists type_text content in diagnostics."
  ].join("\n"),
  history: [
    "cu history <run_id> [list] [--json]",
    "cu history <run_id> show <observation_id> [--json]",
    "History is diagnosticOnly and cannot authorize act."
  ].join("\n"),
  status: [
    "cu status [run_id] [--json]",
    "Report safe workspace and run summaries through a read-only inspection."
  ].join("\n"),
  clear: [
    "cu clear <run_id> <time_end> [--json]",
    "cu clear <run_id> <time_start> <time_end> [--json]",
    "Two timestamps select start <= capturedAt < end using exact UTC RFC3339 values."
  ].join("\n"),
  clearall: [
    "cu clearall <run_id> [--json]",
    "Remove the complete proved archive transactionally while preserving run.json."
  ].join("\n")
});
const helpTopics = Object.freeze(Object.keys(helpEntries));

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeHelp(topic?: string): void {
  if (topic === undefined) {
    process.stdout.write(
      `cu commands: ${helpTopics.join(", ")}\nUse \"cu help <topic>\" for command syntax.\n`
    );
    return;
  }
  process.stdout.write(`${helpEntries[topic]}\n`);
}

function writeHumanDisplays(result: DisplayInventory): void {
  const lines = [
    `topology: ${result.topologyFingerprint}`,
    ...result.displays.map((display) => {
      const bounds = display.boundsPx;
      return `${display.displayId}${display.primary ? " primary" : ""} pixel:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    })
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeHumanWorkspaceStatus(
  initialized: boolean,
  runs: readonly WorkspaceRunSummary[]
): void {
  const lines = [
    `workspace: ${initialized ? "initialized" : "uninitialized"}`,
    `runs: ${runs.length}`,
    ...runs.map((run) => `${run.id}: ${run.lifecycle} (${run.profile})`)
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeHumanRunStatus(initialized: boolean, run: RunStatusResult): void {
  const lines = [
    `workspace: ${initialized ? "initialized" : "uninitialized"}`,
    `run: ${run.id}`
  ];
  if (!run.exists) {
    lines.push("state: unavailable");
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  const archive = run.archive;
  lines.push(
    `lifecycle: ${run.lifecycle ?? "unknown"}`,
    `profile: ${run.profile ?? "unknown"}`,
    `busy: ${run.busy === true ? "yes" : "no"}`,
    `archive: ${archive?.state ?? "unknown"}`,
    `retained bundles: ${archive?.retainedBundleCount ?? "unknown"}`,
    `committed bytes: ${archive?.committedBytes ?? "unknown"} / ${archive?.maxCommittedBytes ?? "unknown"}`,
    `historical bundle limit: ${archive?.maxHistoricalBundles ?? "unknown"}`,
    `current observation: ${run.currentObservation?.state ?? "unknown"}`,
    `effect: ${run.effect?.state ?? "unknown"}`,
    `unavailable history events: ${run.history?.unavailableEventCount ?? "unknown"}`
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

function writeError(json: boolean, code: string, message: string): void {
  if (json) {
    writeJson({ kind: "cu.error/v1", code, message, retryable: false });
  } else {
    process.stderr.write(`${message}\n`);
  }
}

type Invocation = {
  command: string;
  json: boolean;
  operands: readonly string[];
};

function parseInvocation(args: readonly string[]): Invocation | undefined {
  const json = args.filter((arg) => arg === "--json");
  const operands = args.filter((arg) => arg !== "--json");

  if (
    json.length > 1 ||
    operands.length === 0 ||
    operands.some((operand) => operand.startsWith("--"))
  ) {
    return undefined;
  }

  return { command: operands[0], json: json.length === 1, operands: operands.slice(1) };
}

type ActInvocation = Readonly<{
  runId: string;
  actionFile: string;
  json: boolean;
}>;

function parseActInvocation(args: readonly string[]): ActInvocation | undefined {
  let runId: string | undefined;
  let actionFile: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === "--action-file") {
      const value = args[index + 1];
      if (actionFile !== undefined || value === undefined || value.startsWith("--")) {
        return undefined;
      }
      actionFile = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--") || runId !== undefined || !isRunId(argument)) {
      return undefined;
    }
    runId = argument;
  }

  return runId === undefined || actionFile === undefined
    ? undefined
    : Object.freeze({ runId, actionFile, json });
}

export function createPublicActReceipt(
  runId: string,
  plan: NormalizedActionPlan,
  result: ActRegionResult
): Readonly<Record<string, unknown>> {
  const root = {
    kind: "cu.act.result/v1",
    runId,
    outcome: result.outcome,
    emittedActionCount: result.emittedActionCount,
    emittedLeafActionCount: result.emittedLeafActionCount,
    unexecutedActionCount: plan.actions.length - result.emittedActionCount
  };
  return Object.freeze(
    result.outcome === "checkpoint"
      ? { ...root, checkpoint: result.checkpoint }
      : root
  );
}

export type PublicActFailure = Readonly<{
  code: string;
  message: string;
  exitCode: 1 | 2 | 3 | 4 | 5;
}>;

const publicActMessages: Readonly<Record<string, string>> = Object.freeze({
  action_file_invalid: "Action file is invalid.",
  action_file_too_large: "Action file exceeds the byte limit.",
  action_limit_exceeded: "Action file exceeds an action limit.",
  action_unbalanced: "Action sequence is unbalanced.",
  action_prohibited: "Action file contains a prohibited action.",
  archive_recovery_required: "Observation archive requires recovery.",
  effect_journal_invalid: "Effect journal state is invalid.",
  effect_journal_unresolved: "An unresolved effect blocks this action.",
  input_unavailable: "Native input is unavailable in this environment.",
  observation_environment_changed: "Observation environment has changed.",
  observation_expired: "Observation has expired.",
  observation_invalid: "Observation state is invalid.",
  observation_unavailable: "No matching actionable observation is available.",
  run_busy: "Run is busy.",
  workspace_invalid: "Workspace state cannot be used safely.",
  input_unproven: "Native input may have been partially emitted.",
  checkpoint_capture_failed: "Checkpoint capture failed after input.",
  checkpoint_publish_failed: "Checkpoint publication failed after input.",
  cleanup_unproven: "Native input cleanup could not be proven.",
  helper_lost: "Native input helper completion could not be proven.",
  internal_error: "Act failed safely."
});

export function classifyPublicActFailure(error: unknown): PublicActFailure {
  let code = "internal_error";
  let exitCode: PublicActFailure["exitCode"] = 1;
  if (error instanceof ActionInputError) {
    code = error.code;
    exitCode = 2;
  } else if (error instanceof ActBlockedError) {
    code = error.code;
    exitCode = 3;
  } else if (error instanceof ActPartialError) {
    code = error.code;
    exitCode = 4;
  } else if (error instanceof ActIndeterminateError) {
    code = error.code;
    exitCode = 5;
  } else if (error instanceof ActInternalError) {
    code = error.code;
  }
  return Object.freeze({
    code,
    message: publicActMessages[code] ?? publicActMessages.internal_error!,
    exitCode
  });
}

type ObserveInvocation = Readonly<{
  runId: string;
  selector?: CaptureSelector;
  json: boolean;
}>;

function parseObserveInvocation(args: readonly string[]): ObserveInvocation | undefined {
  let runId: string | undefined;
  let selector: RegionSelector | undefined;
  let displayId: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === "--region") {
      const value = args[index + 1];
      if (selector !== undefined || value === undefined || value.startsWith("--")) {
        return undefined;
      }
      try {
        selector = parseRegionSelector(value);
      } catch {
        return undefined;
      }
      index += 1;
      continue;
    }
    if (argument === "--display") {
      const value = args[index + 1];
      if (
        displayId !== undefined ||
        value === undefined ||
        value.startsWith("--") ||
        !isDisplayId(value)
      ) {
        return undefined;
      }
      displayId = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--") || runId !== undefined || !isRunId(argument)) {
      return undefined;
    }
    runId = argument;
  }

  if (runId === undefined || (displayId !== undefined && selector === undefined)) {
    return undefined;
  }
  const captureSelector = selector === undefined
    ? undefined
    : displayId === undefined
      ? selector
      : bindRegionSelectorToDisplay(displayId, selector);
  return Object.freeze({ runId, selector: captureSelector, json });
}

type HistoryInvocation = Readonly<{
  runId: string;
  mode: "list" | "show";
  observationId?: string;
  json: boolean;
}>;

type ClearInvocation = Readonly<{
  runId: string;
  timeStart: string | null;
  timeEnd: string;
  json: boolean;
}>;

class PublicCommandError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: 1 | 3
  ) {
    super("");
  }
}

const publicCommandMessages: Readonly<Record<string, string>> = Object.freeze({
  archive_invalid: "Archive state is invalid.",
  archive_recovery_required: "Observation archive requires recovery.",
  effect_journal_invalid: "Effect journal state is invalid.",
  effect_journal_unresolved: "An unresolved effect blocks this command.",
  run_busy: "Run is busy.",
  run_invalid: "Run state cannot be inspected safely.",
  workspace_invalid: "Workspace state cannot be used safely."
});

function commandFailure(json: boolean, code: string, exitCode: 1 | 3): number {
  writeError(json, code, publicCommandMessages[code] ?? publicCommandMessages.archive_invalid!);
  return exitCode;
}

function parseJsonOperands(args: readonly string[]):
  { json: boolean; operands: readonly string[] } | undefined {
  let json = false;
  const operands: string[] = [];
  for (const argument of args) {
    if (argument === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument.startsWith("--")) return undefined;
    operands.push(argument);
  }
  return Object.freeze({ json, operands: Object.freeze(operands) });
}

function parseHistoryInvocation(args: readonly string[]): HistoryInvocation | undefined {
  const parsed = parseJsonOperands(args);
  if (parsed === undefined || parsed.operands.length < 1 || parsed.operands.length > 3) {
    return undefined;
  }
  const [runId, subcommand, observationId] = parsed.operands;
  if (!isRunId(runId!)) return undefined;
  if (subcommand === undefined || subcommand === "list") {
    return parsed.operands.length === 1 ||
      (parsed.operands.length === 2 && subcommand === "list")
      ? Object.freeze({ runId: runId!, mode: "list", json: parsed.json })
      : undefined;
  }
  if (
    subcommand !== "show" ||
    observationId === undefined ||
    parsed.operands.length !== 3 ||
    !/^obs_[a-f0-9]{32}$/.test(observationId)
  ) {
    return undefined;
  }
  return Object.freeze({ runId: runId!, mode: "show", observationId, json: parsed.json });
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseClearInvocation(
  args: readonly string[],
  clearAll: boolean
): ClearInvocation | undefined {
  const parsed = parseJsonOperands(args);
  if (parsed === undefined) return undefined;
  if (clearAll) {
    return parsed.operands.length === 1 && isRunId(parsed.operands[0]!)
      ? Object.freeze({
          runId: parsed.operands[0]!,
          timeStart: null,
          timeEnd: "",
          json: parsed.json
        })
      : undefined;
  }
  if (parsed.operands.length !== 2 && parsed.operands.length !== 3) return undefined;
  const runId = parsed.operands[0]!;
  const timeStart = parsed.operands.length === 3 ? parsed.operands[1]! : null;
  const timeEnd = parsed.operands[parsed.operands.length - 1]!;
  if (
    !isRunId(runId) ||
    !canonicalTimestamp(timeEnd) ||
    (timeStart !== null && (!canonicalTimestamp(timeStart) || timeStart >= timeEnd))
  ) {
    return undefined;
  }
  return Object.freeze({ runId, timeStart, timeEnd, json: parsed.json });
}

function mapArchiveQueryError(error: unknown): PublicCommandError {
  if (error instanceof ArchiveQueryEffectJournalInvalidError) {
    return new PublicCommandError("effect_journal_invalid", 1);
  }
  return error instanceof ArchiveQueryBlockedError
    ? new PublicCommandError("archive_recovery_required", 3)
    : new PublicCommandError("archive_invalid", 1);
}

function inspectAdmittedCommandRun(root: string, runId: string): void {
  try {
    const workspace = inspectWorkspace(root);
    if (!workspace.initialized) {
      throw new PublicCommandError("workspace_invalid", 1);
    }
    if (inspectRun(root, runId) === undefined) {
      throw new PublicCommandError("run_invalid", 1);
    }
  } catch (error) {
    if (error instanceof PublicCommandError) throw error;
    if (error instanceof RunStateError) {
      throw new PublicCommandError("run_invalid", 1);
    }
    throw new PublicCommandError("workspace_invalid", 1);
  }
}

function clearStatusFailure(
  status: Awaited<ReturnType<typeof inspectRunStatus>>,
  ignoreBusy: boolean
): PublicCommandError | undefined {
  if (status.busy && !ignoreBusy) {
    return new PublicCommandError("run_busy", 3);
  }
  if (status.archive?.state === "recovery_required" || status.effect?.state === "unknown") {
    return new PublicCommandError("archive_recovery_required", 3);
  }
  if (
    status.effect?.state === "intent" ||
    status.effect?.state === "partial" ||
    status.effect?.state === "indeterminate" ||
    status.currentObservation?.state === "consumed"
  ) {
    return new PublicCommandError("effect_journal_unresolved", 3);
  }
  return undefined;
}

async function inspectClearPreflight(root: string, runId: string): Promise<void> {
  inspectAdmittedCommandRun(root, runId);
  try {
    const failure = clearStatusFailure(await inspectRunStatus(root, runId), true);
    if (failure !== undefined) throw failure;
  } catch (error) {
    if (error instanceof PublicCommandError) throw error;
    throw mapArchiveQueryError(error);
  }
}

async function classifyCleanupError(
  error: unknown,
  root: string,
  runId: string
): Promise<PublicCommandError> {
  if (error instanceof PublicCommandError) return error;
  if (error instanceof ArchiveCleanupPublicationUncertainError) {
    return new PublicCommandError("archive_recovery_required", 3);
  }
  if (error instanceof ArchiveCleanupError) {
    try {
      const statusFailure = clearStatusFailure(await inspectRunStatus(root, runId), true);
      if (statusFailure !== undefined) return statusFailure;
    } catch (queryError) {
      return mapArchiveQueryError(queryError);
    }
  }
  return new PublicCommandError("archive_recovery_required", 3);
}

async function executeClear(
  root: string,
  invocation: ClearInvocation
): Promise<Readonly<Record<string, unknown>>> {
  inspectAdmittedCommandRun(root, invocation.runId);
  let lock;
  try {
    lock = acquireRunLock(root, invocation.runId);
  } catch (error) {
    if (error instanceof RunLockBusyError) {
      throw new PublicCommandError("run_busy", 3);
    }
    throw new PublicCommandError("workspace_invalid", 1);
  }
  let result: Readonly<Record<string, unknown>> | undefined;
  let operationFailure: PublicCommandError | undefined;
  try {
    await inspectClearPreflight(root, invocation.runId);
    result = invocation.timeEnd === ""
      ? await clearAllObservations(lock, root, invocation.runId)
      : await clearRangeObservations(lock, root, invocation.runId, {
          timeStart: invocation.timeStart ?? undefined,
          timeEnd: invocation.timeEnd
        });
  } catch (error) {
    operationFailure = await classifyCleanupError(error, root, invocation.runId);
  }
  try {
    lock.release();
  } catch {
    throw new PublicCommandError("archive_recovery_required", 3);
  }
  if (operationFailure !== undefined) throw operationFailure;
  return result!;
}

async function main(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");
  if (args[0] === "act") {
    const act = parseActInvocation(args.slice(1));
    if (act === undefined) {
      writeError(json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }
    try {
      const plan = await readActionInput(act.actionFile, process.cwd());
      const result = await actRegion(process.cwd(), act.runId, plan);
      const receipt = createPublicActReceipt(act.runId, plan, result);
      if (act.json) {
        writeJson(receipt);
      } else if (result.outcome === "checkpoint") {
        process.stdout.write(`checkpoint ${result.checkpoint.observationId}\n${result.checkpoint.imagePath}\n`);
      } else {
        process.stdout.write(`completed ${result.emittedActionCount}\n`);
      }
      return 0;
    } catch (error) {
      const failure = classifyPublicActFailure(error);
      writeError(act.json, failure.code, failure.message);
      return failure.exitCode;
    }
  }

  if (args[0] === "history") {
    const history = parseHistoryInvocation(args.slice(1));
    if (history === undefined) {
      writeError(json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }
    try {
      inspectAdmittedCommandRun(process.cwd(), history.runId);
      if (history.mode === "list") {
        const result = await listRunHistory(process.cwd(), history.runId);
        if (history.json) {
          writeJson(result);
        } else {
          process.stdout.write(result.items.map((item) =>
            `${item.observationId} ${item.availability}`
          ).join("\n") + (result.items.length === 0 ? "" : "\n"));
        }
      } else {
        const result = await showRunHistory(process.cwd(), history.runId, history.observationId!);
        if (history.json) {
          writeJson(result);
        } else {
          process.stdout.write(`${result.availability}\n`);
          if (result.availability === "available") {
            process.stdout.write(`${result.imagePath}\n`);
          }
        }
      }
      return 0;
    } catch (error) {
      const failure = error instanceof PublicCommandError
        ? error
        : mapArchiveQueryError(error);
      return commandFailure(history.json, failure.code, failure.exitCode);
    }
  }

  if (args[0] === "clear" || args[0] === "clearall") {
    const clear = parseClearInvocation(args.slice(1), args[0] === "clearall");
    if (clear === undefined) {
      writeError(json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }
    try {
      const result = await executeClear(process.cwd(), clear);
      if (clear.json) {
        writeJson(result);
      } else if (args[0] === "clearall") {
        process.stdout.write(`cleared ${result.clearedCount}\n`);
      } else {
        process.stdout.write(`cleared ${result.clearedCount}\n`);
      }
      return 0;
    } catch (error) {
      const failure = error instanceof PublicCommandError
        ? error
        : new PublicCommandError("archive_recovery_required", 3);
      return commandFailure(clear.json, failure.code, failure.exitCode);
    }
  }

  if (args[0] === "observe") {
    const observe = parseObserveInvocation(args.slice(1));
    if (observe === undefined) {
      writeError(json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }
    if (observe.selector === undefined) {
      writeError(
        observe.json,
        "blocked_environment",
        "Full-desktop capture is unavailable in this environment."
      );
      return 3;
    }
    try {
      const result = await observeRegion(process.cwd(), observe.runId, observe.selector);
      if (observe.json) {
        writeJson(result);
      } else {
        process.stdout.write(`observation ${result.observationId}\n${result.imagePath}\n`);
      }
      return 0;
    } catch (error) {
      if (error instanceof ObserveCaptureError) {
        writeError(observe.json, "capture_invalid", "Capture could not be validated safely.");
        return 3;
      }
      if (error instanceof ObserveQuotaError) {
        writeError(observe.json, "capture_quota_exceeded", "Capture quota cannot be satisfied safely.");
        return 3;
      }
      if (error instanceof ObserveArchiveError) {
        writeError(observe.json, "archive_recovery_required", "Observation archive requires recovery.");
        return 3;
      }
      if (error instanceof ObserveWorkspaceError) {
        writeError(observe.json, "workspace_invalid", "Workspace state cannot be used safely.");
        return 1;
      }
      writeError(observe.json, "internal_error", "Observe failed safely.");
      return 1;
    }
  }

  const invocation = parseInvocation(args);
  if (invocation === undefined) {
    writeError(json, "usage_invalid", "Invalid command invocation.");
    return 2;
  }

  if (invocation.command === "help" && invocation.operands.length <= 1) {
    const topic = invocation.operands[0];
    if (topic !== undefined && !Object.hasOwn(helpEntries, topic)) {
      writeError(invocation.json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }
    if (invocation.json) {
      writeJson(
        topic === undefined
          ? { kind: "cu.help.result/v1", topics: helpTopics }
          : { kind: "cu.help.result/v1", topic, text: helpEntries[topic] }
      );
    } else {
      writeHelp(topic);
    }
    return 0;
  }

  if (invocation.command === "displays" && invocation.operands.length === 0) {
    try {
      const result = queryWindowsDisplays();
      if (invocation.json) {
        writeJson(result);
      } else {
        writeHumanDisplays(result);
      }
      return 0;
    } catch (error) {
      if (error instanceof WindowsDisplayError) {
        writeError(invocation.json, "display_unavailable", "Display topology is unavailable in this environment.");
        return 3;
      }
      writeError(invocation.json, "internal_error", "Display query failed safely.");
      return 1;
    }
  }

  if (invocation.command === "init" && invocation.operands.length === 0) {
    try {
      const created = initializeWorkspace(process.cwd());
      if (invocation.json) {
        writeJson({ kind: "cu.init.result/v1", created });
      } else {
        process.stdout.write(created ? "workspace initialized\n" : "workspace already initialized\n");
      }
      return 0;
    } catch {
      writeError(invocation.json, "workspace_invalid", "Workspace state cannot be initialized safely.");
      return 1;
    }
  }

  if (invocation.command === "status" && invocation.operands.length <= 1) {
    const runId = invocation.operands[0];
    if (runId !== undefined && !isRunId(runId)) {
      writeError(invocation.json, "usage_invalid", "Invalid command invocation.");
      return 2;
    }

    try {
      const workspace = inspectWorkspace(process.cwd());
      if (!workspace.initialized) {
        if (invocation.json) {
          writeJson(
            runId === undefined
              ? { kind: "cu.status.result/v1", workspace, runs: [] }
              : { kind: "cu.status.result/v1", workspace, run: { id: runId, exists: false } }
          );
        } else if (runId === undefined) {
          writeHumanWorkspaceStatus(false, []);
        } else {
          writeHumanRunStatus(false, { id: runId, exists: false });
        }
        return 0;
      }
      if (runId === undefined) {
        const runs = listWorkspaceRuns(process.cwd());
        if (invocation.json) {
          writeJson({ kind: "cu.status.result/v1", workspace, runs });
        } else {
          writeHumanWorkspaceStatus(true, runs);
        }
        return 0;
      }
      const run = inspectRun(process.cwd(), runId);
      if (run === undefined) {
        if (invocation.json) {
          writeJson({ kind: "cu.status.result/v1", workspace, run: { id: runId, exists: false } });
        } else {
          writeHumanRunStatus(true, { id: runId, exists: false });
        }
        return 0;
      }
      const status = await inspectRunStatus(process.cwd(), runId);
      if (invocation.json) {
        writeJson({ kind: "cu.status.result/v1", workspace, run: status });
      } else {
        writeHumanRunStatus(true, status);
      }
      return 0;
    } catch (error) {
      if (error instanceof RunStateError) {
        return commandFailure(invocation.json, "run_invalid", 1);
      }
      if (error instanceof ArchiveQueryEffectJournalInvalidError) {
        return commandFailure(invocation.json, "effect_journal_invalid", 1);
      }
      if (error instanceof ArchiveQueryError) {
        return commandFailure(invocation.json, "archive_invalid", 1);
      }
      writeError(invocation.json, "workspace_invalid", "Workspace state cannot be inspected safely.");
      return 1;
    }
  }

  writeError(invocation.json, "usage_invalid", "Invalid command invocation.");
  return 2;
}

function sameCommandPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const canonical = realpathSync.native(resolve(value));
    return process.platform === "win32"
      ? canonical.replaceAll("/", "\\").toLowerCase()
      : canonical;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && sameCommandPath(invokedPath, fileURLToPath(import.meta.url))) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      writeError(process.argv.includes("--json"), "internal_error", "Command failed safely.");
      process.exitCode = 1;
    }
  );
}
