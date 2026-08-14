# Decision 004: Strict Action File and D2 Admission

## Context

The v1 design requires a finite action file and deterministic visual micro-batching,
but its early contract intentionally did not freeze a concrete JSON
action vocabulary. Implementing `act` or a parser against an example-only shape would
silently create a public API and could permit unbalanced input or untestable visual
continuation.

## Decision

Adopt [`../contracts/action-file.md`](../contracts/action-file.md) as the exact
`cu.action/v1` contract. It uses an exact-key UTF-8 JSON object with normalized
observation-local coordinates, bounded atomic actions, a constrained balanced sequence
only for modifier-qualified single-coordinate interactions, a fixed portable-key
vocabulary, two direct hard-prohibited chord patterns, and stable pre-effect error
codes. Its **Constrained Sequences** section fixes every transition object's exact
shape and balanced-hold classification; its **D2 Boundary Classification** section
makes the sequence's sole coordinate leaf count as one indivisible coordinate action.

The D2 classifier emits the longest safe prefix. It checkpoints before a second
coordinate action and after drag, wheel, focus/visual keys, or chords. It never
preserves or replays a tail. The initial implementation is a pure admission and
classification module only.

## Alternatives Considered

- **High-level atomics only:** simpler but cannot represent common modifier-qualified
  input such as Control-click without a later public schema break.
- **Fully general public down/up programs:** supports arbitrary input choreography but
  exposes held-input and cleanup states unnecessarily and weakens the command-boundary
  invariant.
- **Reuse a host-specific tool schema directly:** rejected because host envelopes,
  target metadata, post-observation fields, and profile semantics are not part of the
  standalone CLI contract.

## Consequences

Pure parser and segmenter evidence can be established without invoking a helper or
native input. Any future expansion of key vocabulary, hard chord policy, sequence
expressiveness, observation identifier syntax, or public action error code requires a
versioned contract update and compatibility review.
