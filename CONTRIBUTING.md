# Contributing to cu

`cu` is a preview-stage, safety-sensitive Windows Computer Use CLI. Contributions are
welcome when they preserve its evidence binding, fail-closed behavior, workspace
confinement, and no-replay guarantees.

## Before Opening an Issue

- Search existing issues and the current [changelog](CHANGELOG.md).
- Use a normal issue only for non-sensitive bugs and proposals.
- Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Remove screenshots, typed text, private helper paths, window handles, process IDs,
  access tokens, and personal `.cu/` state from reports.

A useful bug report includes the commit or release, Windows version, Node.js version,
PowerShell version, exact command shape, sanitized JSON receipt, exit code, and a
minimal reproduction in a disposable workspace.

## Development Environment

Required tooling:

- Windows with an interactive `Default` desktop
- Node.js 22.19.0 or newer
- Windows PowerShell 5.1
- npm as supplied with the selected Node.js installation

Set up a checkout:

```powershell
npm ci
npm run typecheck
npm run build
```

Compiled output under `dist/` is generated and ignored. Do not commit it.

## Change Requirements

Keep changes scoped and make protected behavior explicit:

1. Add fail-first coverage for fixes and new behavior.
2. Preserve content-free errors at helper, input, archive, and confinement boundaries.
3. Never persist or echo raw `type_text` content.
4. Keep Computer Use state local to the active workspace.
5. Do not add automatic replay after a partial or indeterminate effect.
6. Update the public CLI contract and the narrower versioned contract when observable
   syntax, receipts, error codes, or durable records change.
7. Record a design decision before changing a protected safety invariant or ownership
   boundary.

Prefer existing parsers, witness APIs, lock capabilities, and archive transactions over
new parallel implementations.

## Testing

The repository test aggregator is an active Windows integration suite, not a
side-effect-free metadata check. It loads PowerShell helper paths and must run only in a
suitable Windows test environment:

```powershell
npm run typecheck
npm run build
npm test
```

Installed-command suites are separate:

```powershell
npm run test:help-status:e2e
npm run test:observe-region:e2e
npm run test:archive-admin:e2e
npm run test:act-controlled:e2e
```

`test:act-controlled:e2e` emits real native input only to its test-owned target/decoy
fixture. Do not direct it at an ordinary application. Tests named `*.live.test.ts` and
unrestricted full-desktop verification require an explicitly authorized isolated
Windows Sandbox or VM unless their own contract states a narrower controlled boundary.

Use temporary workspaces for CLI probes. Do not run `init` or `status` from the source
repository root because ignored repository-local `.cu` state can hide accidental test
pollution.

## Documentation

The documentation hierarchy is:

1. [Public architecture and CLI design](docs/README.md)
2. [v1 scope](docs/specification/v1/scope.md)
3. Narrow versioned contracts under `docs/specification/v1/contracts/`
4. Design decisions under `docs/specification/v1/decisions/`

When documents overlap, the narrower versioned contract governs its subject. Keep
examples copyable and parser-valid.

## Pull Requests

Before opening a pull request:

- keep unrelated formatting and generated output out of the diff;
- run the focused tests for the changed boundary;
- state which live effects, if any, were performed;
- state which checks were not run and why;
- update `CHANGELOG.md` for user-visible changes;
- confirm that no `.cu/`, screenshots, review logs, credentials, or local paths were
  added.

Use concise imperative commit subjects. Existing history commonly uses prefixes such
as `feat:`, `fix:`, `test:`, and `docs:`.

The maintainer may require an independent protected-contract review for archive,
effect-journal, public-contract, security, or concurrency changes.
