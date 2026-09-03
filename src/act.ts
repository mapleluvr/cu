import { randomBytes } from "node:crypto";

import {
  isAdmittedActionPlan,
  segmentActionPlan,
  type NormalizedActionPlan,
} from "./action-file.js";
import { buildEffectSegmentPlan } from "./effect-plan.js";
import {
  actAuthorityInputSource,
  beginEffectIntent,
  finalizeCompletedEffectIntent,
  inspectActAuthority,
  inspectUnresolvedEffect,
  transitionEffectIntent,
  EffectAuthorityEnvironmentChangedError,
  EffectAuthorityExpiredError,
  EffectAuthorityInvalidError,
  EffectAuthorityUnavailableError,
  EffectAuthorityUncertainError,
  EffectJournalInvalidError,
  EffectJournalUnresolvedError,
  type EffectIntent,
} from "./effect-store.js";
import {
  fullScreenSelectorForBounds,
  type CaptureSelector,
} from "./display.js";
import { isRunId } from "./identifiers.js";
import type { ObservationTtlMs } from "./observation-expiry.js";
import {
  publishCaptureObservation,
  recoverObservationArchive,
  ObservationArchiveError,
  type PublishCaptureObservationOptions,
} from "./observation-archive.js";
import { parseRegionSelector } from "./region.js";
import { acquireRunLock, RunLockBusyError } from "./run-lock.js";
import {
  captureRegionalObservation,
  type RegionalCapture,
} from "./windows-capture.js";
import {
  openWindowsInputSession,
  WindowsInputError,
  type WindowsInputSession,
} from "./windows-input.js";
import { workspaceFingerprint } from "./workspace.js";

export type ActBlockedCode =
  | "action_file_invalid"
  | "archive_recovery_required"
  | "effect_journal_unresolved"
  | "input_unavailable"
  | "observation_environment_changed"
  | "observation_expired"
  | "observation_unavailable"
  | "run_busy";

export type ActPartialCode =
  | "checkpoint_capture_failed"
  | "checkpoint_publish_failed"
  | "input_unproven";

export type ActIndeterminateCode = "cleanup_unproven" | "helper_lost";

export type ActInternalCode =
  | "effect_journal_invalid"
  | "internal_error"
  | "observation_invalid"
  | "workspace_invalid";

export class ActBlockedError extends Error {
  public constructor(public readonly code: ActBlockedCode) {
    super("");
  }
}

export class ActPartialError extends Error {
  public constructor(public readonly code: ActPartialCode) {
    super("");
  }
}

export class ActIndeterminateError extends Error {
  public constructor(public readonly code: ActIndeterminateCode) {
    super("");
  }
}

export class ActInternalError extends Error {
  public constructor(public readonly code: ActInternalCode) {
    super("");
  }
}

function mapAuthorityError(error: unknown): ActBlockedError | ActInternalError {
  if (error instanceof EffectJournalUnresolvedError) {
    return new ActBlockedError("effect_journal_unresolved");
  }
  if (error instanceof EffectAuthorityUnavailableError) {
    return new ActBlockedError("observation_unavailable");
  }
  if (error instanceof EffectAuthorityExpiredError) {
    return new ActBlockedError("observation_expired");
  }
  if (error instanceof EffectAuthorityEnvironmentChangedError) {
    return new ActBlockedError("observation_environment_changed");
  }
  if (error instanceof EffectJournalInvalidError) {
    return new ActInternalError("effect_journal_invalid");
  }
  if (
    error instanceof EffectAuthorityInvalidError ||
    error instanceof EffectAuthorityUncertainError
  ) {
    return new ActInternalError("observation_invalid");
  }
  return new ActInternalError("internal_error");
}

export type ActRegionDependencies = Readonly<{
  createEffectId?: () => string;
  now?: () => Date;
  openInputSession?: () => Promise<WindowsInputSession>;
  captureObservation?: (
    request: Readonly<{
      selector: CaptureSelector;
      runId: string;
      workspaceFingerprint: string;
      ttlMs?: ObservationTtlMs;
    }>,
  ) => Promise<RegionalCapture>;
  publishOptions?: PublishCaptureObservationOptions;
}>;

export type ActCompletedResult = Readonly<{
  outcome: "completed";
  emittedActionCount: number;
  emittedLeafActionCount: number;
}>;

export type ActCheckpointResult = Readonly<{
  outcome: "checkpoint";
  emittedActionCount: number;
  emittedLeafActionCount: number;
  checkpoint: Readonly<{
    observationId: string;
    imagePath: string;
    coordinateSpace: "normalized_999_top_left";
    capturedAt: string;
    expiresAt: string | null;
    actionable: true;
    evictedHistoryCount: number;
  }>;
}>;

export type ActRegionResult = ActCompletedResult | ActCheckpointResult;

function transitionAfterFailure(
  lock: ReturnType<typeof acquireRunLock>,
  root: string,
  runId: string,
  intent: EffectIntent,
  state: "partial" | "indeterminate",
  reason:
    | "helper_lost"
    | "input_unproven"
    | "cleanup_unproven"
    | "checkpoint_capture_failed"
    | "checkpoint_publish_failed",
  now: () => Date,
): never {
  try {
    transitionEffectIntent(lock, root, runId, intent, {
      state,
      reason,
      stateChangedAt: now().toISOString(),
    });
  } catch {
    throw new ActIndeterminateError("cleanup_unproven");
  }
  if (state === "partial") {
    if (
      reason === "input_unproven" ||
      reason === "checkpoint_capture_failed" ||
      reason === "checkpoint_publish_failed"
    ) {
      throw new ActPartialError(reason);
    }
    throw new ActIndeterminateError("cleanup_unproven");
  }
  throw new ActIndeterminateError(
    reason === "helper_lost" || reason === "cleanup_unproven"
      ? reason
      : "cleanup_unproven",
  );
}

export async function actRegion(
  root: string,
  runId: string,
  plan: NormalizedActionPlan,
  dependencies: ActRegionDependencies = {},
): Promise<ActRegionResult> {
  if (!isRunId(runId) || !isAdmittedActionPlan(plan)) {
    throw new ActBlockedError("action_file_invalid");
  }
  const segment = segmentActionPlan(plan);
  const effectPlan = buildEffectSegmentPlan(plan, segment);
  const now = dependencies.now ?? (() => new Date());
  const effectId =
    dependencies.createEffectId?.() ?? `eff_${randomBytes(16).toString("hex")}`;

  let lock: ReturnType<typeof acquireRunLock>;
  try {
    lock = acquireRunLock(root, runId);
  } catch (error) {
    if (error instanceof RunLockBusyError) {
      throw new ActBlockedError("run_busy");
    }
    throw new ActInternalError("workspace_invalid");
  }

  let session: WindowsInputSession | undefined;
  let terminalError: Error | undefined;
  try {
    try {
      await recoverObservationArchive(lock, root, runId);
      if (inspectUnresolvedEffect(lock, root, runId) !== undefined) {
        throw new ActBlockedError("effect_journal_unresolved");
      }
    } catch (error) {
      if (error instanceof ActBlockedError || error instanceof ActInternalError)
        throw error;
      if (error instanceof ObservationArchiveError) {
        throw new ActBlockedError("archive_recovery_required");
      }
      throw mapAuthorityError(error);
    }

    try {
      session = await (
        dependencies.openInputSession ?? openWindowsInputSession
      )();
    } catch {
      throw new ActBlockedError("input_unavailable");
    }

    let authority;
    try {
      authority = await inspectActAuthority(lock, root, runId, {
        observationId: plan.observationId,
        now,
        environmentFingerprint: session.environmentFingerprint,
        topologyFingerprint: session.topologyFingerprint,
      });
    } catch (error) {
      throw mapAuthorityError(error);
    }
    const source = actAuthorityInputSource(authority);
    const actions = Object.freeze(plan.actions.slice(0, segment.prefixLength));
    let checkpointSelector: CaptureSelector | undefined;
    let fingerprint: string | undefined;
    if (segment.outcome === "checkpoint") {
      try {
        if (source.captureKind === "full") {
          if (session.topology === undefined) {
            throw new Error("full-screen topology unavailable");
          }
          checkpointSelector = fullScreenSelectorForBounds(
            {
              x: source.leftPx,
              y: source.topPx,
              width: source.widthPx,
              height: source.heightPx,
            },
            session.topology,
          );
        } else {
          checkpointSelector = parseRegionSelector(
            `pixel:${source.leftPx},${source.topPx},${source.widthPx},${source.heightPx}`,
          );
        }
        fingerprint = workspaceFingerprint(root);
      } catch {
        throw new ActInternalError("observation_invalid");
      }
    }
    let prepared;
    try {
      prepared = session.prepareSegment({
        source: {
          mapping: source.mapping,
          leftPx: source.leftPx,
          topPx: source.topPx,
          widthPx: source.widthPx,
          heightPx: source.heightPx,
        },
        actions,
      });
    } catch {
      throw new ActBlockedError("input_unavailable");
    }

    let intent: EffectIntent;
    try {
      const intentTime = now();
      const startedAt = intentTime.toISOString();
      intent = beginEffectIntent(lock, root, runId, authority, {
        effectId,
        startedAt,
        plan: effectPlan,
        now: () => new Date(intentTime.getTime()),
        environmentFingerprint: session.environmentFingerprint,
        topologyFingerprint: session.topologyFingerprint,
      });
    } catch (error) {
      throw mapAuthorityError(error);
    }

    let emitted;
    try {
      emitted = await session.emitPrepared(prepared);
    } catch (error) {
      if (error instanceof WindowsInputError) {
        const state =
          error.phase === "input_unproven" ? "partial" : "indeterminate";
        return transitionAfterFailure(
          lock,
          root,
          runId,
          intent,
          state,
          error.phase,
          now,
        );
      }
      return transitionAfterFailure(
        lock,
        root,
        runId,
        intent,
        "indeterminate",
        "cleanup_unproven",
        now,
      );
    }
    if (
      emitted.emittedActionCount !== segment.prefixLength ||
      emitted.emittedLeafActionCount !== effectPlan.leafCount ||
      emitted.cleanup !== "not_needed" ||
      emitted.heldAfter.length !== 0
    ) {
      return transitionAfterFailure(
        lock,
        root,
        runId,
        intent,
        "indeterminate",
        "cleanup_unproven",
        now,
      );
    }

    if (segment.outcome === "checkpoint") {
      let captured: RegionalCapture;
      try {
        captured = await (
          dependencies.captureObservation ?? captureRegionalObservation
        )({
          selector: checkpointSelector!,
          runId,
          workspaceFingerprint: fingerprint!,
          ttlMs: source.observationTtlMs,
        });
      } catch {
        return transitionAfterFailure(
          lock,
          root,
          runId,
          intent,
          "partial",
          "checkpoint_capture_failed",
          now,
        );
      }
      let published;
      try {
        published = await publishCaptureObservation(
          lock,
          root,
          runId,
          captured.bundle,
          { ...dependencies.publishOptions, resolveEffect: intent },
        );
      } catch {
        return transitionAfterFailure(
          lock,
          root,
          runId,
          intent,
          "partial",
          "checkpoint_publish_failed",
          now,
        );
      }
      return Object.freeze({
        outcome: "checkpoint",
        emittedActionCount: emitted.emittedActionCount,
        emittedLeafActionCount: emitted.emittedLeafActionCount,
        checkpoint: Object.freeze({
          observationId: published.observationId,
          imagePath: `.cu/${runId}/captures/${published.observationId}.png`,
          coordinateSpace: "normalized_999_top_left",
          capturedAt: captured.bundle.capture.capturedAt,
          expiresAt: captured.bundle.capture.expiresAt,
          actionable: true,
          evictedHistoryCount: published.evictedHistoryCount,
        }),
      });
    }

    try {
      finalizeCompletedEffectIntent(lock, root, runId, intent);
    } catch {
      throw new ActIndeterminateError("cleanup_unproven");
    }
    return Object.freeze({
      outcome: "completed",
      emittedActionCount: emitted.emittedActionCount,
      emittedLeafActionCount: emitted.emittedLeafActionCount,
    });
  } catch (error) {
    terminalError =
      error instanceof Error ? error : new ActInternalError("internal_error");
    throw terminalError;
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        terminalError = new ActIndeterminateError("cleanup_unproven");
      }
    }
    try {
      lock.release();
    } catch {
      terminalError = new ActIndeterminateError("cleanup_unproven");
    }
    if (terminalError !== undefined && !terminalError.message) {
      // A finally-stage uncertainty must dominate a successful return.
      if (
        !(terminalError instanceof ActBlockedError) &&
        !(terminalError instanceof ActPartialError)
      ) {
        throw terminalError;
      }
    }
  }
}
