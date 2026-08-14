import assert from "node:assert/strict";
import mutableChildProcess, {
  type ChildProcessWithoutNullStreams,
  type SpawnOptions
} from "node:child_process";
import { readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WindowsInputError,
  compileWindowsInputSegment,
  openWindowsInputSession,
  validateWindowsInputHelperResult
} from "../src/windows-input.js";

const source = {
  mapping: "normalized_endpoint_centers/v1" as const,
  leftPx: 100,
  topPx: 50,
  widthPx: 400,
  heightPx: 300
};

const virtualScreen = { x: 0, y: 0, width: 800, height: 600 };

type SpawnHook = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

const spawnHooks = mutableChildProcess as unknown as { spawn: SpawnHook };
const originalSpawn = mutableChildProcess.spawn;

function inputTempRoots(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("cu-input-")).sort();
}

function fakeHelperProgram(mode: string): string {
  return `
    const mode = ${JSON.stringify(mode)};
    const ready = {
      kind: "cu.windows-input.ready/v1",
      virtualScreen: { x: 0, y: 0, width: 800, height: 600 },
      monitors: [{ x: 0, y: 0, width: 800, height: 600, primary: true }],
      desktop: { interactive: true, connected: true, kind: "default", sessionId: 1, desktopName: "Default" },
      foreground: { windowHandle: "0x0000000000000001", processId: 1 }
    };
    const earlyResult = JSON.stringify({
      kind: "cu.windows-input.result/v1",
      executionId: "inp_00000000000000000000000000000000",
      requestedNativeRecords: 3,
      acceptedNativeRecords: 3,
      cleanup: "not_needed",
      heldAfter: []
    });
    process.stdout.write(
      JSON.stringify(ready) + "\\n" + (mode === "early_result" ? earlyResult + "\\n" : "")
    );
    let request = "";
    let emittedDuringRequestWrite = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      request += chunk;
      if (mode === "result_during_request_write" && !emittedDuringRequestWrite) {
        emittedDuringRequestWrite = true;
        process.stdout.write(earlyResult + "\\n");
      }
    });
    process.stdin.on("end", () => {
      if (mode === "exit_before_result") {
        process.exitCode = 3;
        return;
      }
      if (mode === "early_result" || mode === "result_during_request_write") {
        process.exitCode = 0;
        return;
      }
      const lines = request.split("\\n");
      const parsed = JSON.parse(lines[0]);
      const execute = JSON.parse(lines[1]);
      const requestedNativeRecords = Buffer.from(parsed.recordsBase64, "base64").length / 32;
      const result = JSON.stringify({
        kind: "cu.windows-input.result/v1",
        executionId: execute.executionId,
        requestedNativeRecords,
        acceptedNativeRecords: mode === "short_write" ? requestedNativeRecords - 1 : requestedNativeRecords,
        cleanup: mode === "short_write" ? "released" : "not_needed",
        heldAfter: []
      }) + "\\n";
      if (mode === "extra_then_zero") {
        process.stdout.write(result + "extra\\n", () => { process.exitCode = 0; });
      } else if (mode === "valid_then_failure") {
        process.stdout.write(result, () => { process.exitCode = 3; });
      } else if (mode === "unterminated_then_zero") {
        process.stdout.write(result + "tail", () => { process.exitCode = 0; });
      } else if (mode === "stderr_then_zero") {
        process.stderr.write("unexpected", () => {
          process.stdout.write(result, () => { process.exitCode = 0; });
        });
      } else if (mode === "short_write") {
        process.stdout.write(result, () => { process.exitCode = 0; });
      } else {
        process.stdout.write(result, () => { process.exitCode = 0; });
      }
    });
  `;
}

async function withFakeHelper(mode: string, operation: () => Promise<void>): Promise<void> {
  spawnHooks.spawn = (_command, _args, options) => originalSpawn(
    process.execPath,
    ["-e", fakeHelperProgram(mode)],
    options
  ) as ChildProcessWithoutNullStreams;
  syncBuiltinESMExports();
  try {
    await operation();
  } finally {
    spawnHooks.spawn = originalSpawn as unknown as SpawnHook;
    syncBuiltinESMExports();
  }
}

async function withSpawnFailure(
  operation: (productionObserverPresent: () => boolean) => Promise<void>
): Promise<void> {
  let observerPresent = false;
  spawnHooks.spawn = (_command, _args, options) => {
    const child = originalSpawn(
      "Z:\\cu-definitely-missing\\powershell.exe",
      [],
      options
    ) as ChildProcessWithoutNullStreams;
    child.on("error", () => {
      observerPresent = child.listenerCount("error") >= 2;
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    await operation(() => observerPresent);
  } finally {
    spawnHooks.spawn = originalSpawn as unknown as SpawnHook;
    syncBuiltinESMExports();
  }
}

async function withStdinFault(
  mode: "callback_error" | "late_error",
  operation: (evidence: () => Readonly<{ executeAttempted: boolean; observerPresent: boolean }>) => Promise<void>
): Promise<void> {
  let executeAttempted = false;
  let observerPresent = false;
  spawnHooks.spawn = (_command, _args, options) => {
    const child = originalSpawn(
      process.execPath,
      ["-e", fakeHelperProgram("transport_idle")],
      options
    ) as ChildProcessWithoutNullStreams;
    const writable = child.stdin as unknown as {
      write: (...args: unknown[]) => boolean;
      end: (...args: unknown[]) => unknown;
      emit: (name: string, error: Error) => boolean;
      on: (name: string, listener: () => void) => unknown;
      listenerCount: (name: string) => number;
    };
    const originalEnd = writable.end.bind(writable);
    writable.on("error", () => {
      observerPresent = writable.listenerCount("error") >= 2;
    });
    writable.write = (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("missing write callback");
      queueMicrotask(() => {
        if (mode === "callback_error") {
          callback(new Error("private transport detail"));
        } else {
          callback();
          queueMicrotask(() => writable.emit("error", new Error("private transport detail")));
        }
      });
      return true;
    };
    writable.end = (...args: unknown[]) => {
      executeAttempted = true;
      if (mode === "late_error") {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("missing end callback");
        queueMicrotask(() => {
          callback();
          queueMicrotask(() => {
            writable.emit("error", new Error("private transport detail"));
            child.kill();
          });
        });
        return writable;
      }
      return originalEnd(...args);
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
    await operation(() => ({ executeAttempted, observerPresent }));
  } finally {
    spawnHooks.spawn = originalSpawn as unknown as SpawnHook;
    syncBuiltinESMExports();
  }
}

test(
  "observes child spawn errors and removes TEMP through a content-free pre-request failure",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    const beforeTemps = inputTempRoots();
    await withSpawnFailure(async (productionObserverPresent) => {
      await assert.rejects(
        () => openWindowsInputSession(),
        (error: unknown) =>
          error instanceof WindowsInputError &&
          error.phase === "helper_lost" &&
          error.message === ""
      );
      assert.equal(productionObserverPresent(), true);
    });
    assert.deepEqual(inputTempRoots(), beforeTemps);
  }
);

test(
  "honors a first-request write callback error before attempting the execute phase",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    const beforeTemps = inputTempRoots();
    await withStdinFault("callback_error", async (evidence) => {
      const session = await openWindowsInputSession();
      await assert.rejects(
        () => session.emitSegment({
          source,
          actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
        }),
        (error: unknown) =>
          error instanceof WindowsInputError &&
          error.phase === "cleanup_unproven" &&
          error.message === ""
      );
      await session.close();
      assert.equal(evidence().executeAttempted, false);
    });
    assert.deepEqual(inputTempRoots(), beforeTemps);
  }
);

test(
  "keeps a durable stdin error observer after successful write callbacks",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    const beforeTemps = inputTempRoots();
    await withStdinFault("late_error", async (evidence) => {
      const session = await openWindowsInputSession();
      await assert.rejects(
        () => session.emitSegment({
          source,
          actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
        }),
        (error: unknown) =>
          error instanceof WindowsInputError &&
          error.phase === "cleanup_unproven" &&
          error.message === ""
      );
      await session.close();
      assert.equal(evidence().observerPresent, true);
    });
    assert.deepEqual(inputTempRoots(), beforeTemps);
  }
);

test(
  "prepares one opaque native segment before effect intent and emits it exactly once",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    await withFakeHelper("valid", async () => {
      const session = await openWindowsInputSession();
      const segment = {
        source,
        actions: [{ kind: "click" as const, at: { x: 500, y: 500 }, button: "left" as const, count: 1 as const }]
      };
      const prepared = session.prepareSegment(segment);
      await assert.rejects(
        () => session.emitPrepared(Object.freeze({}) as never),
        (error: unknown) =>
          error instanceof WindowsInputError &&
          error.phase === "input_unproven" &&
          error.message === ""
      );
      assert.deepEqual(await session.emitPrepared(prepared), {
        requestedNativeRecords: 3,
        acceptedNativeRecords: 3,
        emittedActionCount: 1,
        emittedLeafActionCount: 1,
        cleanup: "not_needed",
        heldAfter: []
      });
      await assert.rejects(
        () => session.emitPrepared(prepared),
        (error: unknown) =>
          error instanceof WindowsInputError &&
          error.phase === "input_unproven" &&
          error.message === ""
      );
      await session.close();
    });
  }
);

test("compiles one normalized controlled click into its exact bounded native records", () => {
  const compiled = compileWindowsInputSegment({
    source,
    actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
  }, virtualScreen);

  const dx = Math.round((299 * 65_535) / 799);
  const dy = Math.round((199 * 65_535) / 599);
  assert.deepEqual(compiled, {
    records: [
      { type: "mouse", dx, dy, flags: 0xc001, data: 0, virtualKey: 0, scanCode: 0, delayAfterMs: 0 },
      { type: "mouse", dx: 0, dy: 0, flags: 0x0002, data: 0, virtualKey: 0, scanCode: 0, delayAfterMs: 0 },
      { type: "mouse", dx: 0, dy: 0, flags: 0x0004, data: 0, virtualKey: 0, scanCode: 0, delayAfterMs: 0 }
    ],
    emittedActionCount: 1,
    emittedLeafActionCount: 1,
    declaredDelayMs: 0,
    generatedDragDurationMs: 0,
    resultTimeoutMs: 15_000
  });
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.records), true);
});

test("compiles a balanced modifier sequence as one leaf-accounted finite segment", () => {
  const compiled = compileWindowsInputSegment({
    source,
    actions: [{
      kind: "sequence",
      coordinateKind: "click",
      steps: [
        { action: { kind: "key_down", key: "Control" }, delayAfterMs: 12 },
        { action: { kind: "click", at: { x: 0, y: 999 }, button: "right", count: 1 }, delayAfterMs: 7 },
        { action: { kind: "key_up", key: "Control" }, delayAfterMs: 0 }
      ]
    }]
  }, virtualScreen);

  assert.equal(compiled.emittedActionCount, 1);
  assert.equal(compiled.emittedLeafActionCount, 3);
  assert.deepEqual(compiled.records.map((record) => record.delayAfterMs), [12, 0, 0, 7, 0]);
  assert.deepEqual(compiled.records.map((record) => [record.type, record.flags, record.virtualKey]), [
    ["key", 0, 0x11],
    ["mouse", 0xc001, 0],
    ["mouse", 0x0008, 0],
    ["mouse", 0x0010, 0],
    ["key", 0x0002, 0x11]
  ]);
});

test("derives the result deadline from an exact-limit held sequence plus protocol margin", () => {
  const compiled = compileWindowsInputSegment({
    source,
    actions: [{
      kind: "sequence",
      coordinateKind: "click",
      steps: [
        { action: { kind: "key_down", key: "Control" }, delayAfterMs: 5_000 },
        { action: { kind: "key_down", key: "Alt" }, delayAfterMs: 5_000 },
        { action: { kind: "key_down", key: "Shift" }, delayAfterMs: 5_000 },
        { action: { kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }, delayAfterMs: 5_000 },
        { action: { kind: "key_up", key: "Shift" }, delayAfterMs: 5_000 },
        { action: { kind: "key_up", key: "Alt" }, delayAfterMs: 5_000 },
        { action: { kind: "key_up", key: "Control" }, delayAfterMs: 0 }
      ]
    }]
  }, virtualScreen);

  assert.equal(compiled.records.reduce((total, record) => total + record.delayAfterMs, 0), 30_000);
  assert.equal(compiled.declaredDelayMs, 30_000);
  assert.equal(compiled.generatedDragDurationMs, 0);
  assert.equal(compiled.resultTimeoutMs, 45_000);
});

test("keeps declared sequence delay separate from generated drag duration", () => {
  assert.throws(
    () => compileWindowsInputSegment({
      source,
      actions: [{
        kind: "sequence",
        coordinateKind: "click",
        steps: [
          { action: { kind: "key_down", key: "Control" }, delayAfterMs: 5_000 },
          { action: { kind: "key_down", key: "Alt" }, delayAfterMs: 5_000 },
          { action: { kind: "key_down", key: "Shift" }, delayAfterMs: 5_000 },
          { action: { kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }, delayAfterMs: 5_000 },
          { action: { kind: "key_up", key: "Shift" }, delayAfterMs: 5_000 },
          { action: { kind: "key_up", key: "Alt" }, delayAfterMs: 5_000 },
          { action: { kind: "key_up", key: "Control" }, delayAfterMs: 5_000 }
        ]
      }]
    }, virtualScreen),
    (error: unknown) => error instanceof WindowsInputError && error.phase === "input_unproven"
  );

  const compiled = compileWindowsInputSegment({
    source,
    actions: [{
      kind: "sequence",
      coordinateKind: "drag",
      steps: [
        { action: { kind: "key_down", key: "Control" }, delayAfterMs: 5_000 },
        { action: { kind: "key_down", key: "Alt" }, delayAfterMs: 5_000 },
        { action: { kind: "key_down", key: "Shift" }, delayAfterMs: 5_000 },
        {
          action: {
            kind: "drag",
            from: { x: 100, y: 100 },
            to: { x: 200, y: 200 },
            button: "left",
            durationMs: 5_000
          },
          delayAfterMs: 5_000
        },
        { action: { kind: "key_up", key: "Shift" }, delayAfterMs: 5_000 },
        { action: { kind: "key_up", key: "Alt" }, delayAfterMs: 5_000 },
        { action: { kind: "key_up", key: "Control" }, delayAfterMs: 0 }
      ]
    }]
  }, virtualScreen);
  assert.equal(compiled.declaredDelayMs, 30_000);
  assert.equal(compiled.generatedDragDurationMs, 5_000);
  assert.equal(compiled.records.reduce((total, record) => total + record.delayAfterMs, 0), 35_000);
  assert.equal(compiled.resultTimeoutMs, 50_000);
});

test("redacts raw typed text from compiler metadata while compiling its Unicode input records", () => {
  const secret = "do-not-expose-this-text";
  const compiled = compileWindowsInputSegment({
    source,
    actions: [{ kind: "type_text", text: secret }]
  }, virtualScreen);

  assert.equal(compiled.records.length, secret.length * 2);
  assert.equal(compiled.emittedActionCount, 1);
  assert.equal(compiled.emittedLeafActionCount, 1);
  assert.doesNotMatch(JSON.stringify({
    requestedNativeRecords: compiled.records.length,
    emittedActionCount: compiled.emittedActionCount,
    emittedLeafActionCount: compiled.emittedLeafActionCount
  }), /do-not-expose-this-text/);
});

test("maps helper loss, a short write, and cleanup or held-state uncertainty to content-free failures", () => {
  const executionId = "inp_11111111111111111111111111111111";
  const result = (overrides: Record<string, unknown> = {}) => Buffer.from(`${JSON.stringify({
    kind: "cu.windows-input.result/v1",
    executionId,
    requestedNativeRecords: 3,
    acceptedNativeRecords: 3,
    cleanup: "not_needed",
    heldAfter: [],
    ...overrides
  })}\n`, "utf8");

  assert.deepEqual(validateWindowsInputHelperResult(result(), 3, executionId), {
    requestedNativeRecords: 3,
    acceptedNativeRecords: 3
  });
  assert.throws(
    () => validateWindowsInputHelperResult(result({ acceptedNativeRecords: 2 }), 3, executionId),
    (error: unknown) => error instanceof WindowsInputError && error.phase === "input_unproven" && error.message === ""
  );
  assert.throws(
    () => validateWindowsInputHelperResult(result({ cleanup: "unproven", heldAfter: ["button"] }), 3, executionId),
    (error: unknown) => error instanceof WindowsInputError && error.phase === "cleanup_unproven" && error.message === ""
  );
  assert.throws(
    () => validateWindowsInputHelperResult(Buffer.from("not-json\n", "utf8"), 3, executionId),
    (error: unknown) => error instanceof WindowsInputError && error.phase === "helper_lost" && error.message === ""
  );
  assert.throws(
    () => validateWindowsInputHelperResult(
      result({ executionId: "inp_00000000000000000000000000000000" }),
      3,
      executionId
    ),
    (error: unknown) => error instanceof WindowsInputError && error.phase === "helper_lost"
  );
});

test(
  "requires one result, clean EOF, zero exit, empty stderr, and cleanup proof after request",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    for (const [mode, expectedPhase] of [
      ["early_result", "helper_lost"],
      ["result_during_request_write", "cleanup_unproven"],
      ["extra_then_zero", "cleanup_unproven"],
      ["valid_then_failure", "cleanup_unproven"],
      ["unterminated_then_zero", "cleanup_unproven"],
      ["stderr_then_zero", "cleanup_unproven"],
      ["exit_before_result", "cleanup_unproven"],
      ["short_write", "input_unproven"]
    ] as const) {
      await withFakeHelper(mode, async () => {
        const session = await openWindowsInputSession();
        let actualError: unknown;
        try {
          await session.emitSegment({
            source,
            actions: [{ kind: "click", at: { x: 500, y: 500 }, button: "left", count: 1 }]
          });
        } catch (error) {
          actualError = error;
        } finally {
          await session.close();
        }
        assert.ok(
          actualError instanceof WindowsInputError &&
          actualError.phase === expectedPhase &&
          actualError.message === "",
          mode
        );
      });
    }
  }
);

test("fails closed for an unconfined source or malformed normalized action without emitting records", () => {
  assert.throws(
    () => compileWindowsInputSegment({
      source: { ...source, leftPx: 700 },
      actions: [{ kind: "click", at: { x: 0, y: 0 }, button: "left", count: 1 }]
    }, virtualScreen),
    (error: unknown) => error instanceof WindowsInputError && error.message === ""
  );
  assert.throws(
    () => compileWindowsInputSegment({
      source,
      actions: [{ kind: "type_text", text: "\u0000" } as never]
    }, virtualScreen),
    (error: unknown) => error instanceof WindowsInputError && error.message === ""
  );
});
