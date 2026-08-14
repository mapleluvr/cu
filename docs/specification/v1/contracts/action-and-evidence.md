# Action and Evidence Contract

## Action Language

[`Action File Contract`](./action-file.md) defines the exact `cu.action/v1` syntax,
normalization, resource, key-vocabulary, hard-chord, and D2-classification contract. [`Observation, Archive, and Effect Records`](./observation-and-effect-records.md)
defines the live evidence, archive, quota, and no-replay state that later `act` and
`observe` orchestration must use. Neither contract alone adds a command route or
desktop capability.

An action plan has no loop, condition, background continuation, or cross-command
held-input feature. Malformed, over-limit, unbalanced, prohibited, or stale actions
emit no native input.

## Evidence Admission

Before emitting input, `act` verifies all of the following:

1. The named observation is the current actionable live record and has not been
   consumed, cleared, expired, or superseded.
2. Image digest, dimensions, coordinate space, source mapping, environment fingerprint,
   and topology fingerprint remain valid.
3. A fresh environment probe reports an interactive default desktop and no hard-stop
   condition.
4. The run lock is held, quota and policy checks succeed, and no unresolved effect
   journal is present.
5. A durable effect intent has been written before the first native-input emission.

The effect intent stores redacted/accounting material only; it never persists raw typed
text. A successful fresh `observe` may resolve an earlier unresolved journal only after
new evidence commits; it does not replay the old plan or claim its application outcome.

## Deterministic Segmenter

`cu` emits the longest safe prefix of a submitted finite plan, not an unobserved plan
continuation. A segment may include one coordinate action followed by editing actions.
A visual decision boundary occurs after a scroll, after a complete drag, after a
focus-changing key, or before a second coordinate action.

At a boundary, `cu` proves cleanup, captures a new observation, atomically installs it,
and returns `checkpoint`. The unexecuted tail is neither retained nor replayed. The
next request must name the new observation ID.

If no boundary remains, `act` returns `completed`. If no effect is emitted it returns
`blocked`; if effect may have occurred it returns `partial` or `indeterminate` and
retains the journal until a defined recovery process can establish a truthful state.

## Policy and Hard Stops

`autonomous` is the default active v1 profile. It allows ordinary action language input
when current visual/environment evidence is valid. `cautious` is a reserved persisted
profile for a later configuration contract and changes confirmation behavior only.

No profile may bypass a locked or secure desktop, unavailable interactive environment,
elevation/permission-bypass path, prohibited system chord, unknown held input,
quarantine, failed cleanup, malformed action, resource limit, or unprovable effect.
Normal autonomous input relies on current screenshot and environment evidence rather
than foreground target identity.

## Observation Trust and Privacy

A historical image can be viewed through `history` but is always
`diagnosticOnly: true`; it cannot become action authority. Receipts, history, status,
errors, and on-disk diagnostics omit raw typed text, raw process IDs, window handles,
helper paths, and application-success claims.

Current-host live E2E uses a test-owned target/decoy fixture. Only fixture target events
may prove a successful input case; every rejected/no-effect case proves both target and
decoy event streams empty.
