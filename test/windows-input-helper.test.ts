import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startControlledWindowFixture, stockPowerShellPath } from "./support/controlled-window.js";

function helperPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../helper/windows-input.ps1");
}

test("input helper is a separate SendInput-only command-scoped protocol endpoint", () => {
  const helper = readFileSync(helperPath(), "utf8");

  assert.match(helper, /SendInput/);
  assert.match(helper, /cu\.windows-input\.ready\/v1/);
  assert.match(helper, /cu\.windows-input\.request\/v1/);
  assert.match(helper, /cu\.windows-input\.execute\/v1/);
  assert.match(helper, /cu\.windows-input\.result\/v1/);
  assert.match(helper, /OpenInputDesktop/);
  assert.match(helper, /WTSQuerySessionInformation/);
  assert.ok(helper.indexOf("Get-Snapshot") < helper.indexOf("[Console]::In.ReadToEnd()"));
  const recordsIndex = helper.indexOf("$records = @(Read-Records");
  const preEffectSnapshotIndex = helper.indexOf("$preEffectSnapshot = Get-Snapshot", recordsIndex);
  const snapshotComparisonIndex = helper.indexOf("-cne $snapshotCanonical", preEffectSnapshotIndex);
  const sendIndex = helper.indexOf("$accepted = Send-Records", snapshotComparisonIndex);
  assert.ok(
    recordsIndex >= 0 &&
    preEffectSnapshotIndex > recordsIndex &&
    snapshotComparisonIndex > preEffectSnapshotIndex &&
    sendIndex > snapshotComparisonIndex
  );
  assert.doesNotMatch(helper, /SendKeys|keybd_event|mouse_event|clipboard|UIAccess|SetForegroundWindow|SetWindowPos|Add-Type -AssemblyName System\.Windows\.Forms/i);
  assert.doesNotMatch(helper, /CU_[A-Z_]*FAULT|fault[_-]?switch|Task14|target.*(?:HWND|PID|token)/i);
});

test("input helper tracks and releases a partial Unicode key while enforcing the cumulative delay cap", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "cu-input-helper-functions-"));
  try {
    const helper = readFileSync(helperPath(), "utf8");
    const executionMarker = "\ntry {\n  Add-Type -TypeDefinition $nativeSource -Language CSharp";
    const markerIndex = helper.indexOf(executionMarker);
    assert.ok(markerIndex > 0);

    const overlong = Buffer.alloc(8 * 32);
    for (let index = 0; index < 8; index++) {
      const offset = index * 32;
      overlong.writeInt32LE(1, offset);
      overlong.writeUInt32LE(index % 2 === 0 ? 0x0004 : 0x0006, offset + 12);
      overlong.writeUInt32LE(0x0041, offset + 24);
      overlong.writeUInt32LE(5_000, offset + 28);
    }

    const probePath = join(root, "probe.ps1");
    writeFileSync(probePath, `${helper.slice(0, markerIndex)}
Add-Type -TypeDefinition $nativeSource -Language CSharp
$held = New-Object 'System.Collections.Generic.List[object]'
$down = New-InputRecord -Type 1 -Dx 0 -Dy 0 -Flags 0x0004 -Data 0 -VirtualKey 0 -ScanCode 0xd83d -DelayAfterMs 0
Apply-HeldRecord -Held $held -Record $down
$countAfterDown = $held.Count
$cleanupRecord = New-CleanupRecord -Entry $held[0]
Apply-HeldRecord -Held $held -Record $cleanupRecord
$overlongRejected = $false
try { [void]@(Read-Records -Encoded '${overlong.toString("base64")}') } catch { $overlongRejected = $true }
[Console]::Out.WriteLine(([ordered]@{
  countAfterDown = $countAfterDown
  cleanupFlags = [int]$cleanupRecord.Flags
  cleanupScanCode = [int]$cleanupRecord.ScanCode
  countAfterCleanup = $held.Count
  overlongRejected = $overlongRejected
} | ConvertTo-Json -Compress))
`, "utf8");

    const execution = spawnSync(
      stockPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probePath],
      { encoding: "utf8", windowsHide: true, shell: false }
    );
    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout.trim()), {
      countAfterDown: 1,
      cleanupFlags: 0x0006,
      cleanupScanCode: 0xd83d,
      countAfterCleanup: 0,
      overlongRejected: true
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input helper source keeps typed data out of result and diagnostic records", () => {
  const helper = readFileSync(helperPath(), "utf8");

  assert.match(helper, /requestedNativeRecords/);
  assert.match(helper, /acceptedNativeRecords/);
  assert.match(helper, /heldAfter/);
  assert.doesNotMatch(helper, /typeText|typedText|textValue|rawText/i);
});

test(
  "probe-only and malformed protocol paths leave both controlled fixture streams empty",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    const fixture = await startControlledWindowFixture();
    const root = mkdtempSync(join(tmpdir(), "cu-input-helper-test-"));
    try {
      await fixture.waitForQuiet();
      const execution = spawnSync(
        stockPowerShellPath(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath()],
        {
          input: `${JSON.stringify({
            kind: "cu.windows-input.request/v1",
            recordsBase64: "AA=="
          })}\n`,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          env: { ...process.env, TEMP: root, TMP: root }
        }
      );
      assert.notEqual(execution.status, 0);
      const lines = execution.stdout.trim().split("\n");
      assert.equal(JSON.parse(lines[0]!).kind, "cu.windows-input.ready/v1");
      assert.deepEqual(await fixture.snapshotAndClear(), { target: [], decoy: [] });
    } finally {
      await fixture.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
