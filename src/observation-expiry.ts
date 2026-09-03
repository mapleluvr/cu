export type ObservationTtlMs = number | null;

export const DEFAULT_OBSERVATION_TTL_MS = 300_000;
export const MAX_OBSERVATION_TTL_SECONDS = 2_147_483_647;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isObservationTtlMs(value: unknown): value is ObservationTtlMs {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1_000 &&
      value % 1_000 === 0 &&
      value <= MAX_OBSERVATION_TTL_SECONDS * 1_000)
  );
}

export function expirationFor(
  capturedAt: Date,
  ttlMs: ObservationTtlMs = DEFAULT_OBSERVATION_TTL_MS,
): string | null {
  if (
    !(capturedAt instanceof Date) ||
    !Number.isFinite(capturedAt.getTime()) ||
    !isObservationTtlMs(ttlMs)
  ) {
    throw new Error("observation TTL is invalid");
  }
  if (ttlMs === null) {
    return null;
  }
  const expiresAt = new Date(capturedAt.getTime() + ttlMs);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("observation TTL is invalid");
  }
  return expiresAt.toISOString();
}

export function isValidObservationExpiry(
  capturedAt: unknown,
  expiresAt: unknown,
): expiresAt is string | null {
  if (expiresAt === null) {
    return typeof capturedAt === "string" && isCanonicalTimestamp(capturedAt);
  }
  if (
    typeof capturedAt !== "string" ||
    !isCanonicalTimestamp(capturedAt) ||
    typeof expiresAt !== "string" ||
    !isCanonicalTimestamp(expiresAt)
  ) {
    return false;
  }
  const difference =
    new Date(expiresAt).getTime() - new Date(capturedAt).getTime();
  return isObservationTtlMs(difference);
}

export function ttlMsBetween(
  capturedAt: string,
  expiresAt: string | null,
): ObservationTtlMs {
  if (expiresAt === null) {
    return null;
  }
  const ttlMs = new Date(expiresAt).getTime() - new Date(capturedAt).getTime();
  if (!isObservationTtlMs(ttlMs)) {
    throw new Error("observation TTL is invalid");
  }
  return ttlMs;
}

function isCanonicalTimestamp(value: string): boolean {
  if (!TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
