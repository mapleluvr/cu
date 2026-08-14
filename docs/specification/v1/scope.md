# cu v1 Scope

## Outcome

Deliver `cu` as a standalone, shell-invoked Computer Use CLI for a local Windows
operator or agent. A user can initialize a workspace, inspect the current multi-monitor
topology, create and inspect validated observations, submit finite keyboard and pointer
actions against current evidence, inspect safe history and status, and explicitly
remove retained captures. Each
invocation is standalone, and effect state remains truthful across separate command
processes.

## Acceptance

- `CU-V1-A01`: A packaged and independently installed `cu` binary implements `init`,
  `displays`, `observe`, `act`, `history`, `status`, `clear`, `clearall`, and
  `help` with the versioned JSON and exit behavior.
- `CU-V1-A02`: `cu init` creates or validates only the workspace control record; it
  performs no helper, capture, input, run deletion, or incompatible-state repair.
- `CU-V1-A03`: `displays` exposes only one stable topology snapshot with topology-bound
  geometric placement IDs. `observe` archives only independently validated immutable
  PNG/sidecar bundles, optionally constrains a region to one revalidated display
  placement, installs one current live observation through the specified archive
  transaction cutover, and binds its coordinate and environment evidence.
- `CU-V1-A04`: `act` emits only a finite safe segment bound to an actionable current
  observation. A visual boundary returns a fresh checkpoint; an uncertain effect is
  never automatically replayed.
- `CU-V1-A05`: `history`, `status`, `clear`, and `clearall` preserve the diagnostic,
  redaction, lock, journal, and current-evidence guarantees in the public contract.
- `CU-V1-A06`: Real native input acceptance uses only a controlled target/decoy
  fixture on the current Windows desktop and proves both intended target effects and
  absence of decoy effects or residue.
- `CU-V1-A07`: Unrestricted full-desktop observation is accepted only in an isolated
  Windows Sandbox or VM with a synthetic desktop. A normal host reports
  `blocked_environment` instead of claiming that capability.
- `CU-V1-A08`: Final completion requires fresh package-level, filesystem, controlled
  live-input, crash/no-replay, and isolated full-desktop E2E evidence plus independent
  review; historical or component-level results do not substitute for fresh evidence.

## Hard Constraints

- `cu` is a standalone Node/TypeScript ESM CLI with no required host runtime.
- Observation and input use a command-scoped stock Windows PowerShell 5.1 helper;
  no model-visible or required persistent daemon exists.
- Current-host verification effects are limited to the test-owned controlled fixture.
  Full-desktop effects or acceptance never use the ordinary developer desktop.

## Non-Goals

- A host-specific tool registration layer, hidden continuation protocol, or required
  persistent service.
- A macro language, loops, conditionals, background task execution, or automatic
  retry after an uncertain effect.
- Browser DOM, accessibility-tree, UI Automation, remote input, UIAccess, elevation,
  clipboard injection, `SendKeys`, `keybd_event`, or an input-bypass mechanism.
- Physical-monitor identity claims, Windows Task View desktop enumeration or exact
  selection, and capture or control of an inactive Task View desktop.
- A public profile-configuration command in v1.
- A claim that native input proves an application-level business outcome.

## Protected Invariants

- Only the latest live observation is coordinate authority; historical captures are
  diagnostic-only.
- No held button, key, helper, effect lease, cleanup obligation, or uncommitted effect
  state crosses a command boundary.
- Archive publish/cleanup is rollback-only before live cutover and forward-only after
  live cutover; unprovable archive state blocks rather than being repaired.
- An unresolved effect journal blocks automatic replay and destructive cleanup until a
  fresh successful observation establishes a new safe boundary without claiming the
  prior effect outcome.
- All run IDs, archive references, action-file paths, and writes are confined to their
  validated workspace boundaries. Mutable control records advance only by replacing an
  existing stable-witness-bound predecessor while the caller holds the run lock;
  unprovable replacement state blocks recovery rather than being overwritten.
- Receipts, history, status, errors, and journals never retain or expose raw typed
  text, private helper paths, raw process identifiers, window handles, or task-success
  claims.
- Locked, secure, unavailable, elevated/bypass, unknown-input, cleanup-failed, and
  unprovable-effect states fail closed.

## Verification Effect Boundary

Current-host tests may emit input only to their own controlled target/decoy fixture.
Full-desktop verification requires an isolated Windows Sandbox or VM containing only
synthetic content. Nothing in this specification authorizes arbitrary host-window
input, live personal-desktop acceptance, elevation bypass, or an effect outside the
contracts above.
