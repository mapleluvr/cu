# cu Documentation

This documentation describes `cu` as a standalone Windows Computer Use CLI. Start with
the user-facing architecture and command contract, then use the versioned specification
for exact schemas, state transitions, and design decisions.

## Start Here

- [Architecture](design/architecture.md): component boundaries, command lifecycle,
  storage, checkpoints, profiles, and retention.
- [Public CLI Contract](design/cli-contract.md): command syntax, observable behavior,
  help, profiles, and image delivery.
- [v1 Specification](specification/v1/README.md): normative scope and contract index.
- [Publishing and Release Checklist](releasing.md): GitHub source-release and optional
  npm-package preparation gates.

## Normative Contracts

- [`cu.action/v1`](specification/v1/contracts/action-file.md)
- [CLI Receipts](specification/v1/contracts/cli-receipts.md)
- [Action and Evidence](specification/v1/contracts/action-and-evidence.md)
- [Observation, Archive, and Effect Records](specification/v1/contracts/observation-and-effect-records.md)

## Design Decisions

- [Command-Scoped Windows Helper](specification/v1/decisions/001-command-scoped-windows-helper.md)
- [Persisted JSON Control Records](specification/v1/decisions/002-persisted-json-control-records.md)
- [Layered Real E2E Verification](specification/v1/decisions/003-layered-real-e2e-verification.md)
- [Strict Action File and D2 Admission](specification/v1/decisions/004-action-file-d2-admission.md)
- [Transactional Observation Archive and Effect Recovery](specification/v1/decisions/005-transactional-observation-archive.md)
- [Witness-Validated Control-Record Replacement](specification/v1/decisions/006-witness-validated-control-record-replacement.md)

## Project Operations

- [Contributing](../CONTRIBUTING.md)
- [Security Policy](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
- [Publishing and Release Checklist](releasing.md)

## Reading Rules

The public CLI contract defines shell behavior. The versioned contracts define exact
schemas and safety invariants. Decision records explain why the current architecture was
selected. When prose differs, the narrower versioned contract governs its own subject.

Execution logs, local review artifacts, and development workspaces are not part of the
published documentation set.
