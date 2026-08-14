# Publishing and Release Checklist

This document separates public GitHub source publication from npm package publication.
They are different release decisions and must not be coupled implicitly.

## Current Readiness Snapshot

Snapshot date: 2026-08-14.

| Area | Current state | Required before public release |
| --- | --- | --- |
| GitHub repository | `mapleluvr/cu` is public; `origin` is restricted to curated `main` | Recheck rendered metadata and links after the tag and release exist |
| License | GitHub detects the committed MIT license | Recheck detection on the release page |
| Public documentation | README, versioned contracts, contributing, security, changelog, release notes, and GitHub community documents are present with final URLs | Recheck rendered links on the final public commit |
| Security reporting | GitHub reports private vulnerability reporting enabled; an unauthenticated request reaches sign-in with the exact advisory/new return path | Recheck the route after the release exists |
| CI | Hosted run `31824689466` passed all steps at `f1506d9` with reviewed Node 24-runtime action SHAs and no annotations | Require a clean hosted run at the exact release commit |
| Branch policy | Public `main` remains unprotected until the final hosted check is known | Add a `main` ruleset requiring that check before tagging |
| Worktree | Curated public-history `main` contains no private-history ancestry; local `NUL` and `docs/reviews/` evidence are ignored and unchanged | Push only curated `main`; never publish the local-only branch, private history bundle, or ignored evidence |
| Final verification | Non-live L3 discovered 503 tests: 502 passed, zero failed, and one file-symlink case was environment-blocked; all four installed-command E2E suites passed | Keep the file-symlink and isolated full-desktop gates explicitly blocked in this preview |
| npm metadata | GitHub URLs and a strict runtime allowlist are present; `private: true` remains set | Keep registry publication out of this release and decide any future scoped npm identity separately |
| npm name | Unscoped `cu` is already occupied on npm | Use a scoped package name for any future npm publication |
| npm payload | A generated 35-file candidate matched the allowlist and passed exact-artifact installation smoke tests | Regenerate once from the final tag commit, verify exact set and SHA-256, and attach only that tarball |

Re-run this audit immediately before release. Do not treat the snapshot as continuing
proof.

## 1. Curate the Source Tree

- [ ] Review every tracked and untracked path with `git status --short`.
- [ ] Do not add `.cu/`, `dist/`, `node_modules/`, screenshots, TEMP artifacts, session
      logs, local review artifacts, or the repository-local `NUL` file.
- [ ] Scan the working tree and Git history for credentials, personal data, private
      paths, raw typed text, and captured desktop content.
- [ ] Confirm `LICENSE`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and
      `CHANGELOG.md` contain no placeholders or private contact data.
- [ ] Decide whether the existing untracked `docs/reviews/` material is public product
      documentation. Keep it untracked if it is only local review evidence.
- [ ] Use one coherent commit series; do not combine generated output or unrelated
      local changes with release documentation.

Recommended secret scanning includes a purpose-built history scanner such as Gitleaks,
not only text search against the current checkout.

## 2. Create and Configure the GitHub Repository

These are operator actions. Review every value before execution; this repository must
not create or publish itself automatically.

- [ ] Choose the final owner and repository name.
- [ ] Create the repository with the intended visibility and no generated README,
      license, or `.gitignore` that would conflict with this checkout.
- [ ] Add the new repository as `origin` and verify both fetch and push URLs.
- [ ] Set a concise description and topics such as `windows`, `cli`, `computer-use`,
      `typescript`, and `automation`.
- [ ] Enable Issues only after the issue forms have been reviewed; keep blank issues
      disabled unless a deliberate alternative intake route is documented.
- [ ] Decide whether to adopt a code of conduct and name a moderation contact before
      actively soliciting outside contributions.
- [ ] Enable private vulnerability reporting under the Security settings, confirm the
      GitHub API reports it enabled, and verify that an unauthenticated request to
      `/OWNER/REPOSITORY/security/advisories/new` redirects to sign-in while preserving
      that exact return path.
- [ ] Set Actions permissions to the least privilege needed by CI.
- [ ] Add branch protection or a ruleset for `main` after required checks exist.
- [ ] Disable unused Wiki, Projects, or Discussions features unless they have an owner.

Example command shape after the owner has been chosen:

```powershell
# Example only. Review OWNER, visibility, and repository name first.
gh repo create OWNER/cu --public --source . --remote origin
```

Do not push until the release tree and history scan have been approved.

## 3. Add CI Before Requiring It

The initial workflow should run on Windows with Node.js 22 and pin third-party actions
to reviewed immutable commit SHAs. Its side-effect-free baseline should perform:

```powershell
npm ci
npm run typecheck
npm run build
node dist/src/cli.js help --json
```

Before making automated tests a required hosted check, add or identify a dedicated
CI-safe test command whose environment and effects are explicit. The current `npm test`
is an active Windows integration suite that loads PowerShell helper paths; it is not a
side-effect-free metadata preflight and may require an interactive desktop. Run it on an
authorized Windows integration host, not blindly on a generic hosted runner.

Keep real native-input and unrestricted full-desktop suites out of ordinary hosted CI.
Controlled-input acceptance belongs in a purpose-built trusted Windows environment.

Use least-privilege workflow permissions, avoid `pull_request_target` for untrusted
code, and do not expose release tokens to forked pull requests.

## 4. Complete the Release Gate

Run from a clean, disposable clone on an authorized Windows test host:

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run test:help-status:e2e`
- [ ] `npm run test:observe-region:e2e`
- [ ] `npm run test:archive-admin:e2e`
- [ ] `npm run test:act-controlled:e2e` against only its target/decoy fixture
- [ ] capable-host file/symlink confinement verification
- [ ] isolated Windows Sandbox/VM full-desktop verification
- [ ] independent review of public contracts and release artifacts
- [ ] `git diff --check` and a clean `git status --short`

A preview release may retain explicit limitations, but it must not convert an unrun or
blocked safety gate into a pass. Record the residual limitation in both release notes
and `CHANGELOG.md`.

## 5. Prepare GitHub Release Metadata

- [ ] Choose the release version, update `package.json` only after scope is fixed, and
      update the supported-version table in `SECURITY.md` before creating the tag.
- [ ] Move the relevant changelog entries from **Unreleased** to a dated version.
- [ ] Replace the README's local-checkout installation text only when a real artifact
      URL or package command exists.
- [ ] Draft release notes that distinguish completed, blocked, and unverified gates.
- [ ] Create a signed or annotated tag from the reviewed release commit.
- [ ] Push the commit and tag, then create a **draft** GitHub release first.
- [ ] Verify source archives and any attached artifacts from a fresh machine.
- [ ] Publish the GitHub release only after artifact hashes and installation steps have
      been checked.

Never move or recreate an already published tag. Publish a corrective patch release
instead.

## 6. Decide npm Publishing Separately

The current package cannot be published as written because it is private, and the
unscoped package name `cu` is already owned by another project. Before npm publishing:

- [ ] Choose a scoped name such as `@OWNER/cu`, or explicitly choose GitHub-only
      distribution.
- [ ] Add final `repository`, `homepage`, and `bugs` URLs.
- [ ] Add a strict `files` allowlist containing only runtime `dist/src/`,
      `dist/helper/`, `README.md`, `LICENSE`, and required package metadata.
- [ ] Exclude tests, source TypeScript, local reviews, fixtures, `.cu/`, and `NUL`.
- [ ] Remove `private: true` only in the reviewed npm-publishing change.
- [ ] Run `npm pack --dry-run --json` and inspect every proposed path.
- [ ] Run `npm pack --json --pack-destination <temporary-directory>` to create the exact
      candidate `.tgz` outside the checkout, then inspect its file list and SHA-256.
- [ ] Install that exact hashed `.tgz` into a new temporary directory and run public CLI
      smoke tests from the installation.
- [ ] Attach or publish only the same reviewed artifact; do not rebuild it after
      verification.
- [ ] Require npm 2FA and use provenance/short-lived credentials where supported.

Do not attach any tarball unless its exact allowlisted manifest, basename-only checksum,
and installed-command smoke results all come from that same artifact.

## 7. Post-Release Checks

- [ ] Verify the GitHub release page, changelog links, license detection, issue forms,
      and security policy rendering.
- [ ] Test documented installation and first-run commands on a clean Windows machine.
- [ ] Confirm the release contains no local paths, captures, `.cu/` state, or secrets.
- [ ] Verify that the pre-tag supported-version update in `SECURITY.md` renders
      correctly.
- [ ] Open follow-up issues for deferred CI, packaging, Sandbox/VM, or confinement work
      rather than weakening the published acceptance claim.
