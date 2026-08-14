import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export type FixtureRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ControlledClickEvent = Readonly<{
  kind: "click";
  button: "left" | "middle" | "right";
  x: number;
  y: number;
  count: number;
}>;

export type ControlledWindowFixture = Readonly<{
  token: string;
  target: FixtureRectangle;
  decoy: FixtureRectangle;
  waitForQuiet(): Promise<void>;
  focus(role: "target" | "decoy"): Promise<void>;
  snapshotAndClear(): Promise<Readonly<{
    target: readonly ControlledClickEvent[];
    decoy: readonly ControlledClickEvent[];
  }>>;
  stop(): Promise<void>;
}>;

export type ControlledPattern = Readonly<{
  width: number;
  height: number;
  samples: ReadonlyArray<Readonly<{ x: number; y: number }>>;
}>;

export type ControlledPatternColors = Readonly<{
  target: ReadonlyArray<readonly [number, number, number]>;
  decoy: ReadonlyArray<readonly [number, number, number]>;
}>;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = join(repositoryRoot, "test", "fixtures", "controlled-window", "fixture.ps1");
const patternPath = join(repositoryRoot, "test", "fixtures", "controlled-window", "pattern.json");

export function stockPowerShellPath(): string {
  const slash = "\\";
  const kernelPath = `${slash}${slash}?${slash}GLOBALROOT${slash}SystemRoot${slash}System32${slash}WindowsPowerShell${slash}v1.0${slash}powershell.exe`;
  const resolved = realpathSync.native(kernelPath);
  if (!lstatSync(resolved).isFile()) {
    throw new Error("stock Windows PowerShell is unavailable");
  }
  return resolved;
}

function childEnvironmentForStockPowerShell(powershellPath: string, tempRoot: string): NodeJS.ProcessEnv {
  const systemRoot = resolve(dirname(powershellPath), "../../..");
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== "systemroot" && key.toLowerCase() !== "windir"
      )
    ),
    SYSTEMROOT: systemRoot,
    WINDIR: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot
  };
}

function isRect(value: unknown): value is FixtureRectangle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    [record.x, record.y, record.width, record.height].every(Number.isSafeInteger) &&
    Number(record.width) > 0 &&
    Number(record.height) > 0
  );
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
  token: string,
  timeoutMs: number
): Promise<{ target: FixtureRectangle; decoy: FixtureRectangle }> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, ready?: { target: FixtureRectangle; decoy: FixtureRectangle }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      if (error !== undefined) rejectReady(error);
      else resolveReady(ready!);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > 65_536) {
        finish(new Error("fixture stdout exceeded limit"));
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(stdout.slice(0, newline).trim()) as Record<string, unknown>;
        if (
          value.kind !== "cu.controlled-window.ready/v1" ||
          value.token !== token ||
          !isRect(value.target) ||
          !isRect(value.decoy)
        ) {
          throw new Error("invalid fixture ready record");
        }
        finish(undefined, { target: value.target, decoy: value.decoy });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("invalid fixture ready record"));
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > 65_536) {
        stderr = stderr.slice(-65_536);
      }
    };
    const onExit = (code: number | null) => {
      finish(new Error(`fixture exited before ready (${String(code)}): ${stderr}`));
    };
    const timer = setTimeout(() => finish(new Error(`fixture ready timeout: ${stderr}`)), timeoutMs);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function waitForQuietEventLog(eventPath: string): Promise<void> {
  return new Promise((resolveQuiet, rejectQuiet) => {
    let stableSamples = 0;
    let previousSize = -1;
    let attempts = 0;
    const poll = () => {
      try {
        const size = existsSync(eventPath) ? statSync(eventPath).size : 0;
        stableSamples = size === previousSize ? stableSamples + 1 : 0;
        previousSize = size;
        if (stableSamples >= 2) {
          resolveQuiet();
          return;
        }
        attempts++;
        if (attempts >= 20) {
          rejectQuiet(new Error("fixture event stream did not become quiet"));
          return;
        }
        setTimeout(poll, 25);
      } catch (error) {
        rejectQuiet(error instanceof Error ? error : new Error("fixture event stream failed"));
      }
    };
    setTimeout(poll, 25);
  });
}

function waitForExactFile(path: string, expected: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveValue, rejectValue) => {
    const startedAt = Date.now();
    const poll = () => {
      try {
        if (existsSync(path) && readFileSync(path, "utf8") === expected) {
          resolveValue();
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          rejectValue(new Error("fixture focus timeout"));
          return;
        }
        setTimeout(poll, 25);
      } catch (error) {
        rejectValue(error instanceof Error ? error : new Error("fixture focus failed"));
      }
    };
    poll();
  });
}

function readAndClearEventLog(eventPath: string): Readonly<{
  target: readonly ControlledClickEvent[];
  decoy: readonly ControlledClickEvent[];
}> {
  if (!existsSync(eventPath)) {
    return Object.freeze({ target: Object.freeze([]), decoy: Object.freeze([]) });
  }
  const bytes = readFileSync(eventPath);
  if (bytes.length > 65_536) throw new Error("fixture event stream exceeded limit");
  const target: ControlledClickEvent[] = [];
  const decoy: ControlledClickEvent[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      value.kind !== "click" ||
      (value.role !== "target" && value.role !== "decoy") ||
      (value.button !== "left" && value.button !== "middle" && value.button !== "right") ||
      !Number.isSafeInteger(value.x) ||
      !Number.isSafeInteger(value.y) ||
      !Number.isSafeInteger(value.count) ||
      Number(value.count) < 1 ||
      Object.keys(value).length !== 6
    ) {
      throw new Error("invalid fixture event record");
    }
    const button = value.button as ControlledClickEvent["button"];
    const event = Object.freeze({
      kind: "click" as const,
      button,
      x: value.x as number,
      y: value.y as number,
      count: value.count as number
    });
    (value.role === "target" ? target : decoy).push(event);
  }
  truncateSync(eventPath, 0);
  return Object.freeze({ target: Object.freeze(target), decoy: Object.freeze(decoy) });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error === undefined) resolveExit();
      else rejectExit(error);
    };
    const onExit = () => finish();
    const timer = setTimeout(() => finish(new Error("fixture exit timeout")), timeoutMs);
    child.on("exit", onExit);
  });
}

export async function startControlledWindowFixture(timeoutMs = 15_000): Promise<ControlledWindowFixture> {
  if (process.platform !== "win32") {
    throw new Error("controlled Windows fixture requires win32");
  }
  const root = mkdtempSync(join(tmpdir(), "cu-controlled-window-"));
  const stopPath = join(root, "stop");
  const focusPath = join(root, "focus");
  const focusAckPath = join(root, "focus-ack");
  const eventPath = join(root, "events.ndjson");
  const token = randomBytes(12).toString("hex");
  const powershellPath = stockPowerShellPath();
  const child = spawn(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fixturePath,
      "-ControlPath",
      stopPath,
      "-EventPath",
      eventPath,
      "-FocusPath",
      focusPath,
      "-FocusAckPath",
      focusAckPath,
      "-Token",
      token
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: childEnvironmentForStockPowerShell(powershellPath, root)
    }
  ) as ChildProcessWithoutNullStreams;

  try {
    const ready = await waitForReady(child, token, timeoutMs);
    let stopped = false;
    return Object.freeze({
      token,
      target: Object.freeze({ ...ready.target }),
      decoy: Object.freeze({ ...ready.decoy }),
      async waitForQuiet() {
        await waitForQuietEventLog(eventPath);
      },
      async focus(role: "target" | "decoy") {
        if (stopped) throw new Error("fixture is stopped");
        rmSync(focusAckPath, { force: true });
        writeFileSync(focusPath, role, { flag: "wx" });
        await waitForExactFile(focusAckPath, role, timeoutMs);
      },
      async snapshotAndClear() {
        await waitForQuietEventLog(eventPath);
        return readAndClearEventLog(eventPath);
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          writeFileSync(stopPath, "stop", { flag: "wx" });
          await waitForExit(child, timeoutMs);
        } catch (error) {
          child.kill();
          await waitForExit(child, timeoutMs).catch(() => undefined);
          throw error;
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  } catch (error) {
    child.kill();
    await waitForExit(child, timeoutMs).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function readControlledPattern(): ControlledPattern {
  const value = JSON.parse(readFileSync(patternPath, "utf8")) as ControlledPattern;
  return value;
}

export function deriveControlledPatternColors(token: string): ControlledPatternColors {
  const digest = createHash("sha256").update(token, "utf8").digest();
  const target = Array.from({ length: 4 }, (_, index) => {
    const offset = index * 3;
    return [
      32 + (digest[offset]! % 192),
      32 + (digest[offset + 1]! % 192),
      32 + (digest[offset + 2]! % 192)
    ] as const;
  });
  const decoy = target.map((rgb) => [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]] as const);
  return Object.freeze({
    target: Object.freeze(target),
    decoy: Object.freeze(decoy)
  });
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePngRgba(bytes: Buffer): Readonly<{
  width: number;
  height: number;
  rgba: Buffer;
}> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) {
    throw new Error("invalid PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("truncated PNG");
    if (type === "IHDR") {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const depth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error("unsupported PNG");
      channels = colorType === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (width < 1 || height < 1 || channels === 0 || idat.length === 0) {
    throw new Error("incomplete PNG");
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (inflated.length !== height * (stride + 1)) throw new Error("invalid scanlines");
  const raw = Buffer.alloc(width * height * channels);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source++];
    for (let x = 0; x < stride; x += 1) {
      const encoded = inflated[source++];
      const out = y * stride + x;
      const left = x >= channels ? raw[out - channels]! : 0;
      const up = y > 0 ? raw[out - stride]! : 0;
      const upperLeft = y > 0 && x >= channels ? raw[out - stride - channels]! : 0;
      let value: number;
      if (filter === 0) value = encoded!;
      else if (filter === 1) value = encoded! + left;
      else if (filter === 2) value = encoded! + up;
      else if (filter === 3) value = encoded! + Math.floor((left + up) / 2);
      else if (filter === 4) value = encoded! + paeth(left, up, upperLeft);
      else throw new Error("invalid PNG filter");
      raw[out] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = raw[pixel * channels]!;
    rgba[pixel * 4 + 1] = raw[pixel * channels + 1]!;
    rgba[pixel * 4 + 2] = raw[pixel * channels + 2]!;
    rgba[pixel * 4 + 3] = channels === 4 ? raw[pixel * channels + 3]! : 255;
  }
  return Object.freeze({ width, height, rgba });
}

export function sampleRgb(
  decoded: Readonly<{ width: number; height: number; rgba: Buffer }>,
  x: number,
  y: number
): readonly [number, number, number] {
  if (x < 0 || y < 0 || x >= decoded.width || y >= decoded.height) {
    throw new Error("sample outside PNG");
  }
  const offset = (y * decoded.width + x) * 4;
  return [decoded.rgba[offset]!, decoded.rgba[offset + 1]!, decoded.rgba[offset + 2]!];
}
