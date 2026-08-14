# Security Policy

## Supported Versions

`cu` has not published a stable release. Security fixes currently target the latest
maintained `main` branch and the identified preview release.

| Version | Support |
| --- | --- |
| `1.0.0-preview.1` | Best-effort fixes until superseded |
| Unreleased `main` | Best-effort fixes |
| Earlier snapshots | Not supported |

## Reporting a Vulnerability

Do not report a suspected vulnerability in a public issue, discussion, pull request, or
shared capture artifact.

GitHub private vulnerability reporting is the supported reporting channel and a public
launch prerequisite. Before launch, the repository owner must enable it, confirm that
the GitHub API reports it enabled, and make an unauthenticated request to
`/mapleluvr/cu/security/advisories/new`. The request must redirect to sign-in while
preserving that exact path as its return target. After launch, sign in and use
**Security -> Report a vulnerability** for all vulnerability details.

If the control is temporarily unavailable, do not send vulnerability details through a
public issue, discussion, pull request, or unspecified profile contact. Wait until the
maintainer restores the private reporting channel.

Include only the minimum information needed to reproduce the issue:

- affected release or commit;
- Windows, Node.js, and PowerShell versions;
- security impact and required preconditions;
- a minimal reproduction using synthetic content;
- whether observation, native input, archive state, or cleanup was affected;
- sanitized receipts and exit codes.

Do not send real credentials, personal screenshots, raw typed text, private `.cu/`
archives, helper paths, process identifiers, or window handles. Replace them with
synthetic values before submission.

## High-Priority Security Areas

Reports are especially useful when they demonstrate:

- input emitted without a current actionable observation;
- replay after a partial or indeterminate effect;
- input escaping the requested finite action segment;
- workspace, archive, TEMP, symlink, junction, or run-lock confinement failure;
- exposure of typed text or private helper/target data;
- acceptance of a stale or forged observation, display, lock, witness, or action plan;
- cleanup that deletes state not owned by the current command;
- a claimed completed outcome when native input or cleanup was unproven.

## Security Model Boundaries

`cu` is designed to fail closed around stale evidence, unprovable effects, confinement,
and cleanup uncertainty. It is not a prompt-injection detector, authorization service,
malware sandbox, UIAccess boundary, or proof that a fresh action is semantically safe.
Callers remain responsible for deciding what applications and content they are
authorized to control.

Do not run unrestricted full-desktop verification on a personal or ordinary developer
desktop. That gate requires an isolated Windows Sandbox or VM containing only synthetic
content.

## Disclosure and Response

The maintainer will validate scope, coordinate a fix and regression coverage, and agree
on disclosure timing through the private report. No response-time SLA or vulnerability
bounty is currently offered. Public disclosure should wait until affected users have a
reasonable remediation path.
