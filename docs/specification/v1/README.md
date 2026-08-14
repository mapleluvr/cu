# cu v1 Specification

This directory contains the normative scope, public schemas, persisted-state contracts,
and design decisions for the first standalone `cu` release. It describes observable
behavior and protected safety boundaries, not an execution plan or development log.

## Document Order

1. [Architecture](../../design/architecture.md) explains the product structure.
2. [Public CLI Contract](../../design/cli-contract.md) defines shell-visible commands.
3. [v1 Scope](./scope.md) fixes acceptance, constraints, non-goals, and protected
   invariants.
4. Contracts in [`contracts/`](./contracts/) define exact schemas and state behavior.
5. Decisions in [`decisions/`](./decisions/) explain the selected runtime, storage,
   verification, and action-admission approaches.

When documents overlap, the narrower versioned contract governs its own subject. A
schema or compatibility change requires a versioned contract update and regression
coverage.

## Scope

- [v1 Scope](./scope.md)

## Contracts

- [CLI Receipts](./contracts/cli-receipts.md)
- [Action and Evidence](./contracts/action-and-evidence.md)
- [Observation, Archive, and Effect Records](./contracts/observation-and-effect-records.md)
- [`cu.action/v1` Action File](./contracts/action-file.md)

## Decisions

- [001: Command-Scoped Windows Helper](./decisions/001-command-scoped-windows-helper.md)
- [002: Persisted JSON Control Records](./decisions/002-persisted-json-control-records.md)
- [003: Layered Real E2E Verification](./decisions/003-layered-real-e2e-verification.md)
- [004: Strict Action File and D2 Admission](./decisions/004-action-file-d2-admission.md)
- [005: Transactional Observation Archive and Effect Recovery](./decisions/005-transactional-observation-archive.md)
- [006: Witness-Validated Control-Record Replacement](./decisions/006-witness-validated-control-record-replacement.md)
