# CLI Receipts Contract

## Scope

This contract defines the shell-visible behavior shared by all `cu` commands. It
refines the Public CLI Contract without introducing a required daemon or hidden session
protocol.

## Commands

The public command set is fixed for v1:

```text
cu init [--json]
cu displays [--json]
cu observe <run_id> [--region <normalized-or-pixel-rectangle>] [--display <display_id>] [--json]
cu act <run_id> --action-file <path|-> [--json]
cu history <run_id> [list] [--json]
cu history <run_id> show <observation_id> [--json]
cu status [run_id] [--json]
cu clear <run_id> <time_end> [--json]
cu clear <run_id> <time_start> <time_end> [--json]
cu clearall <run_id> [--json]
cu help [topic]
```

Run IDs are lowercase ASCII workspace labels containing only letters, digits, periods,
underscores, and hyphens. Empty IDs, path separators, and `..` are rejected.

`--display` is valid only with `--region`. The resolved region must remain wholly
inside the selected display placement and must still satisfy the existing regional
size and full-virtual-screen refusal rules. The helper and parent independently
recompute the display binding from the observed topology before publication.

## JSON Transport

With `--json`, stdout contains exactly one UTF-8 JSON object followed by one newline.
All diagnostics belong on stderr. Without `--json`, the command renders the same
receipt for people; that rendering is not an API.

Successful receipts use command-specific versioned kinds. At minimum:

- `cu.init.result/v1` identifies whether a valid workspace record was created or
  already present.
- `cu.displays.result/v1` contains `topologyFingerprint`,
  `coordinateSpace: "virtual_screen_pixels"`, `virtualScreenPx`, and an ordered
  `displays` array. Each display exposes only `displayId`, `boundsPx`, and `primary`.
  A display ID identifies one geometric placement in one exact topology, not a
  physical monitor or Windows virtual desktop.
- `cu.observe.result/v1` contains `runId`, `observationId`, relative `imagePath`,
  `coordinateSpace`, `capturedAt`, `expiresAt`, `actionable`, and
  `evictedHistoryCount`. It is emitted only after immutable-bundle validation and
  live-observation cutover.
- `cu.act.result/v1` contains `runId`, `outcome`, and emitted-action accounting. For
  `checkpoint`, it additionally contains exactly one `checkpoint` object with
  `observationId`, relative `imagePath`, `coordinateSpace`, `capturedAt`, `expiresAt`,
  `actionable: true`, and non-negative `evictedHistoryCount`; that object is emitted
  only after the replacement live observation cutover.
- History, status, cleanup, and help use their own `cu.<command>.result/v1` kind and
  expose only their safe public data.

Every expected failure uses this exact envelope shape:

```json
{
  "kind": "cu.error/v1",
  "code": "stable_machine_code",
  "message": "sanitized human explanation",
  "retryable": false
}
```

Error codes are stable machine identifiers. `message` is useful but must not disclose
private process, helper, typed-text, or target-identity data. `display_unavailable`
uses exit `3` when stable, unambiguous display topology cannot be established. A
stale `--display` binding is reported through the existing content-free capture
failure path and publishes no observation receipt.

## Exit Behavior

| Exit code | Meaning |
| --- | --- |
| `0` | Completed command or expected `checkpoint` |
| `1` | Internal failure, corrupt persistent state, or an unclassified failure |
| `2` | Invocation, option, action-file, or JSON-shape error |
| `3` | `blocked` with no emitted effect |
| `4` | `partial` effect; automatic replay forbidden |
| `5` | `indeterminate` effect; automatic replay forbidden |

## Observation, Archive, and Cleanup State

The [Observation, Archive, and Effect Records Contract](./observation-and-effect-records.md)
defines the exact persisted bindings, quota accounting, transaction recovery, and
journal states behind `observe`, `act`, `history`, `status`, `clear`, and `clearall`.
A blocked archive/evidence condition uses its stable code with exit `3`; malformed
persistent observation or journal state uses exit `1`. A history item removed by
retention or cleanup returns a successful receipt marked `availability: "unavailable"`;
it is never reactivated as evidence.

## Action File and Cleanup

`act` reads exactly one `cu.action/v1` object from a regular action file or stdin (`-`).
It applies the public JSON byte limit before parsing and never treats an action-file
path as a run/archive path. The action file is not an isolation manifest.

`clear` accepts exact UTC RFC3339 timestamps. One timestamp deletes captures strictly
before its end; two delete `start <= capturedAt < end`. `clearall` removes the complete
run archive. Both commands reject a busy run, active effect, or unresolved journal and
cannot erase unknown effect state.

`help` performs no workspace, helper, capture, archive, or input side effect.
`displays` creates no workspace or archive state and performs no capture or input; it
may invoke the capture helper only to prove a stable topology snapshot.
