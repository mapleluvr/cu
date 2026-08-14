import { parseStrictJsonBytes, type StrictJsonValue } from "./strict-json.js";

const MAX_ACTION_FILE_BYTES = 65_536;
const MAX_JSON_DEPTH = 64;
const MAX_LEAF_ACTIONS = 32;
const MAX_SEQUENCE_STEPS = 32;
const MAX_STEP_DELAY_MS = 5_000;
const MAX_TOTAL_DELAY_MS = 30_000;
const MAX_TEXT_SCALARS = 2_048;
const MAX_TEXT_UTF16_UNITS = 4_096;
const MAX_TEXT_UTF8_BYTES = 8_192;

const modifiers = ["Control", "Alt", "Shift", "Meta"] as const;
const transitionModifiers = ["Control", "Alt", "Shift"] as const;
const pointerButtons = ["left", "middle", "right"] as const;
const dragButtons = ["left", "right"] as const;
const namedKeys = new Set<string>([
  ...modifiers,
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
  "Pause",
  "ContextMenu",
  "Semicolon",
  "Equal",
  "Comma",
  "Minus",
  "Period",
  "Slash",
  "Backquote",
  "BracketLeft",
  "Backslash",
  "BracketRight",
  "Quote",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter"
]);
const focusKeys = new Set<string>([
  "Enter",
  "NumpadEnter",
  "Tab",
  "Escape",
  "ContextMenu",
  "Insert",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight"
]);

type ActionFailureCode =
  | "action_file_invalid"
  | "action_file_too_large"
  | "action_limit_exceeded"
  | "action_unbalanced"
  | "action_prohibited";

type Modifier = (typeof transitionModifiers)[number];
type PointerButton = (typeof pointerButtons)[number];
type DragButton = (typeof dragButtons)[number];
type CoordinateKind = "pointer_move" | "click" | "drag" | "wheel" | "button_down";
type D2Reason = "second_coordinate" | "drag" | "wheel" | "focus_key" | "chord";

export type Point = {
  x: number;
  y: number;
};

type PointerMoveAction = {
  kind: "pointer_move";
  to: Point;
};

type ClickAction = {
  kind: "click";
  at: Point;
  button: PointerButton;
  count: 1 | 2;
};

type DragAction = {
  kind: "drag";
  from: Point;
  to: Point;
  button: DragButton;
  durationMs: number;
};

type WheelAction = {
  kind: "wheel";
  at: Point;
  deltaY: number;
};

type KeyAction = {
  kind: "key";
  key: string;
};

type TypeTextAction = {
  kind: "type_text";
  text: string;
};

type ChordAction = {
  kind: "chord";
  keys: string[];
};

type KeyDownAction = {
  kind: "key_down";
  key: Modifier;
};

type KeyUpAction = {
  kind: "key_up";
  key: Modifier;
};

type ButtonDownAction = {
  kind: "button_down";
  button: PointerButton;
  at: Point;
};

type ButtonUpAction = {
  kind: "button_up";
  button: PointerButton;
};

type NormalizedSequenceLeaf =
  | PointerMoveAction
  | ClickAction
  | DragAction
  | WheelAction
  | KeyDownAction
  | KeyUpAction
  | ButtonDownAction
  | ButtonUpAction;

type SequenceAction = {
  kind: "sequence";
  coordinateKind: CoordinateKind;
  steps: Array<{
    action: NormalizedSequenceLeaf;
    delayAfterMs: number;
  }>;
};

export type NormalizedAction =
  | PointerMoveAction
  | ClickAction
  | DragAction
  | WheelAction
  | KeyAction
  | TypeTextAction
  | ChordAction
  | SequenceAction;

export type NormalizedActionPlan = {
  observationId: string;
  coordinateSpace: "normalized_999_top_left";
  actions: NormalizedAction[];
  leafCount: number;
  totalDelayMs: number;
};

export type ActionAdmissionSuccess = {
  ok: true;
  plan: NormalizedActionPlan;
};

export type ActionAdmissionFailure = {
  ok: false;
  error: {
    code: ActionFailureCode;
    message: string;
    effect: "none";
  };
};

export type ActionAdmissionResult =
  | ActionAdmissionSuccess
  | ActionAdmissionFailure;

const admittedActionPlans = new WeakSet<NormalizedActionPlan>();

function deepFreezeNormalizedValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepFreezeNormalizedValue(child);
  }
  Object.freeze(value);
}

export function isAdmittedActionPlan(value: unknown): value is NormalizedActionPlan {
  return value !== null && typeof value === "object" && admittedActionPlans.has(value as NormalizedActionPlan);
}

export type D2Segment =
  | {
      outcome: "completed";
      prefixLength: number;
    }
  | {
      outcome: "checkpoint";
      prefixLength: number;
      reason: D2Reason;
    };

class ActionAdmissionViolation extends Error {
  public constructor(public readonly code: ActionFailureCode) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    reject("action_file_invalid");
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    reject("action_file_invalid");
  }
  return value;
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    reject("action_file_invalid");
  }
  return value;
}

function reject(code: ActionFailureCode): never {
  throw new ActionAdmissionViolation(code);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
  return values.includes(value as T);
}

function isFunctionKey(value: string): boolean {
  return /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(value);
}

function isPortableKey(value: string): boolean {
  return (
    namedKeys.has(value) ||
    /^Key[A-Z]$/.test(value) ||
    /^Digit[0-9]$/.test(value) ||
    /^Numpad[0-9]$/.test(value) ||
    isFunctionKey(value)
  );
}

function isFocusKey(value: string): boolean {
  return focusKeys.has(value) || isFunctionKey(value);
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftModifier = modifiers.indexOf(left as (typeof modifiers)[number]);
  const rightModifier = modifiers.indexOf(right as (typeof modifiers)[number]);
  if (leftModifier !== -1 || rightModifier !== -1) {
    if (leftModifier === -1) return 1;
    if (rightModifier === -1) return -1;
    return leftModifier - rightModifier;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasAllKeys(keys: readonly string[], required: readonly string[]): boolean {
  return required.every((key) => keys.includes(key));
}

function normalizePoint(value: unknown): Point {
  const point = requireRecord(value);
  if (!hasKeys(point, ["x", "y"])) {
    reject("action_file_invalid");
  }
  const x = requireInteger(point.x);
  const y = requireInteger(point.y);
  if (x < 0 || x > 999 || y < 0 || y > 999) {
    reject("action_file_invalid");
  }
  return { x, y };
}

function normalizePointerButton(value: unknown): PointerButton {
  const button = requireString(value);
  if (!isOneOf(button, pointerButtons)) {
    reject("action_file_invalid");
  }
  return button;
}

function normalizeDragButton(value: unknown): DragButton {
  const button = requireString(value);
  if (!isOneOf(button, dragButtons)) {
    reject("action_file_invalid");
  }
  return button;
}

function normalizeClick(record: Record<string, unknown>): ClickAction {
  if (!hasKeys(record, ["kind", "at"], ["button", "count"])) {
    reject("action_file_invalid");
  }
  const button = Object.hasOwn(record, "button")
    ? normalizePointerButton(record.button)
    : "left";
  const count = Object.hasOwn(record, "count") ? requireInteger(record.count) : 1;
  if (count !== 1 && count !== 2) {
    reject("action_file_invalid");
  }
  return { kind: "click", at: normalizePoint(record.at), button, count };
}

function normalizePointerMove(record: Record<string, unknown>): PointerMoveAction {
  if (!hasKeys(record, ["kind", "to"])) {
    reject("action_file_invalid");
  }
  return { kind: "pointer_move", to: normalizePoint(record.to) };
}

function normalizeDrag(record: Record<string, unknown>): DragAction {
  if (!hasKeys(record, ["kind", "from", "to"], ["button", "durationMs"])) {
    reject("action_file_invalid");
  }
  const from = normalizePoint(record.from);
  const to = normalizePoint(record.to);
  if (from.x === to.x && from.y === to.y) {
    reject("action_file_invalid");
  }
  const button = Object.hasOwn(record, "button")
    ? normalizeDragButton(record.button)
    : "left";
  const durationMs = Object.hasOwn(record, "durationMs") ? requireInteger(record.durationMs) : 500;
  if (durationMs < 100 || durationMs > 5_000) {
    reject("action_limit_exceeded");
  }
  return { kind: "drag", from, to, button, durationMs };
}

function normalizeWheel(record: Record<string, unknown>): WheelAction {
  if (!hasKeys(record, ["kind", "at", "deltaY"])) {
    reject("action_file_invalid");
  }
  const deltaY = requireInteger(record.deltaY);
  if (deltaY === 0) {
    reject("action_file_invalid");
  }
  if (deltaY < -100 || deltaY > 100) {
    reject("action_limit_exceeded");
  }
  return { kind: "wheel", at: normalizePoint(record.at), deltaY };
}

function normalizeKey(record: Record<string, unknown>): KeyAction {
  if (!hasKeys(record, ["kind", "key"])) {
    reject("action_file_invalid");
  }
  const key = requireString(record.key);
  if (!isPortableKey(key)) {
    reject("action_file_invalid");
  }
  return { kind: "key", key };
}

function validateText(text: string): void {
  if (text.length === 0) {
    reject("action_file_invalid");
  }
  if (text.length > MAX_TEXT_UTF16_UNITS) {
    reject("action_limit_exceeded");
  }

  let scalars = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      reject("action_file_invalid");
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        reject("action_file_invalid");
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      reject("action_file_invalid");
    }
    scalars++;
  }
  if (scalars > MAX_TEXT_SCALARS || new TextEncoder().encode(text).byteLength > MAX_TEXT_UTF8_BYTES) {
    reject("action_limit_exceeded");
  }
}

function normalizeTypeText(record: Record<string, unknown>): TypeTextAction {
  if (!hasKeys(record, ["kind", "text"])) {
    reject("action_file_invalid");
  }
  const text = requireString(record.text);
  validateText(text);
  return { kind: "type_text", text };
}

function normalizeChord(record: Record<string, unknown>): ChordAction {
  if (!hasKeys(record, ["kind", "keys"]) || !Array.isArray(record.keys)) {
    reject("action_file_invalid");
  }
  const rawKeys = record.keys;
  if (rawKeys.length < 2) {
    reject("action_file_invalid");
  }
  if (rawKeys.length > 6) {
    reject("action_limit_exceeded");
  }
  const keys = rawKeys.map((value) => {
    const key = requireString(value);
    if (!isPortableKey(key)) {
      reject("action_file_invalid");
    }
    return key;
  });
  if (new Set(keys).size !== keys.length) {
    reject("action_file_invalid");
  }
  keys.sort(compareCanonicalKeys);
  if (hasAllKeys(keys, ["Control", "Alt", "Delete"]) || hasAllKeys(keys, ["Meta", "KeyL"])) {
    reject("action_prohibited");
  }
  return { kind: "chord", keys };
}

function sequenceCoordinateKind(action: NormalizedSequenceLeaf): CoordinateKind | undefined {
  switch (action.kind) {
    case "pointer_move":
    case "click":
    case "drag":
    case "wheel":
    case "button_down":
      return action.kind;
    default:
      return undefined;
  }
}

function normalizeSequenceLeaf(value: unknown): NormalizedSequenceLeaf {
  const record = requireRecord(value);
  const kind = requireString(record.kind);
  switch (kind) {
    case "pointer_move":
      return normalizePointerMove(record);
    case "click":
      return normalizeClick(record);
    case "drag":
      return normalizeDrag(record);
    case "wheel":
      return normalizeWheel(record);
    case "key_down": {
      if (!hasKeys(record, ["kind", "key"])) {
        reject("action_file_invalid");
      }
      const key = requireString(record.key);
      if (!isOneOf(key, transitionModifiers)) {
        reject("action_file_invalid");
      }
      return { kind: "key_down", key };
    }
    case "key_up": {
      if (!hasKeys(record, ["kind", "key"])) {
        reject("action_file_invalid");
      }
      const key = requireString(record.key);
      if (!isOneOf(key, transitionModifiers)) {
        reject("action_file_invalid");
      }
      return { kind: "key_up", key };
    }
    case "button_down": {
      if (!hasKeys(record, ["kind", "button", "at"])) {
        reject("action_file_invalid");
      }
      return {
        kind: "button_down",
        button: normalizePointerButton(record.button),
        at: normalizePoint(record.at)
      };
    }
    case "button_up": {
      if (!hasKeys(record, ["kind", "button"])) {
        reject("action_file_invalid");
      }
      return { kind: "button_up", button: normalizePointerButton(record.button) };
    }
    default:
      reject("action_file_invalid");
  }
}

type HeldInput =
  | { kind: "key"; key: Modifier }
  | { kind: "button"; button: PointerButton };

function applySequenceLedger(action: NormalizedSequenceLeaf, held: HeldInput[]): void {
  switch (action.kind) {
    case "key_down":
      if (held.some((entry) => entry.kind === "key" && entry.key === action.key)) {
        reject("action_unbalanced");
      }
      held.push({ kind: "key", key: action.key });
      return;
    case "button_down":
      if (held.some((entry) => entry.kind === "button" && entry.button === action.button)) {
        reject("action_unbalanced");
      }
      held.push({ kind: "button", button: action.button });
      return;
    case "key_up": {
      const top = held[held.length - 1];
      if (top?.kind !== "key" || top.key !== action.key) {
        reject("action_unbalanced");
      }
      held.pop();
      return;
    }
    case "button_up": {
      const top = held[held.length - 1];
      if (top?.kind !== "button" || top.button !== action.button) {
        reject("action_unbalanced");
      }
      held.pop();
      return;
    }
    default:
      return;
  }
}

class ActionNormalizer {
  private leafCount = 0;
  private totalDelayMs = 0;

  public normalizeDocument(value: unknown): NormalizedActionPlan {
    const root = requireRecord(value);
    if (!hasKeys(root, ["kind", "observationId", "coordinateSpace", "actions"])) {
      reject("action_file_invalid");
    }
    if (root.kind !== "cu.action/v1") {
      reject("action_file_invalid");
    }
    const observationId = requireString(root.observationId);
    if (!/^obs_[a-z0-9][a-z0-9_-]{0,95}$/.test(observationId)) {
      reject("action_file_invalid");
    }
    if (root.coordinateSpace !== "normalized_999_top_left" || !Array.isArray(root.actions)) {
      reject("action_file_invalid");
    }
    if (root.actions.length === 0) {
      reject("action_file_invalid");
    }
    const actions = root.actions.map((action) => this.normalizeTopLevelAction(action));
    return {
      observationId,
      coordinateSpace: "normalized_999_top_left",
      actions,
      leafCount: this.leafCount,
      totalDelayMs: this.totalDelayMs
    };
  }

  private normalizeTopLevelAction(value: unknown): NormalizedAction {
    const record = requireRecord(value);
    const kind = requireString(record.kind);
    switch (kind) {
      case "pointer_move": {
        const action = normalizePointerMove(record);
        this.consumeLeaf();
        return action;
      }
      case "click": {
        const action = normalizeClick(record);
        this.consumeLeaf();
        return action;
      }
      case "drag": {
        const action = normalizeDrag(record);
        this.consumeLeaf();
        return action;
      }
      case "wheel": {
        const action = normalizeWheel(record);
        this.consumeLeaf();
        return action;
      }
      case "key": {
        const action = normalizeKey(record);
        this.consumeLeaf();
        return action;
      }
      case "type_text": {
        const action = normalizeTypeText(record);
        this.consumeLeaf();
        return action;
      }
      case "chord": {
        const action = normalizeChord(record);
        this.consumeLeaf();
        return action;
      }
      case "sequence":
        return this.normalizeSequence(record);
      default:
        reject("action_file_invalid");
    }
  }

  private normalizeSequence(record: Record<string, unknown>): SequenceAction {
    if (!hasKeys(record, ["kind", "steps"]) || !Array.isArray(record.steps)) {
      reject("action_file_invalid");
    }
    if (record.steps.length === 0) {
      reject("action_file_invalid");
    }
    if (record.steps.length > MAX_SEQUENCE_STEPS) {
      reject("action_limit_exceeded");
    }

    const held: HeldInput[] = [];
    let coordinateKind: CoordinateKind | undefined;
    const steps = record.steps.map((value) => {
      const step = requireRecord(value);
      if (!hasKeys(step, ["action"], ["delayAfterMs"])) {
        reject("action_file_invalid");
      }
      const delayAfterMs = this.normalizeDelay(step);
      const action = normalizeSequenceLeaf(step.action);
      this.consumeLeaf();
      const coordinate = sequenceCoordinateKind(action);
      const beforeCoordinate = coordinateKind === undefined;

      applySequenceLedger(action, held);
      if (coordinate !== undefined) {
        if (!beforeCoordinate) {
          reject("action_file_invalid");
        }
        coordinateKind = coordinate;
      } else if (action.kind === "key_down") {
        if (!beforeCoordinate) {
          reject("action_file_invalid");
        }
      } else if ((action.kind === "key_up" || action.kind === "button_up") && beforeCoordinate) {
        reject("action_file_invalid");
      }

      return { action, delayAfterMs };
    });

    if (coordinateKind === undefined) {
      reject("action_file_invalid");
    }
    if (held.length !== 0) {
      reject("action_unbalanced");
    }
    return { kind: "sequence", coordinateKind, steps };
  }

  private normalizeDelay(step: Record<string, unknown>): number {
    if (!Object.hasOwn(step, "delayAfterMs")) {
      return 0;
    }
    const delayAfterMs = requireInteger(step.delayAfterMs);
    if (delayAfterMs < 0 || delayAfterMs > MAX_STEP_DELAY_MS) {
      reject("action_limit_exceeded");
    }
    this.totalDelayMs += delayAfterMs;
    if (this.totalDelayMs > MAX_TOTAL_DELAY_MS) {
      reject("action_limit_exceeded");
    }
    return delayAfterMs;
  }

  private consumeLeaf(): void {
    this.leafCount++;
    if (this.leafCount > MAX_LEAF_ACTIONS) {
      reject("action_limit_exceeded");
    }
  }
}

function failure(code: ActionFailureCode): ActionAdmissionFailure {
  const message =
    code === "action_file_too_large"
      ? "Action file exceeds the supported size."
      : "Action file is invalid.";
  return { ok: false, error: { code, message, effect: "none" } };
}

function decodeJsonBytes(bytes: Uint8Array): StrictJsonValue | undefined {
  try {
    return parseStrictJsonBytes(bytes, {
      maxBytes: MAX_ACTION_FILE_BYTES,
      maxDepth: MAX_JSON_DEPTH
    });
  } catch {
    return undefined;
  }
}

export function admitActionBytes(bytes: Uint8Array): ActionAdmissionResult {
  if (bytes.byteLength > MAX_ACTION_FILE_BYTES) {
    return failure("action_file_too_large");
  }
  const raw = decodeJsonBytes(bytes);
  if (raw === undefined) {
    return failure("action_file_invalid");
  }
  try {
    const plan = new ActionNormalizer().normalizeDocument(raw);
    deepFreezeNormalizedValue(plan);
    admittedActionPlans.add(plan);
    return { ok: true, plan };
  } catch (error) {
    if (error instanceof ActionAdmissionViolation) {
      return failure(error.code);
    }
    return failure("action_file_invalid");
  }
}

function coordinateKindOf(action: NormalizedAction): CoordinateKind | undefined {
  switch (action.kind) {
    case "pointer_move":
    case "click":
    case "drag":
    case "wheel":
      return action.kind;
    case "sequence":
      return action.coordinateKind;
    default:
      return undefined;
  }
}

function terminalReason(action: NormalizedAction): D2Reason | undefined {
  if (action.kind === "drag" || (action.kind === "sequence" && action.coordinateKind === "drag")) {
    return "drag";
  }
  if (action.kind === "wheel" || (action.kind === "sequence" && action.coordinateKind === "wheel")) {
    return "wheel";
  }
  if (action.kind === "key" && isFocusKey(action.key)) {
    return "focus_key";
  }
  if (action.kind === "chord") {
    return "chord";
  }
  return undefined;
}

export function segmentActionPlan(plan: NormalizedActionPlan): D2Segment {
  let coordinates = 0;
  for (let index = 0; index < plan.actions.length; index++) {
    const action = plan.actions[index]!;
    if (coordinateKindOf(action) !== undefined) {
      if (coordinates > 0) {
        return { outcome: "checkpoint", prefixLength: index, reason: "second_coordinate" };
      }
      coordinates++;
    }
    const reason = terminalReason(action);
    if (reason !== undefined) {
      return { outcome: "checkpoint", prefixLength: index + 1, reason };
    }
  }
  return { outcome: "completed", prefixLength: plan.actions.length };
}
