# Decision 006: Witness-Validated Control-Record Replacement

## Context

Create-once publication is sufficient for immutable records but cannot safely advance
an existing archive transaction, live observation, or effect journal. A pathname
precheck followed by ordinary overwrite could silently replace a substituted,
malformed, or byte-identical old record. The stable regular-file witness binds an
admitted record to its path, direct ancestors, snapshots, and exact bytes, but needs a
narrow replacement discipline before any mutable archive state is implemented.

## Decision

Use an existing-target-only, witness-validated atomic replacement primitive for mutable
JSON control records. Its caller already holds the exclusive run lock for the full
multi-file transaction; the primitive neither acquires nor releases a lock, and it does
not decide record transitions or perform recovery.

Replacement accepts only a current stable witness for the target regular file. It
refuses a missing target; first publication remains the separate create-once protocol.
Candidate staging is a separate private preparation capability bound to the exact target
path and exact ordered direct-ancestor chain. It admits the canonical non-link target
parent, creates an exclusive sibling, fully writes candidate bytes, fsyncs that file,
and re-reads it through bounded descriptor-bound admission for schema validation. Only
after staging completes may the caller admit the old target witness under that same
ancestor chain, so the staging directory entry is already part of the witness ancestor
baseline.

The replacement capability receives that staged capability plus the later target
witness, rejects a different target path or ancestor chain, revalidates the staged
candidate, immediately revalidates the old witness, performs same-directory atomic
replacement, proves the destination is the staged regular file, and re-admits/validates
its bytes. A failed or unprovable post-replacement proof is uncertainty: it never rolls
back, overwrites again, or deletes either candidate.

Temporary cleanup is identity-bound. The primitive removes only a staging entry whose
current regular-file identity still equals the descriptor-backed staging identity it
created. Unknown or stale sibling temporary files are neither authority nor automatic
cleanup candidates.

A successful return proves a process-observable atomic cutover under the Node-only
bounded snapshot model. It does not claim power-loss durability: this host cannot
safely fsync directories through Node on Windows. A process interruption before a
verified return leaves archive state for normal lock-held recovery to prove or block;
it never authorizes automatic replay or destructive cleanup.

Persistent path replacement is rejected by witness and parent checks. The already
accepted Node-only residual remains: a hostile same-user actor can replace and restore
pathnames entirely between snapshots, including between final witness revalidation and
pathname replacement. Eliminating that residual requires a future handle-relative
native mechanism and is not introduced by this decision.

## Alternatives Considered

- Generic replace-or-create weakens the required distinction between immutable first
  publication and advancement of an existing witnessed record.
- Last-writer-wins rename after a pathname existence check silently repairs substituted
  state and loses the admitted predecessor binding.
- Claiming directory-fsync/power-loss durability on Node/Windows would exceed the
  available platform proof.
- Per-record lock acquisition releases protection between transaction steps and cannot
  protect the required multi-file cutover ordering.

## Consequences

Later archive/live/journal orchestration must hold the run lock across staged-candidate
creation, witness read, transition validation, replacement, and dependent decisions. Tests cover missing target
refusal, staged validation, junction/alias confinement, byte-identical old-target
replacement, persistent parent/target replacement, concurrent command behavior,
pre-replacement preservation, identity-safe temporary cleanup, and post-replacement
uncertainty. This decision does not authorize archive mutation, recovery, a public
command, a helper, capture, or native input by itself.
