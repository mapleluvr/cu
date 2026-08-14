# Decision 002: Persisted JSON Control Records

## Context

The standalone CLI has no daemon session, yet an `act` process must know whether the
preceding `observe` evidence is still valid and whether any earlier effect is unresolved.
The state must remain inspectable, bounded, and recoverable without a database runtime
dependency.

## Decision

Use versioned JSON control records under `.cu/`, one exclusive run lock, confined
regular-file paths, temporary-file validation, and atomic replacement. The logical run
records are `run.json`, `live-observation.json`, `effect-journal.json`, `history.ndjson`,
and validated capture files. One current live observation is action authority; history
is not.

A journal records an effect intent before native input. Any missing final proof leaves
an unresolved journal that blocks replay and destructive cleanup.

## Alternatives Considered

- SQLite adds transactional machinery and packaging/recovery surface not needed for the
  single-active-run command model.
- In-memory state or a daemon cannot truthfully survive separate shell commands and
  process failure.

## Consequences

Record schemas are versioned public-to-the-repository contracts and receive filesystem,
crash, path-confinement, and concurrency tests. Corruption, incompatible version,
uncertain lock ownership, or incomplete journal state fails closed rather than being
silently repaired.
