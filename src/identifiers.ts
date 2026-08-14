export function isRunId(value: string): boolean {
  return value !== "." && value !== ".." && /^[a-z0-9._-]+$/.test(value);
}

export function isObservationId(value: string): boolean {
  return /^obs_[a-f0-9]{32}$/.test(value);
}
