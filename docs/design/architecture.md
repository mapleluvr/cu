# cu Architecture

## Status and Intent

This document explains the product architecture of `cu`. Exact schemas and safety
invariants live in the [v1 specification](../specification/v1/README.md); this overview
does not by itself establish that a desktop capability has passed release verification.

`cu` is a standalone, CLI-first Computer Use product. Agents and operators use ordinary
shell commands and progressively discover details through `cu help`.

The design choices recorded here are:

- the normal interactive desktop is the intended autonomous scope;
- a fresh usable screenshot is sufficient evidence for ordinary pointer and keyboard
  actions; foreground target identity is diagnostic rather than a normal input gate;
- the default profile is `autonomous`; `cautious` is an optional stronger profile;
- action plans use deterministic visual-evidence micro-batching rather than UI
  semantic recognition;
- captures are stored under `.cu/<run_id>/` and retained until explicit cleanup or
  bounded quota eviction;
- history is explicit and diagnostic-only; bounded eviction removes oldest history
  before current live evidence;
- `cu` has no model-visible or daemon-required session protocol.

## Component Boundaries

```text
Agent or human shell
  |
  +-- cu init / observe / act / history / status / clear / clearall / help
        |
        +-- CLI parser and versioned receipt layer
        +-- run-scoped control-record store
        +-- deterministic action segmenter and policy
        +-- command-scoped effect journal and cleanup
        +-- Windows observation and input helpers
        +-- .cu/<run_id>/ capture archive
```

## Command-Scoped Execution

A CLI command may start a helper and a scheduler, but neither survives as a required
agent-facing session. `observe` and `act` are separate processes.

A run is only a workspace namespace. It contains one current control record, an effect
journal, a bounded capture archive, and an exclusive lock. The run ID is not a helper
session ID, request ID, observation ID, or authorization identity for isolated
full-desktop capture.

```text
cu observe work-a
  -> capture and validate image
  -> atomically install live observation record
  -> append diagnostic history record
  -> close helper

cu act work-a --action-file -
  -> acquire run lock
  -> validate current live observation and fresh environment
  -> journal input intent before emission
  -> execute one finite safe segment
  -> commit outcome or retain indeterminate journal state
  -> close helper and release lock
```

No input state, held button, held key, effect lease, or cleanup obligation crosses a
command boundary.

## Run Storage

```text
.cu/
  workspace.json
  <run_id>/
    run.json
    live-observation.json
    effect-journal.json
    history.ndjson
    captures/
      <observationId>.png
      <observationId>.json
```

The exact physical layout is an implementation detail, but these logical boundaries
are contractual:

- `live-observation.json` is the only record eligible for `act`.
- historical PNGs are never input authority.
- writes use a run lock, regular-file checks, confined paths, atomic replacement, and
  crash-aware recovery.
- records omit raw typed text, PIDs, HWNDs, helper paths, target identities, and
  unrestricted diagnostics.
- a journal with unproven post-intent state blocks automatic replay.

The current live record binds the image digest, dimensions, normalized coordinate
space, source mapping, capture time, expiration, environment fingerprint, topology
fingerprint, and one-use state. Before an action, `cu` makes a fresh environment probe.
A changed or expired environment rejects the action and requires a fresh observation.

## Deterministic Micro-Batching

`cu` does not identify application-specific buttons or claim to understand their
business consequences. It classifies generic input actions according to whether later
coordinates could rely on stale visual evidence.

A short segment can include one coordinate action followed by editing actions, for
example click -> type text -> Enter. A visual decision boundary ends the segment after
scrolling, dragging, a focus-changing key, or before a second coordinate action. At
that boundary `cu` captures a new observation and returns `checkpoint`; it never
blindly executes the unobserved remainder of a plan.

The next plan is a new CLI request referring to the new observation. No continuation
daemon or hidden plan execution is required.

## Profiles and Hard Stops

`autonomous` permits ordinary actions across the normal interactive desktop when the
latest evidence remains valid. It does not add confirmation friction to ordinary
clicks, text input, or window changes.

`cautious` uses the same CLI and action language while applying stricter confirmation
or attention behavior for identified sensitive actions.

Both profiles must reject locked or secure desktops, elevation or permission-bypass
paths, unavailable interactive environments, unknown input state, failed cleanup,
quarantine, malformed or over-limit action plans, forbidden system chords, and
unprovable effect outcomes.

The public CLI may support full-desktop observation as a product capability, but its
advertisement and release verification require an isolated, controlled environment.
Unverified environments must report a capability block rather than treating a live
personal desktop as acceptance evidence.

## Capture Retention

The CLI retains run captures by default. It does not delete evidence merely because an
individual command ends. `clear` and `clearall` are the explicit deletion interfaces.

A dual quota limits stored bytes and capture count. Eviction removes oldest historical
captures first and never silently evicts the current actionable observation. Requests
for evicted history return an explicit unavailable result.

## Non-Goals

`cu` v1 does not provide:

- a macro language, loops, conditionals, background task execution, or automatic
  retries after uncertain effects;
- application-specific UI semantic recognition;
- arbitrary path access through run IDs or capture references;
- a claim that native input emission proves an application-level task succeeded;
- a required persistent daemon, hidden continuation session, or host-specific command
  envelope.
