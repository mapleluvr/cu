<h1 align="center">cu</h1>

<p align="center"><strong>Evidence-bound Computer Use from the Windows command line.</strong></p>

<p align="center">
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4">
  <img alt="Node.js: 22.19 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D22.19-339933">
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-F59E0B">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2F855A">
</p>

<p align="center">
  <a href="#getting-started"><strong>Getting Started</strong></a>
  &middot;
  <a href="#key-features"><strong>Features</strong></a>
  &middot;
  <a href="#command-line"><strong>CLI</strong></a>
  &middot;
  <a href="#safety-model"><strong>Safety</strong></a>
  &middot;
  <a href="docs/README.md"><strong>Documentation</strong></a>
</p>

`cu` captures validated Windows desktop regions, executes finite pointer and keyboard
plans against the latest observation, and records enough durable evidence to distinguish
completed, checkpointed, blocked, partial, and indeterminate outcomes across separate
commands.

There is no required daemon or hidden continuation session. Every stateful command starts
from workspace-local state, proves the authority it needs, performs one bounded
operation, and closes its helper resources before returning. Stateless `displays` and
`help` commands create no workspace state.

> [!IMPORTANT]
> `cu` is a preview and can emit real keyboard and pointer input. Use it only on a
> desktop and applications you are authorized to control. The currently accepted path
> is controlled-region observation and bounded input; unrestricted full-desktop
> observation remains blocked until isolated synthetic-desktop verification is complete.

```powershell
cu init --json
cu displays --json
cu observe work-a --region pixel:100,100,800,600 --json
cu status work-a
cu help action-file
```

The `observe` receipt supplies the `observationId` for the next action file. Coordinates
inside an action file use the normalized `0..999` top-left coordinate space of that
observation:

```json
{
  "kind": "cu.action/v1",
  "observationId": "obs_0123456789abcdef0123456789abcdef",
  "coordinateSpace": "normalized_999_top_left",
  "actions": [
    { "kind": "click", "at": { "x": 500, "y": 500 } }
  ]
}
```

Replace the example observation ID with the value returned by `observe`, then run:

```powershell
cu act work-a --action-file action.json --json
```

## Key Features

- **Evidence-bound input**: only the latest actionable observation can authorize
  coordinates; archived captures remain diagnostic-only.
- **Topology-bound display selection**: enumerate geometric display placements and
  constrain a regional observation to one independently revalidated topology slot.
- **Finite action plans**: exact-key JSON admission, bounded resources, portable key
  vocabulary, prohibited system chords, and balanced input transitions.
- **Deterministic checkpoints**: visual decision boundaries stop the current segment,
  publish a fresh observation, and require the caller to submit a new plan; the
  unexecuted tail is never replayed automatically.
- **No blind replay**: effect intent is journaled before native input; partial or
  indeterminate effects block automatic continuation.
- **Transactional capture archive**: validated PNG/sidecar bundles, create-once
  publication, rollback-before/forward-after recovery, quotas, history, and explicit
  cleanup.
- **Command-scoped Windows helpers**: stock Windows PowerShell 5.1 helpers exist only
  for the command that needs desktop topology, observation, or input.
- **Stable machine output**: versioned JSON receipts, sanitized error envelopes, and
  fixed exit-code meanings for shell automation.

## Requirements

- Windows with an interactive default desktop
- Node.js `22.19.0` or newer
- Windows PowerShell 5.1
- Permission to observe and control the selected desktop content

Locked, secure, unavailable, or elevation-bypass desktops fail closed. `cu` does not
attempt to work around those boundaries.

## Installation

The current public build is a GitHub prerelease and is not published to the npm
registry. Download the exact release artifact and checksum with the GitHub CLI:

```powershell
gh release download v1.0.0-preview.1 --repo mapleluvr/cu --pattern "cu-1.0.0-preview.1.tgz" --pattern "SHA256SUMS.txt"
$checksumLine = Get-Content .\SHA256SUMS.txt | Where-Object { $_ -match "cu-1\.0\.0-preview\.1\.tgz$" }
if ($checksumLine.Count -ne 1) { throw "Release checksum entry missing or ambiguous." }
$expected = ($checksumLine -split "\s+")[0]
$actual = (Get-FileHash .\cu-1.0.0-preview.1.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Release checksum mismatch." }
npm install --global .\cu-1.0.0-preview.1.tgz
cu help
```

The same files are available on the
[`v1.0.0-preview.1` release page](https://github.com/mapleluvr/cu/releases/tag/v1.0.0-preview.1).
To install from an exact source tag instead:

```powershell
git clone --branch v1.0.0-preview.1 --depth 1 https://github.com/mapleluvr/cu.git
cd cu
npm ci
npm run build
npm link
cu help
```

The prerelease supports controlled regional observation and bounded input. Unrestricted
full-desktop observation remains blocked pending isolated Windows Sandbox/VM acceptance.

## Getting Started

Create a separate workspace so all state remains local to that directory:

```powershell
mkdir cu-demo
cd cu-demo
cu init --json
```

Capture a region and inspect the resulting run:

```powershell
cu observe work-a --region pixel:100,100,800,600 --json
cu status work-a
cu history work-a --json
```

To bind that region to the current primary display, derive the opaque display ID from a
fresh topology receipt:

```powershell
$topology = cu displays --json | ConvertFrom-Json
$displayId = ($topology.displays | Where-Object primary).displayId
cu observe work-a --region pixel:100,100,800,600 --display $displayId --json
```

Display IDs identify geometric placements in one exact topology. They are not physical
monitor identities or Windows Task View virtual-desktop IDs.

Adjust the pixel rectangle to the application you intend to control. Use
`cu help action-file` for a parser-validated action example, then submit a finite plan:

```powershell
cu act work-a --action-file action.json --json
```

When retained evidence is no longer needed:

```powershell
cu clearall work-a --json
```

## Command Line

| Command | Purpose |
| --- | --- |
| `cu init [--json]` | Initialize or validate workspace state. |
| `cu displays [--json]` | Inspect stable virtual-screen topology without creating workspace state. |
| `cu observe <run_id> --region <rectangle> [--display <display_id>] [--json]` | Capture and publish one validated regional observation. |
| `cu act <run_id> --action-file <path\|-> [--json]` | Execute one finite evidence-bound action segment. |
| `cu history <run_id> [list] [--json]` | List diagnostic observation history. |
| `cu history <run_id> show <observation_id> [--json]` | Inspect one retained or unavailable history item. |
| `cu status [run_id] [--json]` | Read safe workspace or run status without recovery. |
| `cu clear <run_id> <time_end> [--json]` | Transactionally clear captures before a UTC timestamp. |
| `cu clear <run_id> <time_start> <time_end> [--json]` | Transactionally clear a half-open UTC time range. |
| `cu clearall <run_id> [--json]` | Remove the complete proved archive while preserving the run. |
| `cu help [topic]` | Show command or action-file documentation without state effects. |

Use `--json` for automation. Successful commands emit one versioned receipt on stdout;
expected failures emit one `cu.error/v1` envelope with a stable machine code. See the
[CLI contract](docs/design/cli-contract.md) for exact syntax and receipt behavior.

## Safety Model

`cu` treats uncertainty as state, not as permission to retry:

1. `observe` validates image bytes, metadata, source mapping, environment, and archive
   publication before returning an actionable receipt.
2. `act` revalidates the current observation, environment, run lock, action policy, and
   effect journal before native input.
3. An effect intent becomes durable before input emission.
4. Pre-effect refusals remain blocked; visual boundaries yield a checkpoint; cleanup
   and emitted-action accounting distinguish completed, partial, and indeterminate
   effects.
5. An unresolved journal blocks replay and destructive cleanup until a fresh observation
   establishes a new evidence boundary.

Receipts and durable diagnostics exclude raw typed text, private helper paths, raw
process identifiers, window handles, and application-level success claims. Native input
emission never proves that an application completed a business operation.

## Workspace State

Each working directory owns its own `.cu/` namespace. Runs are not inherited by parent
or child directories.

```text
.cu/
  workspace.json
  work-a/
    run.json
    live-observation.json
    effect-journal.json
    archive-transaction.json
    history.ndjson
    captures/
```

Some files are absent in steady state. Do not edit `.cu/` manually; use `status`,
`history`, `clear`, and `clearall` so witness and transaction checks remain intact.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/design/architecture.md)
- [Public CLI contract](docs/design/cli-contract.md)
- [v1 specification](docs/specification/v1/README.md)
- [`cu.action/v1` contract](docs/specification/v1/contracts/action-file.md)
- [Observation, archive, and effect records](docs/specification/v1/contracts/observation-and-effect-records.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Publishing and release checklist](docs/releasing.md)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) before running helper or live-input tests.

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

Installed-command E2E suites are separate:

```powershell
npm run test:help-status:e2e
npm run test:observe-region:e2e
npm run test:act-controlled:e2e
npm run test:archive-admin:e2e
```

The controlled input suites create their own target/decoy fixture and can emit real
input to that fixture. Unrestricted full-desktop acceptance requires an isolated Windows
Sandbox or VM and is not established by an ordinary developer desktop.

## Security

Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).
Do not open a public issue containing captures, typed text, credentials, private `.cu/`
state, helper paths, process IDs, or window handles.

## Preview Limitations

- Unrestricted full-desktop observation is not yet release-accepted.
- Stale or ownerless run locks are preserved and block rather than being reclaimed.
- Process-interruption recovery is fail-closed; power-loss durability is not claimed.
- A capable Windows host is still required for the final file-symlink confinement gate.
- Display IDs identify topology-bound geometric placements, not physical monitor devices;
  exact Windows Task View virtual-desktop selection is not supported.
- Repository-wide non-live L3 and all four installed-command E2E suites completed for
  this prerelease; those results do not substitute for the blocked environment gates
  above.

## License

Licensed under the [MIT License](LICENSE).
