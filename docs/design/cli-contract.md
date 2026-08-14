# cu Public CLI Contract

## Conventions

All commands operate relative to the current workspace. `cu init` creates and validates
`.cu/` there. A run ID is a restricted workspace label, not a filesystem path or an
isolation authorization. The grammar is lowercase ASCII letters, digits, periods,
underscores, and hyphens; `..`, path separators, and empty values are rejected.

Human-readable output is available by default. `--json` writes one structured result to
stdout. Diagnostics go to stderr. A completed operation or expected checkpoint exits
zero; blocked, partial, and indeterminate results exit nonzero; malformed invocation
uses a distinct usage error exit code.

## Commands

### `cu init`

```text
cu init [--json]
```

Creates `.cu/workspace.json` when absent. If `.cu` already exists, verifies its schema
and workspace binding. It never starts a helper, captures the desktop, deletes a run,
or silently repairs incompatible state.

### `cu displays`

```text
cu displays [--json]
```

Reads one stable interactive-desktop display snapshot without capturing pixels, creating
workspace state, or emitting input. JSON output is one exact public inventory:

```json
{
  "kind": "cu.displays.result/v1",
  "topologyFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "coordinateSpace": "virtual_screen_pixels",
  "virtualScreenPx": { "x": -1280, "y": 0, "width": 3200, "height": 1080 },
  "displays": [
    {
      "displayId": "dsp_0123456789abcdef0123456789abcdef",
      "boundsPx": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
      "primary": true
    }
  ]
}
```

A display ID identifies one ordered geometric placement inside the exact topology
fingerprint. It is not a physical monitor identity and becomes stale whenever the
projected virtual-screen or monitor geometry changes. Ambiguous duplicate placements
fail closed instead of minting interchangeable IDs. This command reports only the
multi-monitor virtual screen on the current Win32 input desktop; it does not enumerate
or identify Windows Task View virtual desktops. An unavailable, changing, or ambiguous
topology returns `display_unavailable` with exit code 3.

### `cu observe <run_id>`

```text
cu observe <run_id> [--region <normalized-or-pixel-rectangle>] [--display <display_id>] [--json]
```

Creates the run atomically on first use, captures the requested desktop scope, validates
the result, writes a capture and a new current live observation record, and returns:

```json
{
  "kind": "cu.observe.result/v1",
  "runId": "work-a",
  "observationId": "obs_0123456789abcdef0123456789abcdef",
  "imagePath": ".cu/work-a/captures/obs_0123456789abcdef0123456789abcdef.png",
  "coordinateSpace": "normalized_999_top_left",
  "capturedAt": "2026-07-23T00:00:00.000Z",
  "expiresAt": "2026-07-23T00:01:00.000Z",
  "actionable": true,
  "evictedHistoryCount": 0
}
```

A full-desktop request is subject to the advertised capability and environment gate.
A supported region is an advanced selector, not a different trust model. `--display`
requires `--region`; region coordinates retain their existing virtual-screen meaning
and must resolve wholly inside the selected display bounds. The capture helper
recomputes the topology-bound display ID before reading pixels, and the parent
independently repeats the resolution from the returned topology. A stale ID,
cross-display region, or topology race publishes no observation.

### `cu act <run_id> --action-file <path|->`

```text
cu act <run_id> --action-file <path|-> [--json]
```

The action file is distinct from every Windows isolation manifest. It has this public
shape:

```json
{
  "kind": "cu.action/v1",
  "observationId": "obs_opaque",
  "coordinateSpace": "normalized_999_top_left",
  "actions": [
    { "kind": "click", "at": { "x": 420, "y": 318 } },
    { "kind": "type_text", "text": "example" },
    { "kind": "key", "key": "Enter" }
  ]
}
```

`cu` validates the action file, current live observation, fresh environment, quotas,
policy, and effect journal before native input is emitted. It returns exactly one of:

- `completed`: the complete finite segment was emitted and cleanup was proven;
- `checkpoint`: a safe prefix was emitted and a newly captured observation is ready;
- `blocked`: no effect was emitted;
- `partial`: some effect may have occurred and no automatic replay is allowed;
- `indeterminate`: post-intent state cannot be proven and the run must not replay.

A successful `completed` or `checkpoint` operation returns `cu.act.result/v1`.
`blocked`, `partial`, and `indeterminate` operations use the shared `cu.error/v1`
envelope with exit codes 3, 4, and 5 respectively. An `act` result never claims that
a UI button achieved its business objective.

### `cu history <run_id>`

```text
cu history <run_id> [list] [--json]
cu history <run_id> show <observation_id> [--json]
```

`list` returns bounded, newest-first metadata without raw typed text or private target
information. `show` returns the stored relative image path and marks it
`diagnosticOnly: true`. A history image cannot be supplied to `act` as coordinate
evidence. Evicted or cleared records return explicit status rather than appearing valid.

### `cu status [run_id]`

```text
cu status [run_id] [--json]
```

Without a run it returns safe workspace/run summaries. With a run it reports lifecycle,
current-observation availability, quota usage, history eviction count, profile, and
safe capability state. It never exposes private helper paths, raw process identifiers,
window handles, raw typed text, or task-success claims.

### `cu clear` and `cu clearall`

```text
cu clear <run_id> <time_end> [--json]
cu clear <run_id> <time_start> <time_end> [--json]
cu clearall <run_id> [--json]
```

Times are exact UTC RFC3339 timestamps. One time deletes captures strictly before its
end; two times delete `start <= capturedAt < end`. If a selected capture is current,
its live record is atomically invalidated and a later `act` requires a new observation.

`clearall` removes the complete run archive, including its live record, so the run is
no longer usable until a fresh observation recreates it. Both cleanup commands reject a
busy run, a running effect, or unresolved journal state; deletion cannot hide an unknown
input result.

### `cu help [topic]`

```text
cu help
cu help displays
cu help act
cu help action-file
cu help history
```

Help is the progressive-disclosure interface for agents. It is versioned documentation
with no desktop, archive, or input side effects.

## Profile Contract

The run profile is `autonomous` by default and may be configured as `cautious` through
a future explicit workspace/run configuration command. The command grammar stays the
same. Profile choice changes policy behavior, never allows a secure-desktop, elevation,
unknown-input, or unprovable-effect bypass.

## Image Delivery Contract

`cu` always returns the workspace-relative `imagePath` for a visual result. Clients may
open that validated PNG after resolving the path inside the current workspace. The JSON
receipt remains authoritative for observation ID, coordinate space, actionable state,
and diagnostic-only status.
