# `cu.action/v1` Contract

## Status and Scope

This contract defines the exact action-file language consumed by `cu act`. It refines
the examples in the public CLI and Action and Evidence contracts without changing the
helper protocol, observation records, effect journal, policy flow, or native-input
capability.

An action file is untrusted input. Successful admission only establishes a finite
no-effect plan. `act` later separately verifies the live observation, environment,
policy, quota, journal, lock, and cleanup conditions before any native input.

## Transport and JSON Admission

The public `act` command accepts one regular file or standard input (`-`). The
action-file admission core accepts bytes only and has no filesystem or desktop effect.

- The input is at most 65,536 bytes and is valid UTF-8 without a BOM.
- It contains exactly one JSON object with a structural nesting depth of at most 64.
  Duplicate object-member names at every depth are rejected before semantic admission.
- All objects use exact own-key sets. Unknown fields, inherited fields, prototype
  names, non-finite numbers, arrays where objects are required, and trailing non-
  whitespace content are invalid.
- Syntax, decoding, shape, text, coordinate, and key-vocabulary failures use
  `action_file_invalid`; the sanitized message may identify a field path or index but
  never a `type_text` value or a complete input document.
- At this stage every rejection has `effect: none`; the public `act` route maps these
  action-file failures to exit code 2.

## Root Object

The root has exactly these four fields:

```json
{
  "kind": "cu.action/v1",
  "observationId": "obs_example",
  "coordinateSpace": "normalized_999_top_left",
  "actions": []
}
```

`observationId` is an opaque, lowercase ASCII token matching
`^obs_[a-z0-9][a-z0-9_-]{0,95}$`. Its syntax does not authorize input; a later live
observation contract binds the token to the current image and environment evidence.
`coordinateSpace` is always the literal `normalized_999_top_left`. `actions` contains
one or more top-level actions. The total number of leaf actions after expanding each
sequence is at most 32.

A point has exactly `{ "x": integer, "y": integer }`, where each component is in
`0..999`. Coordinates are observation-local and use a top-left origin.

## Top-Level Action Variants

Every action has a `kind` field and exactly the fields described below.

| Kind | Shape and normalization |
| --- | --- |
| `pointer_move` | `{ "kind": "pointer_move", "to": Point }` |
| `click` | `{ "kind": "click", "at": Point, "button"?: "left"|"middle"|"right", "count"?: 1|2 }`; omitted values normalize to `left` and `1`. |
| `drag` | `{ "kind": "drag", "from": Point, "to": Point, "button"?: "left"|"right", "durationMs"?: integer }`; points must differ, defaults are `left` and `500`, duration is `100..5000` milliseconds, and deterministic interpolation is capped at 120 batches. A drag has no externally held button after it ends. |
| `wheel` | `{ "kind": "wheel", "at": Point, "deltaY": integer }`; `deltaY` is nonzero and in `-100..100` vertical detents. Horizontal wheel is not v1 action language. |
| `key` | `{ "kind": "key", "key": Key }` |
| `type_text` | `{ "kind": "type_text", "text": string }` |
| `chord` | `{ "kind": "chord", "keys": Key[] }` with 2..6 distinct keys. Input order is normalized to modifier order then lexical order. |
| `sequence` | The constrained form defined below. It cannot be nested. |

`type_text` is nonempty, has no NUL, C0 control, DEL, or unpaired UTF-16 surrogate,
and is bounded by 2,048 Unicode scalars, 4,096 UTF-16 units, and 8,192 UTF-8 bytes.
Raw typed text is never included in receipts, history, status, error messages, journals,
or durable diagnostics.

## Key Vocabulary and Chords

`Key` is one of the following portable tokens, never a Windows virtual-key number or a
layout alias:

- `KeyA` through `KeyZ`; `Digit0` through `Digit9`; `Numpad0` through `Numpad9`;
- `F1` through `F24`;
- `Shift`, `Control`, `Alt`, `Meta`;
- `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`, `Insert`, `Home`, `End`,
  `PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`;
- `CapsLock`, `NumLock`, `ScrollLock`, `PrintScreen`, `Pause`, `ContextMenu`;
- `Semicolon`, `Equal`, `Comma`, `Minus`, `Period`, `Slash`, `Backquote`,
  `BracketLeft`, `Backslash`, `BracketRight`, `Quote`;
- `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal`,
  `NumpadEnter`.

The canonical modifier order is `Control`, `Alt`, `Shift`, `Meta`; non-modifier tokens
then sort by ASCII lexical order. This produces a stable action digest without changing
what a client is permitted to submit.

In v1, `chord` is the only action that can represent a multi-key chord: transition
sequences do not contain `key` presses and exist only for modifier-qualified pointer
cleanup. Every `chord` containing either hard system pattern is rejected with
`action_prohibited`: `Control+Alt+Delete` and `Meta+KeyL`. Other window-management or
system chords are preserved for the later profile/policy gate; their syntactic admission
never bypasses that later gate.

## Constrained Sequences

A `sequence` has exactly `{ "kind": "sequence", "steps": Step[] }`; it has 1..32
steps and cannot contain a `sequence` action. A step has exactly
`{ "action": SequenceLeaf, "delayAfterMs"?: integer }`. An omitted delay normalizes
to zero; an explicit delay is `0..5000` milliseconds; total declared delay over the
whole submitted action file is at most 30,000 milliseconds.

A sequence is deliberately not a general macro language. It exists only for one
modifier-qualified coordinate action and cleanup:

1. It contains exactly one coordinate action: `pointer_move`, `click`, `drag`,
   `wheel`, or `button_down`.
2. Before that coordinate action it may contain only `key_down` for distinct modifier
   keys (`Control`, `Alt`, or `Shift`).
3. After it, it may contain only matching `key_up` and, where applicable, matching
   `button_up` cleanup actions.
4. `key_down`/`key_up` and `button_down`/`button_up` are legal only in a sequence and
   must form a balanced LIFO hold ledger. No key or button remains held at sequence or
   command end.
5. `key_down` has exactly `{ "kind": "key_down", "key": Modifier }`; `key_up`
   has exactly `{ "kind": "key_up", "key": Modifier }`; `Modifier` is one of
   `Control`, `Alt`, or `Shift`. A `key_down` has no default; its matching `key_up`
   uses the same token. `Meta` and every non-modifier key are invalid transition keys in
   v1.
6. `button_down` is coordinate-bearing and requires `{ "kind": "button_down",
   "button": "left"|"middle"|"right", "at": Point }`; `button_up` has exactly
   `{ "kind": "button_up", "button": "left"|"middle"|"right" }`.
7. A `button_down` must have its matching `button_up` in the same sequence. Complete
   drags use the top-level `drag` action instead of manually held motion.

Malformed transition shapes, unknown fields, or a non-modifier transition key are
`action_file_invalid`; duplicate downs, unmatched ups, incorrect LIFO release order,
or a nonempty final hold ledger are `action_unbalanced`.

## Resource and Semantic Rejection

The parser rejects a plan before effects with these stable codes:

| Code | Meaning |
| --- | --- |
| `action_file_invalid` | Invalid bytes/JSON, duplicate keys, wrong exact shape, invalid point/key/text, unsupported action form, or invalid observation syntax. |
| `action_file_too_large` | The input exceeds 65,536 bytes before parsing. |
| `action_limit_exceeded` | More than 32 leaf actions, excessive delay, text, drag, chord, or wheel resource use. |
| `action_unbalanced` | Invalid transition hold ledger. |
| `action_prohibited` | A hard-prohibited system chord is represented. |

The parser's normalized result contains accounting and boundary-relevant action classes,
but no durable text diagnostic.

## D2 Boundary Classification

D2 operates over normalized top-level actions. A constrained sequence is indivisible so
that cleanup stays in the same emitted segment. The segmenter returns the longest safe
prefix and a terminal decision:

- A plan with no boundary returns `completed`.
- A second coordinate action produces `checkpoint` **before** that second action. A
  constrained sequence contributes exactly one coordinate action: its sole coordinate
  leaf. If one coordinate action has already been included, the segmenter checkpoints
  before the entire indivisible sequence; it never splits transition cleanup from that
  sequence. A `pointer_move` is coordinate-bearing, so a client should submit `click`
  directly instead of move-then-click when both depend on one observation.
- `drag` and `wheel` produce `checkpoint` **after** their complete action or sequence,
  including required transition cleanup.
- A `key` action using `Enter`, `NumpadEnter`, `Tab`, `Escape`, `ContextMenu`,
  `Insert`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, an arrow key, or any
  `F1..F24` produces `checkpoint` after that action. A `chord` produces `checkpoint`
  after the chord. A v1 sequence contains no focus key; its terminal class derives from
  its single coordinate leaf, and a drag/wheel sequence checkpoints after cleanup.
- `click -> type_text -> key(Enter)` is therefore a valid emitted prefix whose
  terminal decision is `checkpoint`; later submitted actions are not emitted.
- Checkpoint capture, live-observation replacement, receipt construction, and
  unexecuted-tail disposal belong to `act` orchestration. The classifier itself has no
  capture, persistence, helper, or input effect.

## Admission Boundary

Action-byte parsing, normalization, hard-chord classification, and D2 segmentation are
pure operations. The admission module does not read action paths, acquire a run lock,
write state, invoke PowerShell, capture the desktop, or inject input. The public `act`
route composes that admitted plan with separate live-observation, environment, lock,
effect-journal, and cleanup checks.
