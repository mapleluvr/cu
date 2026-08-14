import {
  isCaptureSelector,
  type CaptureSelector
} from "./display.js";
import { inspectUnresolvedEffect } from "./effect-store.js";
import { isRunId } from "./identifiers.js";
import {
  ObservationArchiveQuotaError,
  publishCaptureObservation,
  recoverObservationArchive,
  type PublishCaptureObservationOptions
} from "./observation-archive.js";
import { acquireRunLock, RunLockBusyError } from "./run-lock.js";
import { ensureRun } from "./run.js";
import {
  captureRegionalObservation,
  type WindowsCaptureDependencies
} from "./windows-capture.js";
import { workspaceFingerprint } from "./workspace.js";

export class ObserveWorkspaceError extends Error {
  constructor() {
    super("");
  }
}

export class ObserveCaptureError extends Error {
  constructor() {
    super("");
  }
}

export class ObserveArchiveError extends Error {
  constructor() {
    super("");
  }
}

export class ObserveQuotaError extends ObserveArchiveError {}

export type ObserveRegionDependencies = Readonly<{
  captureDependencies?: WindowsCaptureDependencies;
  publishOptions?: PublishCaptureObservationOptions;
}>;

export type ObserveResult = Readonly<{
  kind: "cu.observe.result/v1";
  runId: string;
  observationId: string;
  imagePath: string;
  coordinateSpace: "normalized_999_top_left";
  capturedAt: string;
  expiresAt: string;
  actionable: true;
  evictedHistoryCount: number;
}>;

export async function observeRegion(
  root: string,
  runId: string,
  selector: CaptureSelector,
  dependencies: ObserveRegionDependencies = {}
): Promise<ObserveResult> {
  if (!isRunId(runId) || !isCaptureSelector(selector)) {
    throw new ObserveWorkspaceError();
  }

  try {
    ensureRun(root, runId);
  } catch (error) {
    if (error instanceof RunLockBusyError) throw new ObserveArchiveError();
    throw new ObserveWorkspaceError();
  }

  let lock;
  try {
    lock = acquireRunLock(root, runId);
  } catch {
    throw new ObserveArchiveError();
  }

  try {
    const fingerprint = workspaceFingerprint(root);
    let unresolvedEffect;
    try {
      await recoverObservationArchive(lock, root, runId);
      unresolvedEffect = inspectUnresolvedEffect(lock, root, runId);
    } catch {
      throw new ObserveArchiveError();
    }

    let captured;
    try {
      captured = await captureRegionalObservation(
        { selector, runId, workspaceFingerprint: fingerprint },
        dependencies.captureDependencies
      );
    } catch {
      throw new ObserveCaptureError();
    }

    let published;
    try {
      published = await publishCaptureObservation(
        lock,
        root,
        runId,
        captured.bundle,
        { ...dependencies.publishOptions, resolveEffect: unresolvedEffect }
      );
    } catch (error) {
      if (error instanceof ObservationArchiveQuotaError) throw new ObserveQuotaError();
      throw new ObserveArchiveError();
    }

    return Object.freeze({
      kind: "cu.observe.result/v1",
      runId,
      observationId: published.observationId,
      imagePath: `.cu/${runId}/captures/${published.observationId}.png`,
      coordinateSpace: "normalized_999_top_left",
      capturedAt: captured.capturedAt,
      expiresAt: captured.expiresAt,
      actionable: true,
      evictedHistoryCount: published.evictedHistoryCount
    });
  } finally {
    try {
      lock.release();
    } catch {
      throw new ObserveArchiveError();
    }
  }
}
