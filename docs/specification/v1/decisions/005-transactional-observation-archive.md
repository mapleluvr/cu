# Decision 005: Transactional Observation Archive and Effect Recovery

## Context

A capture consists of a PNG, immutable metadata, current coordinate authority, history,
quota bookkeeping, and sometimes recovery of a prior unresolved input effect. These
cannot be truthfully made visible by independent untracked file writes. In particular,
a current observation must not point to a partial bundle, history eviction must not
silently delete the only actionable evidence, and a crash after input intent must not
permit replay.

## Decision

Use immutable per-observation PNG/sidecar bundles, a strict live-record/tombstone
union, and one run-scoped `archive-transaction.json` guarded by the existing per-run
lock. Publish cutover is atomic live-pointer replacement; range cleanup of the current
bundle cuts over through an active-transaction-bound no-bundle tombstone; and clear-all
cuts over through durable transaction state before forward deletion of the live/archive
records. Before cutover, recovery rolls back staged assets and restores transaction
trash. After cutover, recovery finalizes forward only.

The archive transaction is deliberately separate from `effect-journal.json`. It owns
capture publication, retention eviction, range/complete cleanup, bounded history-event
finalization, and archive crash recovery. The effect journal owns pre-input intent and
unproven effect state. A fresh successful observe may resolve an unresolved journal
only by publishing new evidence first; it records recovery without claiming an
application result or replaying the old action.

Retention is 128 historical bundles plus one optional current live bundle, with a
512 MiB committed-bundle byte budget. Eviction is oldest-first among eligible history,
never silently removes protected current or unresolved-effect evidence, and is durable
in history events.

## Alternatives Considered

- Independent mutable live/history writes leave unprovable crash states and make quota
  cleanup capable of silently discarding evidence.
- A scan-only orphan policy lacks a deterministic distinction between pre-cutover
  rollback and post-cutover finalization.
- Reusing the effect journal for archive publication conflates no-input capture failure
  with potentially emitted input and unnecessarily blocks recovery.
- SQLite adds a runtime and packaging surface that is disproportionate for a
  single-active-run, versioned JSON control-plane model.

## Consequences

Future storage implementation must add strictly admitted durable-record parsing,
confined binary bundle validation, atomic replacement, archive transaction recovery,
quota accounting, and history compaction before any helper capture or public `observe`
route is added. Tests must cover interrupted state at every transaction boundary,
reparse-point/path replacement attacks, fixed history-event descriptor recovery,
old-live preservation on pre-cutover failure, current-bundle tombstone cleanup,
clear-all live deletion, and forward-only post-cutover recovery.

This decision does not authorize a Windows helper, capture, desktop observation,
input emission, or public command integration. It supplies the control-record contract
that later capture and command integrations must obey.
