# cu.action/v1 Specification & Reference

`cu.action/v1` is an exact-key, strictly validated JSON format for emitting pointer and keyboard operations.

## Root Object Format

```json
{
  "kind": "cu.action/v1",
  "observationId": "obs_0123456789abcdef0123456789abcdef",
  "coordinateSpace": "normalized_999_top_left",
  "actions": []
}
```

- `kind`: must be literal `"cu.action/v1"`.
- `observationId`: copy verbatim from the latest `observe` or `checkpoint` receipt (`obs_` + 32 lowercase hex characters). Never invent or construct IDs.
- `coordinateSpace`: must be literal `"normalized_999_top_left"`.
- `actions`: array of actions (total leaf actions capped at 32; keep plans to 1–2 actions for predictable micro-batching).

Validation rules:
- **Exact keys only**: Any extra or unknown key at any depth rejects the entire file with no desktop effect.
- No duplicate object keys.
- UTF-8 without BOM, max 64KB, max nesting depth 64.

---

## Primary Action Variants

### 1. `click` (Most Common)
```json
{
  "kind": "click",
  "at": { "x": 500, "y": 500 },
  "button": "left",
  "count": 1
}
```
- `at`: required `Point` (`x: 0..999, y: 0..999`).
- `button` (optional): `"left"`, `"middle"`, or `"right"`. Default is `"left"`.
- `count` (optional): `1` (single click) or `2` (double click). Default is `1`.

### 2. `type_text` (Text Input)
```json
{ "kind": "type_text", "text": "user@example.com" }
```
- For plain text, prefer `type_text` over multiple `key` actions.
- Max 2,048 Unicode scalar values (max 8,192 UTF-8 bytes).
- Non-empty; no NUL, C0 controls, or DEL characters.

### 3. `key` (Single Key Press)
```json
{ "kind": "key", "key": "Enter" }
```
- `key`: valid portable key name from the whitelist below.
- *Note*: Focus keys (`Tab`, `Enter`, `Escape`, `Arrow*`) trigger a checkpoint boundary after execution.

### 4. `chord` (Simultaneous Key Combinations)
```json
{ "kind": "chord", "keys": ["Control", "KeyA"] }
```
- 2 to 6 distinct keys.
- **Prohibited chords**: `Control+Alt+Delete` and `Meta+KeyL` are strictly rejected.

### 5. `drag` (Pointer Dragging)
```json
{
  "kind": "drag",
  "from": { "x": 100, "y": 100 },
  "to": { "x": 400, "y": 400 },
  "button": "left",
  "durationMs": 500
}
```
- `from` and `to` points must differ.
- `button` (optional): `"left"` or `"right"`. Default: `"left"`.
- `durationMs` (optional): `100..5000` ms. Default: `500`.
- *Note*: Always triggers a checkpoint boundary after execution.

### 6. `wheel` (Vertical Scroll)
```json
{
  "kind": "wheel",
  "at": { "x": 500, "y": 500 },
  "deltaY": -3
}
```
- `deltaY`: non-zero integer in range `-100..100` (positive = scroll up, negative = scroll down).
- *Note*: Always triggers a checkpoint boundary after execution.

### 7. `pointer_move` (Hover / Reposition)
```json
{ "kind": "pointer_move", "to": { "x": 500, "y": 500 } }
```

---

## Rare Variant: `sequence` (Modifier-Held Actions)

Used rarely, only when holding a modifier (such as Ctrl) during a click or drag:
```json
{
  "kind": "sequence",
  "steps": [
    { "action": { "kind": "key_down", "key": "Control" } },
    { "action": { "kind": "click", "at": { "x": 500, "y": 500 } } },
    { "action": { "kind": "key_up", "key": "Control" } }
  ]
}
```
- Must contain exactly 1 coordinate action (`click`, `drag`, `pointer_move`, `wheel`).
- Modifiers allowed for `key_down`/`key_up`: `"Control"`, `"Alt"`, `"Shift"`.
- **Strict balance**: Every `key_down` must have a matching `key_up` in reverse order. No keys may remain held.

---

## Key Name Whitelist (Common Keys)

> **Important**: Never use lowercase letters (`'a'`) or raw characters (`'1'`). Use the canonical names below.

- **Letters**: `KeyA` through `KeyZ`
- **Digits**: `Digit0` through `Digit9`
- **Common Navigation**: `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`
- **Directional**: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
- **Paging / Bounds**: `Home`, `End`, `PageUp`, `PageDown`, `Insert`
- **Modifiers**: `Shift`, `Control`, `Alt`, `Meta`
- **Function Keys**: `F1` through `F24`
- **Punctuation**: `Semicolon`, `Equal`, `Comma`, `Minus`, `Period`, `Slash`, `Backquote`, `BracketLeft`, `Backslash`, `BracketRight`, `Quote`

*(Run `cu help action-file` in the workspace for the full machine grammar if encountering unlisted keys).*
