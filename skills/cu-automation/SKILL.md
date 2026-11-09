---
name: cu-automation
description: Automate Windows desktop and GUI applications via cu CLI with evidence-bound observations and finite action plans. Use for desktop screenshots, clicks, typing, and GUI workflows. In Pi, use codemode to capture and optionally return the screenshot as model-visible image content in one call.
---

# cu Automation

Use `cu` for Windows desktop observation and bounded pointer/keyboard input.

## Pi: choose whether to see the image before running the command

**When `codemode` is available, use it for the visual loop.** Do not default to a
standalone `bash` call followed by another model turn just to read its screenshot.
Before the first visual call, read [Pi codemode recipes](references/pi-codemode.md)
and use its receipt-handling recipe for both `observe` and `act` checkpoints.

Choose the delivery mode yourself from the task; no user confirmation is needed:

| Intent | Delivery | One codemode call |
| --- | --- | --- |
| Locate a control, understand layout, or visually verify a result | `view = "image"` | `bash` → parse receipt → `read` PNG → `image(shot)` |
| Save evidence or pass the image to programmatic processing | `view = "none"` | `bash` → return receipt; omit `image()` |
| Inspect an already captured observation | `view = "image"` | `read` its PNG → `image(shot)`; do not recapture |

`view` is a local recipe variable, **not a cu CLI flag**. A path printed by `bash`
does not show its pixels to the model. Inside codemode, `read()` returns an image
block; only `image(shot)` exposes that block as visual output. Do not print base64
with `text()`, `console.log()`, or `return`.

If the next decision needs visual evidence, choose `image` now. If you chose
`none` and later need to see the capture, read the existing PNG first. An unseen
image does not support guessed coordinates. Capturing still publishes a new
observation and supersedes the previous one, regardless of delivery mode.

If codemode is unavailable, use standalone `bash`, then the host's image-reading
tool when needed. If a call fails or moves to a background task, determine whether
it already executed before continuing. **An image-delivery failure never justifies
replaying `act` or taking another capture automatically.**

## Setup and scope

- Keep one explicit workspace and run ID throughout the task. State lives under
  that workspace's `.cu/`; parent and child directories do not share it.
- Initialize once: `cu init --json`. Use `--json` on every cu command.
- Observe an explicitly chosen region:
  `cu observe work-1 --region pixel:100,100,800,600 --json`.
  The rectangle is left, top, width, height in virtual-screen pixels; replace it
  with the task's actual target bounds.
- Use `cu displays --json` for display geometry and exact IDs. Bind a region with
  `--display <display_id>`, or capture whole displays with
  `--full-screen <display_id[,display_id...]>`. Copy IDs verbatim from `displays`;
  `--full-screen` is mutually exclusive with `--region` and `--display`. A bare
  `observe <run_id>` has no implicit desktop target. Check `cu help observe --json`
  if the installed release's capabilities are uncertain.
- The default observation TTL is 300 seconds. Use
  `--ttl <positive-whole-seconds|unlimited>` to change it; the minimum is `1`.
  `unlimited` records `expiresAt: null`, removing time-based expiry only.
  `observation_expired` is retryable by obtaining a fresh observation and planning
  from it; do not reuse stale coordinates.
- Run IDs use lowercase ASCII letters, digits, dots, underscores, and hyphens;
  empty IDs, `.`, `..`, and path separators are rejected.

## Efficient observe → plan → act loop

1. **Observe and deliver.** In one codemode call, run `observe`, print its compact
   receipt, and optionally show its PNG using the recipe. Retain the returned
   `observationId`, `imagePath`, coordinate space, and expiry.
2. **Plan from the current evidence.** Coordinates are integers `0..999`, relative
   to the observed image, top-left origin. For image pixel `(px, py)` in a `W × H`
   image, use `round(px * 999 / (W - 1))` and `round(py * 999 / (H - 1))` when the
   dimensions exceed one. Never copy screen pixels into an action plan or treat a
   separately cropped preview's coordinates as coordinates of the original image.
3. **Write and execute together.** Once the plan is known, a single codemode call
   can write its UTF-8 JSON action file, await that write, execute `act`, and deliver
   any checkpoint image. Use `tools.write` for JSON rather than shell interpolation;
   do not log typed text. See [action format](references/action-file-spec.md).
4. **Use the result.** A `checkpoint` already contains the next observation and
   PNG: deliver `receipt.checkpoint.imagePath` in the **same** codemode call and
   plan against `receipt.checkpoint.observationId`. Do not add an `observe` merely
   to obtain an image that the checkpoint already captured. A `completed` result
   has no fresh image; observe again only if another action or verification needs it.
   Checkpoints inherit the replaced observation's TTL and capture selection (region
   or full-screen set); coordinates remain relative to the new checkpoint image.
5. **Verify the task result.** Input emission is not proof of application success.
   Inspect the relevant final state; do not add redundant status/history reads
   after a sufficient result. If a checkpoint catches a transitional UI, obtain
   fresh evidence after the expected change before choosing another target.

### Plan only the segment cu can execute

- Prefer a direct `click` over `pointer_move` followed by `click`: both carry
  coordinates, so the second one would be cut off.
- Batch one coordinate action with already-determined text/key actions, such as
  `click → type_text → Enter`. Do not batch across a decision that needs new pixels.
- The second coordinate action checkpoints **before** execution. Drag, wheel,
  every chord, and focus/navigation keys checkpoint **after** execution. The exact
  key list is in [action format](references/action-file-spec.md).
- The unexecuted tail is discarded. Never submit a long speculative plan or replay
  its tail automatically after a checkpoint.
- Serialize desktop operations. Different run IDs do not isolate the physical
  desktop; `Promise.all()` is not appropriate for competing observe/act calls.

## Observation authority and failures

A successful `act` consumes its input observation, whether its outcome is
`completed` or `checkpoint`. Partial or indeterminate effects must not be replayed.
Only the current, unexpired, unconsumed observation can authorize another action;
reading an image does not renew its lifetime or authority.

| Result | Next step |
| --- | --- |
| Exit 0, `checkpoint` | Inspect the returned checkpoint when needed; use its new ID. |
| Exit 0, `completed` | Verify or re-observe if further work needs fresh evidence. |
| Exit 2, invalid action file | No desktop effect. Correct the file; reuse the ID only if still current and valid. |
| Exit 3, blocked | Inspect the error code. Expired/consumed evidence requires observation; `run_busy` requires coordination/status, not a replay loop. |
| Exit 4 or 5, partial/indeterminate | Never replay. Observe the real current state and decide a new plan. |
| Shell background task or missing completion | Follow that task to completion before parsing a receipt or issuing another desktop command. |
| PNG delivery failed after a receipt | Read that same PNG again if available; preserve the action outcome. |

Use `cu status work-1 --json` for diagnosis. History images are diagnostic-only
and cannot authorize input. Use `cu clearall work-1 --json` only when the task is
finished and evidence is no longer needed; it invalidates the current observation.
