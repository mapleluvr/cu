# Decision 003: Layered Real E2E Verification

## Context

`cu` can affect a Windows desktop, so unit tests and historical component evidence
cannot prove that the packaged public commands are safely usable. The product boundary
also forbids using the ordinary developer desktop as full-desktop acceptance evidence.

## Decision

Final verification uses an independently installed, compiled `cu` binary invoked from
the shell. It combines pure and filesystem tests with serial live E2E against a
random-token target/decoy fixture on the current Windows desktop. Input results are
proved from exact fixture event streams, with a zero-residue check for helpers,
fixtures, temporary roots, locks, and held input.

Full-desktop observation is a separate required gate in an isolated Windows Sandbox or
VM. The environment shows only synthetic content and proves archive, history, status,
and cleanup behavior for a no-region observation. A normal host reports
`blocked_environment` for that capability.

## Alternatives Considered

- Historical component tests do not exercise the independently installed CLI contract
  or establish current environment safety.
- Manual command demonstrations cannot establish cleanup, no-replay, or adversarial
  failure behavior.

## Consequences

Production helpers contain no test fault switch. Crash/no-replay evidence uses
fixture-owned or derived test processes. An unavailable isolated VM/Sandbox blocks the
final all-commands-E2E claim rather than weakening the full-desktop boundary.
