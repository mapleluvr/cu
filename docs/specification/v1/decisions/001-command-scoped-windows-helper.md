# Decision 001: Command-Scoped Windows Helper

## Context

`cu` must observe and emit bounded Windows pointer and keyboard effects without an
installed native addon, required daemon, or durable agent-facing session. Separate `observe`
and `act` commands must not leave a helper, held input, or cleanup obligation behind.

## Decision

Use a bundled native C++ executable (`cu-capture.exe`) for Windows observation and
display queries. Input retains stock Windows PowerShell 5.1 with embedded C# P/Invoke.
The Node CLI starts a helper only for the command that needs it, uses a private
versioned protocol, validates every response, then releases command-owned resources.
Capture never falls back to another runtime after an executable failure.

The helper is an untrusted boundary with no authority to write workspace control
records. The CLI owns archive installation, live-observation replacement, effect
journaling, result receipts, and final cleanup classification.

## Alternatives Considered

- A persistent daemon would reduce startup cost but creates cross-command state,
  liveness, and recovery obligations prohibited by the product design.
- A native Node addon would move desktop calls and native failures into the CLI
  process. The standalone EXE keeps the existing process/protocol isolation.
- C# EXE, native EXE, and PowerShell variants were measured; native capture removes
  both the PowerShell and CLR startup layers without requiring a daemon.

## 2026-11-09: Capture Initialization Refinement

Phase profiling identified per-command C# compilation as avoidable capture overhead.
Capture initially emitted equivalent P/Invoke declarations in the helper's CLR, retaining
Winapi calling convention, Unicode desktop-name marshaling, SetLastError and
PreserveSig. Desktop/session admission, DPI awareness, pre/post environment checks,
PNG validation, transactional publication and command cleanup are unchanged.

This refinement adds no precompiled binary, native addon, durable cache or helper
session. Input remains unchanged. A runtime-compilation-unavailable regression test
checks real owned-window pixels, and alternating baseline/candidate benchmarks
measure the complete observe path; see the
[hill-climb record](../../../research/observe-latency-hillclimb.md).

## 2026-11-09: Native Capture Endpoint

The operator explicitly permits a native rewrite and prioritizes retained functionality
and measured performance over rewrite effort. The capture endpoint is now native code:
Win32 session/desktop/topology queries, GDI pixels, GDI+ PNG, BCrypt SHA-256, strict
bounded UTF-8 JSON, CreateNew output, flush/readback and pre/post environment comparison.
The protocol, Node validation, archive ownership and evidence boundary remain intact.

Failed output is deleted using the owned open file handle. The helper retains no desktop
state across commands. The PowerShell capture source stays as a development comparison
reference; it is not a production fallback or a packaged runtime dependency.

Source builds need a Windows C++ toolchain. Packages include the compiled executable
and the JSON library's MIT notice; consumers install no compiler, CLR component, or
new runtime for capture. Input still needs Windows PowerShell. Performance and verification
are recorded in the [native capture experiment](../../../research/observe-native-helper.md).

## Consequences

Helper startup and protocol validation are part of every relevant command's budget and
E2E acceptance. A helper crash or malformed response is a truthful blocked, partial, or
indeterminate outcome, never a reason to silently retry input. The helper protocol is
private and may change only with coordinated CLI/adapter tests; public `cu` receipts
remain the stable interface.
