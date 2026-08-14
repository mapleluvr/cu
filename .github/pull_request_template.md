## Summary

Describe what changed and why.

## Contract And Safety Impact

- [ ] No public CLI, receipt, error-code, durable-record, or safety-boundary change.
- [ ] Public or versioned contracts were updated for every observable change.
- [ ] Typed text, helper paths, process IDs, window handles, captures, and local `.cu/`
      state are absent from the diff.
- [ ] No automatic replay or unproved-success behavior was introduced.

Explain any unchecked item:

## Verification

List exact commands and results. State which checks were not run and why.

- [ ] Focused fail-first test added or updated.
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Focused automated tests
- [ ] Installed public CLI test, when the public surface changed
- [ ] Controlled native-input test, when input behavior changed
- [ ] Isolated Sandbox/VM test, when full-desktop behavior changed

## Effects Performed

Describe any capture, native input, filesystem cleanup, or external service effect.
Write `None` when the change and verification were read-only.

## Documentation

- [ ] `CHANGELOG.md` updated for user-visible behavior.
- [ ] README/help examples remain copyable and parser-valid.
- [ ] Narrow versioned contracts and design decisions remain authoritative.

## Residual Risk

List remaining blockers, unverified platforms, and deferred follow-ups.
