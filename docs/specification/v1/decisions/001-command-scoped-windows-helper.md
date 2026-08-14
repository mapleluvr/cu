# Decision 001: Command-Scoped Windows Helper

## Context

`cu` must observe and emit bounded Windows pointer and keyboard effects without an
installed native addon, required daemon, or durable agent-facing session. Separate `observe`
and `act` commands must not leave a helper, held input, or cleanup obligation behind.

## Decision

Use a stock Windows PowerShell 5.1 helper with embedded C# P/Invoke for Windows-only
observation and input. The Node CLI starts a helper only for the command that needs it,
uses a private versioned protocol, validates every response, then terminates the helper
and releases command-owned resources.

The helper is an untrusted boundary with no authority to write workspace control
records. The CLI owns archive installation, live-observation replacement, effect
journaling, result receipts, and final cleanup classification.

## Alternatives Considered

- A persistent daemon would reduce startup cost but creates cross-command state,
  liveness, and recovery obligations prohibited by the product design.
- A native Node addon would require a Windows compilation and binary distribution
  supply chain inconsistent with the no-extra-installation direction.

## Consequences

Helper startup and protocol validation are part of every relevant command's budget and
E2E acceptance. A helper crash or malformed response is a truthful blocked, partial, or
indeterminate outcome, never a reason to silently retry input. The helper protocol is
private and may change only with coordinated CLI/adapter tests; public `cu` receipts
remain the stable interface.
