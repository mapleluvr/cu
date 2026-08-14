import assert from "node:assert/strict";
import test from "node:test";

import {
  admitActionBytes,
  segmentActionPlan,
  type ActionAdmissionResult,
  type NormalizedActionPlan
} from "../src/action-file.js";

const point = (x = 420, y = 318) => ({ x, y });

function documentFor(actions: unknown[], observationId = "obs_example"): Record<string, unknown> {
  return {
    kind: "cu.action/v1",
    observationId,
    coordinateSpace: "normalized_999_top_left",
    actions
  };
}

function admit(document: Record<string, unknown>): ActionAdmissionResult {
  return admitActionBytes(Buffer.from(JSON.stringify(document), "utf8"));
}

function assertFailure(result: ActionAdmissionResult, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
  assert.equal(result.error.effect, "none");
}

function assertPlan(actions: unknown[]): NormalizedActionPlan {
  const result = admit(documentFor(actions));
  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected admitted plan");
  }
  return result.plan;
}

function modifierClickSequence(): Record<string, unknown> {
  return {
    kind: "sequence",
    steps: [
      { action: { kind: "key_down", key: "Control" }, delayAfterMs: 3 },
      { action: { kind: "click", at: point(120, 220) } },
      { action: { kind: "key_up", key: "Control" } }
    ]
  };
}

test("rejects malformed JSON as a sanitized no-effect action-file failure", () => {
  const result = admitActionBytes(Buffer.from("{", "utf8"));

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "action_file_invalid",
      message: "Action file is invalid.",
      effect: "none"
    }
  });
});

test("rejects unknown root fields without exposing typed text", () => {
  const result = admit({
    ...documentFor([{ kind: "type_text", text: "do-not-disclose" }]),
    unexpected: true
  });

  assertFailure(result, "action_file_invalid");
  if (result.ok) return;
  assert.doesNotMatch(result.error.message, /do-not-disclose/);
});

test("rejects duplicate JSON object members before values are collapsed", () => {
  const duplicateRoot = Buffer.from(
    '{"kind":"cu.action/v1","observationId":"obs_first","observationId":"obs_second","coordinateSpace":"normalized_999_top_left","actions":[{"kind":"key","key":"Enter"}]}',
    "utf8"
  );
  const duplicateNestedPoint = Buffer.from(
    '{"kind":"cu.action/v1","observationId":"obs_example","coordinateSpace":"normalized_999_top_left","actions":[{"kind":"click","at":{"x":1,"x":2,"y":3}}]}',
    "utf8"
  );

  for (const bytes of [duplicateRoot, duplicateNestedPoint]) {
    assertFailure(admitActionBytes(bytes), "action_file_invalid");
  }
});

test("rejects invalid transport bytes, trailing content, and excessive nesting", () => {
  const valid = Buffer.from(
    JSON.stringify(documentFor([{ kind: "key", key: "KeyA" }])),
    "utf8"
  );
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"kind":"cu.action/v1","observationId":"obs_example","coordinateSpace":"normalized_999_top_left","actions":[{"kind":"type_text","text":"', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}]}', "utf8")
  ]);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]);
  const trailing = Buffer.concat([valid, Buffer.from("x", "utf8")]);
  const excessiveDepth = Buffer.from(
    `{"kind":"cu.action/v1","observationId":"obs_example","coordinateSpace":"normalized_999_top_left","actions":${"[".repeat(65)}${"0"}${"]".repeat(65)}}`,
    "utf8"
  );

  for (const bytes of [invalidUtf8, bom, trailing, excessiveDepth]) {
    assertFailure(admitActionBytes(bytes), "action_file_invalid");
  }
});

test("rejects an oversized action file before parsing", () => {
  assertFailure(admitActionBytes(Buffer.alloc(65_537, 0x20)), "action_file_too_large");
});

test("normalizes all atomic forms, defaults, accounting, and constrained modifier cleanup", () => {
  const plan = assertPlan([
    { kind: "pointer_move", to: point(10, 20) },
    { kind: "click", at: point() },
    { kind: "drag", from: point(1, 2), to: point(3, 4) },
    { kind: "wheel", at: point(12, 34), deltaY: -2 },
    { kind: "key", key: "F24" },
    { kind: "type_text", text: "hello 😀" },
    { kind: "chord", keys: ["KeyZ", "Shift", "Control"] },
    modifierClickSequence()
  ]);

  assert.equal(plan.leafCount, 10);
  assert.equal(plan.totalDelayMs, 3);
  assert.deepEqual(plan.actions, [
    { kind: "pointer_move", to: point(10, 20) },
    { kind: "click", at: point(), button: "left", count: 1 },
    {
      kind: "drag",
      from: point(1, 2),
      to: point(3, 4),
      button: "left",
      durationMs: 500
    },
    { kind: "wheel", at: point(12, 34), deltaY: -2 },
    { kind: "key", key: "F24" },
    { kind: "type_text", text: "hello 😀" },
    { kind: "chord", keys: ["Control", "Shift", "KeyZ"] },
    {
      kind: "sequence",
      coordinateKind: "click",
      steps: [
        {
          action: { kind: "key_down", key: "Control" },
          delayAfterMs: 3
        },
        {
          action: { kind: "click", at: point(120, 220), button: "left", count: 1 },
          delayAfterMs: 0
        },
        {
          action: { kind: "key_up", key: "Control" },
          delayAfterMs: 0
        }
      ]
    }
  ]);
});

test("rejects strict root, point, action, key, and text violations", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["invalid observation token", documentFor([{ kind: "key", key: "KeyA" }], "obs_Upper")],
    ["empty actions", documentFor([])],
    ["point outside coordinate space", documentFor([{ kind: "click", at: point(1_000, 1) }])],
    ["point with an extra key", documentFor([{ kind: "click", at: { ...point(), z: 1 } }])],
    ["unknown key token", documentFor([{ kind: "key", key: "KeyAA" }])],
    ["bad text control", documentFor([{ kind: "type_text", text: "line\nfeed" }])],
    ["unpaired surrogate", documentFor([{ kind: "type_text", text: "\ud800" }])],
    ["same drag endpoints", documentFor([{ kind: "drag", from: point(), to: point() }])],
    ["zero wheel", documentFor([{ kind: "wheel", at: point(), deltaY: 0 }])]
  ];

  for (const [, document] of cases) {
    assertFailure(admit(document), "action_file_invalid");
  }

  const typedTextFailure = admit(documentFor([{ kind: "type_text", text: "do-not-disclose\n" }]));
  assertFailure(typedTextFailure, "action_file_invalid");
  if (typedTextFailure.ok) return;
  assert.doesNotMatch(typedTextFailure.error.message, /do-not-disclose/);
});

test("admits only canonical lexical F1 through F24 tokens", () => {
  for (const key of ["F01", "F0001", "F024", "F25"]) {
    assertFailure(admit(documentFor([{ kind: "key", key }])), "action_file_invalid");
  }
  for (const key of ["F1", "F24"]) {
    assertPlan([{ kind: "key", key }]);
  }
});

test("classifies resource ceilings before effects", () => {
  const excessiveDelay = [modifierClickSequence(), modifierClickSequence(), modifierClickSequence()].map(
    (sequence) => ({
      ...sequence,
      steps: (sequence.steps as Array<Record<string, unknown>>).map((step) => ({
        ...step,
        delayAfterMs: 5_000
      }))
    })
  );
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "too many leaf actions",
      documentFor(Array.from({ length: 33 }, () => ({ kind: "key", key: "KeyA" })))
    ],
    ["text scalar ceiling", documentFor([{ kind: "type_text", text: "a".repeat(2_049) }])],
    [
      "drag duration ceiling",
      documentFor([{ kind: "drag", from: point(1, 2), to: point(3, 4), durationMs: 5_001 }])
    ],
    ["wheel detent ceiling", documentFor([{ kind: "wheel", at: point(), deltaY: 101 }])],
    [
      "chord key ceiling",
      documentFor([
        {
          kind: "chord",
          keys: ["Control", "Alt", "Shift", "KeyA", "KeyB", "KeyC", "KeyD"]
        }
      ])
    ],
    ["total sequence delay ceiling", documentFor(excessiveDelay)]
  ];

  for (const [, document] of cases) {
    assertFailure(admit(document), "action_limit_exceeded");
  }
});

test("classifies prohibited system chords and preserves ordinary canonical chords", () => {
  for (const keys of [
    ["Delete", "Alt", "Control"],
    ["KeyL", "Meta"]
  ]) {
    assertFailure(admit(documentFor([{ kind: "chord", keys }])), "action_prohibited");
  }

  const plan = assertPlan([{ kind: "chord", keys: ["KeyZ", "Shift", "Control"] }]);
  assert.deepEqual(plan.actions, [
    { kind: "chord", keys: ["Control", "Shift", "KeyZ"] }
  ]);
});

test("admits balanced button cleanup and rejects invalid or unbalanced sequences", () => {
  const buttonPlan = assertPlan([
    {
      kind: "sequence",
      steps: [
        { action: { kind: "key_down", key: "Control" } },
        { action: { kind: "button_down", button: "left", at: point(77, 88) } },
        { action: { kind: "button_up", button: "left" } },
        { action: { kind: "key_up", key: "Control" } }
      ]
    }
  ]);
  assert.equal(buttonPlan.leafCount, 4);

  const invalidCases: Array<Record<string, unknown>> = [
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "key_down", key: "Meta" } },
          { action: { kind: "click", at: point() } }
        ]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "key_down", key: "Control", unexpected: true } },
          { action: { kind: "click", at: point() } },
          { action: { kind: "key_up", key: "Control" } }
        ]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "pointer_move", to: point() } },
          { action: { kind: "click", at: point(1, 2) } }
        ]
      }
    ])
  ];
  for (const document of invalidCases) {
    assertFailure(admit(document), "action_file_invalid");
  }

  const unbalancedCases: Array<Record<string, unknown>> = [
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "key_down", key: "Control" } },
          { action: { kind: "key_down", key: "Control" } },
          { action: { kind: "click", at: point() } },
          { action: { kind: "key_up", key: "Control" } }
        ]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [{ action: { kind: "key_up", key: "Control" } }]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "key_down", key: "Control" } },
          { action: { kind: "key_down", key: "Alt" } },
          { action: { kind: "click", at: point() } },
          { action: { kind: "key_up", key: "Control" } },
          { action: { kind: "key_up", key: "Alt" } }
        ]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [
          { action: { kind: "key_down", key: "Control" } },
          { action: { kind: "click", at: point() } }
        ]
      }
    ]),
    documentFor([
      {
        kind: "sequence",
        steps: [{ action: { kind: "button_down", button: "left", at: point() } }]
      }
    ])
  ];
  for (const document of unbalancedCases) {
    assertFailure(admit(document), "action_unbalanced");
  }
});

test("returns the longest D2-safe prefix without splitting a sequence", () => {
  assert.deepEqual(
    segmentActionPlan(assertPlan([{ kind: "key", key: "KeyA" }, { kind: "type_text", text: "ok" }])),
    { outcome: "completed", prefixLength: 2 }
  );
  assert.deepEqual(
    segmentActionPlan(
      assertPlan([
        { kind: "drag", from: point(1, 2), to: point(3, 4) },
        { kind: "key", key: "KeyA" }
      ])
    ),
    { outcome: "checkpoint", prefixLength: 1, reason: "drag" }
  );
  assert.deepEqual(
    segmentActionPlan(
      assertPlan([
        {
          kind: "sequence",
          steps: [
            { action: { kind: "key_down", key: "Control" } },
            { action: { kind: "wheel", at: point(), deltaY: 1 } },
            { action: { kind: "key_up", key: "Control" } }
          ]
        },
        { kind: "key", key: "KeyA" }
      ])
    ),
    { outcome: "checkpoint", prefixLength: 1, reason: "wheel" }
  );
  assert.deepEqual(
    segmentActionPlan(
      assertPlan([
        { kind: "click", at: point() },
        { kind: "type_text", text: "ok" },
        { kind: "key", key: "Enter" },
        { kind: "key", key: "KeyA" }
      ])
    ),
    { outcome: "checkpoint", prefixLength: 3, reason: "focus_key" }
  );
  assert.deepEqual(
    segmentActionPlan(
      assertPlan([{ kind: "key", key: "KeyA" }, { kind: "chord", keys: ["Control", "KeyZ"] }])
    ),
    { outcome: "checkpoint", prefixLength: 2, reason: "chord" }
  );
  assert.deepEqual(
    segmentActionPlan(assertPlan([{ kind: "click", at: point() }, modifierClickSequence()])),
    { outcome: "checkpoint", prefixLength: 1, reason: "second_coordinate" }
  );
  assert.deepEqual(
    segmentActionPlan(
      assertPlan([{ kind: "pointer_move", to: point() }, { kind: "click", at: point(1, 2) }])
    ),
    { outcome: "checkpoint", prefixLength: 1, reason: "second_coordinate" }
  );
});
