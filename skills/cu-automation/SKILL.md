---
name: cu-automation
description: Automate Windows desktop and GUI applications via cu CLI using evidence-bound observations and finite action plans. Use when controlling desktop apps, clicking UI elements, typing into Windows windows, or automating desktop workflows.
---

# cu Automation Skill

Automate Windows GUI tasks safely using the `cu` CLI. `cu` is an evidence-bound computer-use interface that executes finite pointer and keyboard plans against fresh desktop observations.

## Core Rules & Invariants

1. **Strict Evidence-Bound Authority (Single-Use Lifecycle)**:
   - Input requires an active, unconsumed `observationId`.
   - **One observation = exactly one `act`**: Any `act` command (whether `completed` or `checkpoint`) immediately consumes that `observationId`.
   - Never reuse an `observationId`. For the next action, either use the new `checkpoint.observationId` returned in the receipt, or run `cu observe` again.
2. **Normalized Coordinates (`0..999`)**:
   - Coordinates (`{"x": 0..999, "y": 0..999}`) are relative to the *observed image crop*, with origin `(0,0)` at the top-left and `(999,999)` at the bottom-right. Never use physical screen pixels in action files.
3. **Always Pass `--json`**:
   - All commands must include `--json` for predictable, parseable machine receipts.
4. **Automatic Checkpoint Segmentation**:
   - `cu` automatically ends an action segment at visual decision boundaries (before a second coordinate action, or after `drag`, `wheel`, focus keys like `Tab`/`Enter`/arrows, or `chord`).
   - When a boundary is hit, `cu` executes only the safe prefix, captures a new observation, and returns `outcome: "checkpoint"`. **The unexecuted trailing actions are discarded and never run automatically.**
5. **No Blind Replay**:
   - On exit 4 (`partial`) or exit 5 (`indeterminate`), never replay the old plan. Run `cu observe` anew to inspect the real desktop state before deciding the next step.
6. **Workspace Directory Stickiness & Run IDs**:
   - All state is stored locally under `.cu/` in the current working directory. Keep your shell cwd consistent.
   - `run_id` must use lowercase ASCII letters, digits, dots, underscores, and hyphens (`[a-z0-9._-]+`), e.g., `work-1`.

---

## Standard Loop (Observe -> Inspect -> Plan -> Act -> Verify)

```
[cu init] -> [cu observe] -> [Inspect PNG] -> [Write action.json] -> [cu act] -> [Check Outcome / Loop]
```

### Step 1: Initialize Workspace (Once per task)
```powershell
cu init --json
```

### Step 2: Observe Target Region
`cu` requires an explicit capture selector — either a region or one or more whole displays. There is no implicit current-desktop target.

Region capture syntax: `--region pixel:<left>,<top>,<width>,<height>` (L, T, W, H):
```powershell
cu observe work-1 --region pixel:100,100,1200,800 --json
```

Full-screen capture syntax: `--full-screen <display_id[,display_id...]>`, mutually exclusive with `--region`/`--display`. Copy the display IDs verbatim from `cu displays --json` (comma-separated for multiple screens, e.g. `dsp_0123456789abcdef0123456789abcdef`):
```powershell
cu displays --json
cu observe work-1 --full-screen dsp_0123456789abcdef0123456789abcdef --json
```

*(Optional: Run `cu displays --json` for multi-monitor topology inspection or `--display <display_id>` region binding).*

Receipt:
```json
{
  "kind": "cu.observe.result/v1",
  "runId": "work-1",
  "observationId": "obs_0123456789abcdef0123456789abcdef",
  "imagePath": ".cu/work-1/captures/obs_0123456789abcdef0123456789abcdef.png",
  "coordinateSpace": "normalized_999_top_left",
  "expiresAt": "2026-07-23T00:05:00.000Z",
  "actionable": true
}
```
*Note*: Observations expire after 300 seconds by default (`expiresAt`). To change the lifetime, pass `--ttl <positive-whole-seconds|unlimited>` (minimum `1`; `unlimited` records `expiresAt: null`, so the observation never expires by time):
```powershell
cu observe work-1 --region pixel:100,100,1200,800 --ttl 60 --json
```
A checkpoint observation inherits the TTL of the observation it replaced. Act within the window, or re-run `observe` if expired — `observation_expired` receipts carry `retryable: true`, and retrying with a fresh observation is the intended recovery.

### Step 3: Inspect the Screenshot & Locate Coordinates
Inspect `imagePath` using your image inspection tool. Calculate target coordinates directly from this image:
- Top-left: `{"x": 0, "y": 0}`
- Center: `{"x": 500, "y": 500}`
- Bottom-right: `{"x": 999, "y": 999}`

### Step 4: Plan & Execute Actions
Write the plan to a UTF-8 (no BOM) JSON file, then execute:
```json
// action.json
{
  "kind": "cu.action/v1",
  "observationId": "obs_0123456789abcdef0123456789abcdef",
  "coordinateSpace": "normalized_999_top_left",
  "actions": [
    { "kind": "click", "at": { "x": 450, "y": 320 } },
    { "kind": "type_text", "text": "Hello World" }
  ]
}
```
```powershell
cu act work-1 --action-file action.json --json
```

> **Best Practice**: Keep plans micro-batched (1 coordinate action + subsequent text/key). Because a second click or a focus key cuts a checkpoint and discards trailing actions, planning one interaction at a time prevents discarded steps.

### Step 5: Check Outcome & Branch

Read the JSON result:
- **`outcome: "completed"`**: All actions executed. Re-observe if further actions are needed.
- **`outcome: "checkpoint"`**: Truncated at a boundary. Receipt contains:
  ```json
  {
    "kind": "cu.act.result/v1",
    "outcome": "checkpoint",
    "checkpoint": {
      "observationId": "obs_fedcba9876543210fedcba9876543210",
      "imagePath": ".cu/work-1/captures/obs_fedcba9876543210fedcba9876543210.png",
      "actionable": true
    }
  }
  ```
  **Use `checkpoint.observationId` and inspect `checkpoint.imagePath` for your next plan.** Do not replay the old plan. The checkpoint observation inherits the replaced observation's TTL and capture selection (region rectangle or full-screen set), so coordinates stay relative to `checkpoint.imagePath` in the same `0..999` space.

---

## Exit Code & Failure Recovery Matrix

| Exit Code | Classification | What Happened | Action to Take |
| :---: | :--- | :--- | :--- |
| **0** | Success / Checkpoint | Execution succeeded or reached a clean checkpoint. | Proceed to next step, or consume `checkpoint.observationId`. |
| **2** | Action File Error | Bad JSON, unrecognized keys, invalid key names, or coordinates out of range. | No desktop effect. Fix `action.json` syntax and retry with the **same** `observationId`. |
| **3** | Blocked | Action blocked before any input was emitted (e.g. `observation_expired`, `observation_consumed`, `run_busy`). | Inspect error receipt `retryable` field. If `retryable: true`, run `cu observe` again and retry with the new `observationId`. If `run_busy`, check `cu status work-1 --json`. |
| **4** | Partial Effect | Some input was emitted, but execution was interrupted or could not be proven. | **DO NOT replay the plan.** Run `cu observe` to inspect current desktop state. |
| **5** | Indeterminate | State could not be proven after input emission. | **DO NOT replay the plan.** Run `cu observe` to inspect current desktop state. |

---

## Diagnosis & Cleanup

- **Diagnose run state**: Run `cu status work-1 --json` to inspect lifecycle, locks, and active observation validity without side effects.
- **Cleanup when task is complete**: Captures consume quota in `.cu/<run_id>/captures/`. Run `cu clearall work-1 --json` only after the entire task is finished (it invalidates the current live observation).

For the action file JSON schema and key whitelist, see:
- [references/action-file-spec.md](references/action-file-spec.md)
