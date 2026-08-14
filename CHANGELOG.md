# Changelog

All notable user-visible changes to `cu` are documented here.

The project uses Semantic Versioning. Prerelease versions remain subject to public
contract corrections before stable `v1.0.0`.

## [Unreleased]

No user-visible changes yet.

## [1.0.0-preview.1] - 2026-08-14

First public GitHub prerelease.

### Added

- Standalone Windows CLI commands for workspace initialization, observation, finite
  evidence-bound input, history, status, and transactional archive cleanup.
- Versioned JSON receipts and stable exit-code classes for shell automation.
- Strict `cu.action/v1` admission with bounded pointer, keyboard, chord, text, and
  sequence actions.
- Command-scoped Windows PowerShell helpers for regional capture and native input.
- Immutable capture bundles, current-observation authority, effect journaling,
  checkpoints, no-replay handling, and archive recovery.
- `cu displays` topology inspection and topology-bound `--display` constraints for
  regional observations.
- Public architecture, CLI, versioned contracts, contributing, security, and release
  documentation.

### Security

- Fail-closed admission for locked or unavailable desktops, stale observations,
  uncertain native input, unproven cleanup, malformed records, and confinement
  uncertainty.
- Durable records and public errors exclude raw typed text, private helper paths,
  process identifiers, and window handles.

### Known Limitations

- Unrestricted full-desktop observation has not completed isolated Sandbox/VM release
  acceptance.
- Stale or ownerless run locks are preserved and block; automatic lock reclamation is
  not implemented.
- Power-loss durability is not claimed for the current Windows/Node replacement
  primitive.
- Exact Windows Task View virtual-desktop enumeration and selection are not supported.
- Display IDs identify topology-bound geometric placements, not physical monitor
  devices. Multi-display edge cases are covered by synthetic topology tests, but this
  release host has only one physical display.
- The capable-host file/symlink confinement gate remains incomplete.

[Unreleased]: https://github.com/mapleluvr/cu/compare/v1.0.0-preview.1...HEAD
[1.0.0-preview.1]: https://github.com/mapleluvr/cu/releases/tag/v1.0.0-preview.1
