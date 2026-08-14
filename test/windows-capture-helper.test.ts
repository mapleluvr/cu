import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveDisplayInventory } from "../src/display.js";
import { parseRegionSelector } from "../src/region.js";
import { stockPowerShellPath } from "./support/controlled-window.js";

function helperPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../helper/windows-capture.ps1");
}

function runTopologyValidation(topology: object) {
  const probe = String.raw`
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:CU_CAPTURE_HELPER,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) { throw 'parse_failed' }
$functions = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true))
foreach ($name in @('Test-ExactKeys','Test-CanonicalIntToken','Test-DisplayTopology')) {
  $definition = @($functions | Where-Object { $_.Name -ceq $name })
  if ($definition.Count -ne 1) { throw 'function_missing' }
  Invoke-Expression $definition[0].Extent.Text
}
$value = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
if (-not (Test-DisplayTopology -VirtualScreen $value.virtualScreen -Monitors @($value.monitors))) {
  exit 9
}
`;
  return spawnSync(
    stockPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe],
    {
      input: `${JSON.stringify(topology)}\n`,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env: { ...process.env, CU_CAPTURE_HELPER: helperPath() }
    }
  );
}

function runTopologyPolicy(topology: object, requireDistinctDisplays: boolean) {
  const probe = String.raw`
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:CU_CAPTURE_HELPER,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) { throw 'parse_failed' }
$functions = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true))
foreach ($name in @(
  'Test-ExactKeys',
  'Test-CanonicalIntToken',
  'Test-DisplayTopology',
  'Test-TopologyForPurpose'
)) {
  $definition = @($functions | Where-Object { $_.Name -ceq $name })
  if ($definition.Count -ne 1) { throw 'function_missing' }
  Invoke-Expression $definition[0].Extent.Text
}
$value = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
if (-not (Test-TopologyForPurpose -VirtualScreen $value.topology.virtualScreen -Monitors @($value.topology.monitors) -RequireDistinctDisplays $value.requireDistinctDisplays)) {
  exit 9
}
`;
  return spawnSync(
    stockPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe],
    {
      input: `${JSON.stringify({ topology, requireDistinctDisplays })}\n`,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env: { ...process.env, CU_CAPTURE_HELPER: helperPath() }
    }
  );
}

function runSelectorResolution(selector: object, topology: object) {
  const probe = String.raw`
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $env:CU_CAPTURE_HELPER,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -ne 0) { throw 'parse_failed' }
$functions = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true))
foreach ($name in @(
  'Test-ExactKeys',
  'Test-CanonicalIntToken',
  'Test-ScalarString',
  'Test-DisplayTopology',
  'Test-TopologyForPurpose',
  'Test-RegionSelectorShape',
  'Test-SelectorShape',
  'New-RectObject',
  'Get-Sha256Hex',
  'Get-TopologyFingerprint',
  'Get-DisplayId',
  'Resolve-Selector'
)) {
  $definition = @($functions | Where-Object { $_.Name -ceq $name })
  if ($definition.Count -ne 1) { throw 'function_missing' }
  Invoke-Expression $definition[0].Extent.Text
}
$value = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
try {
  $resolved = Resolve-Selector -Selector $value.selector -VirtualScreen $value.topology.virtualScreen -Monitors @($value.topology.monitors)
  [Console]::Out.WriteLine(($resolved | ConvertTo-Json -Compress))
} catch {
  exit 9
}
`;
  return spawnSync(
    stockPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe],
    {
      input: `${JSON.stringify({ selector, topology })}\n`,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env: { ...process.env, CU_CAPTURE_HELPER: helperPath() }
    }
  );
}

function runHelper(input: string, helperTemp: string) {
  return spawnSync(
    stockPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath()],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env: { ...process.env, TEMP: helperTemp, TMP: helperTemp }
    }
  );
}

test("helper source enforces DPI, scalar protocol, and selector shape before snapshot", () => {
  const helper = readFileSync(helperPath(), "utf8");
  assert.match(
    helper,
    /\$dpiAware = \[CuCaptureNative\]::SetProcessDpiAwarenessContext\(\[IntPtr\]\(-4\)\)\s+if \(-not \$dpiAware\) \{\s+throw 'dpi_awareness_failed'/
  );
  assert.match(helper, /function Test-ScalarString/);
  assert.match(helper, /function Test-SelectorShape/);
  assert.ok(helper.indexOf("Test-SelectorShape -Selector $request.selector") < helper.indexOf("$pre = Get-Snapshot"));
  assert.match(helper, /WTSQuerySessionInformation/);
  assert.doesNotMatch(helper, /connected\s*=\s*\$true/);
  assert.doesNotMatch(helper, /SendInput|mouse_event|keybd_event|SendKeys|begin_effect/i);
});

test(
  "helper rejects noncanonical private protocol before creating destinations",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cu-helper-exact-protocol-"));
    const helperTemp = join(root, "helper-temp");
    mkdirSync(helperTemp);
    const canonicalRequest = {
      kind: "cu.windows-capture.request/v1",
      requestId: `req_${"a".repeat(32)}`,
      selector: { kind: "pixel", left: 0, top: 0, width: 1, height: 1 }
    };
    const variants: Array<Readonly<{ name: string; value: Record<string, unknown> }>> = [
      { name: "root key case", value: { Kind: canonicalRequest.kind, requestId: canonicalRequest.requestId, selector: canonicalRequest.selector } },
      { name: "root kind case", value: { ...canonicalRequest, kind: "CU.WINDOWS-CAPTURE.REQUEST/V1" } },
      { name: "request id case", value: { ...canonicalRequest, requestId: `req_${"A".repeat(32)}` } },
      { name: "selector key case", value: { ...canonicalRequest, selector: { Kind: "pixel", left: 0, top: 0, width: 1, height: 1 } } },
      { name: "selector kind case", value: { ...canonicalRequest, selector: { kind: "PIXEL", left: 0, top: 0, width: 1, height: 1 } } },
      { name: "root kind array", value: { ...canonicalRequest, kind: [canonicalRequest.kind] } },
      { name: "request id array", value: { ...canonicalRequest, requestId: [canonicalRequest.requestId] } },
      { name: "selector kind array", value: { ...canonicalRequest, selector: { kind: ["pixel"], left: 0, top: 0, width: 1, height: 1 } } },
      { name: "selector missing shape", value: { ...canonicalRequest, selector: { kind: "pixel", left: 0, top: 0, width: 1 } } }
    ];
    try {
      for (const [index, variant] of variants.entries()) {
        const destinationPath = join(helperTemp, `case-${index}.png`);
        const execution = runHelper(`${JSON.stringify({ ...variant.value, destinationPath })}\n`, helperTemp);
        assert.notEqual(execution.status, 0, variant.name);
        assert.equal(existsSync(destinationPath), false, variant.name);
      }

      const duplicateDestination = join(helperTemp, "duplicate.png");
      const duplicateExecution = runHelper(
        `{"kind":"rejected","kind":"cu.windows-capture.request/v1","requestId":"req_${"b".repeat(32)}","destinationPath":${JSON.stringify(duplicateDestination)},"selector":{"kind":"pixel","left":0,"top":0,"width":1,"height":1}}\n`,
        helperTemp
      );
      assert.notEqual(duplicateExecution.status, 0, "duplicate key");
      assert.equal(existsSync(duplicateDestination), false, "duplicate key");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "helper never deletes a test-owned existing destination outside command TEMP",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cu-helper-confinement-"));
    const helperTemp = join(root, "helper-temp");
    const sentinel = join(root, "sentinel.png");
    mkdirSync(helperTemp);
    writeFileSync(sentinel, "keep", { flag: "wx" });
    try {
      const execution = runHelper(
        `${JSON.stringify({
          kind: "cu.windows-capture.request/v1",
          requestId: `req_${"9".repeat(32)}`,
          destinationPath: sentinel,
          selector: { kind: "pixel", left: 0, top: 0, width: 1, height: 1 }
        })}\n`,
        helperTemp
      );
      assert.notEqual(execution.status, 0);
      assert.equal(readFileSync(sentinel, "utf8"), "keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "helper topology validator rejects geometrically duplicate display placements",
  { skip: process.platform !== "win32" },
  () => {
    const valid = runTopologyValidation({
      virtualScreen: { x: -100, y: 0, width: 200, height: 100 },
      monitors: [
        { x: -100, y: 0, width: 100, height: 100, primary: false },
        { x: 0, y: 0, width: 100, height: 100, primary: true }
      ]
    });
    assert.equal(valid.status, 0, valid.stderr);

    const duplicate = runTopologyValidation({
      virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
      monitors: [
        { x: 0, y: 0, width: 100, height: 100, primary: true },
        { x: 0, y: 0, width: 100, height: 100, primary: false }
      ]
    });
    assert.equal(duplicate.status, 9, duplicate.stderr);
  }
);

test(
  "helper topology policy preserves unbound regions but rejects ambiguous display identity",
  { skip: process.platform !== "win32" },
  () => {
    const mirrored = {
      virtualScreen: { x: 0, y: 0, width: 100, height: 100 },
      monitors: [
        { x: 0, y: 0, width: 100, height: 100, primary: true },
        { x: 0, y: 0, width: 100, height: 100, primary: false }
      ]
    };
    const unbound = runTopologyPolicy(mirrored, false);
    assert.equal(unbound.status, 0, unbound.stderr);

    const displayBound = runTopologyPolicy(mirrored, true);
    assert.equal(displayBound.status, 9, displayBound.stderr);
  }
);

test(
  "helper resolves a valid display id only for regions contained by that display",
  { skip: process.platform !== "win32" },
  () => {
    const topology = {
      virtualScreen: { x: -100, y: 0, width: 200, height: 100 },
      monitors: [
        { x: -100, y: 0, width: 100, height: 100, primary: false },
        { x: 0, y: 0, width: 100, height: 100, primary: true }
      ]
    };
    const leftDisplayId = deriveDisplayInventory(topology).displays[0]!.displayId;
    const inside = runSelectorResolution({
      kind: "display_region",
      displayId: leftDisplayId,
      region: parseRegionSelector("pixel:-90,10,20,20")
    }, topology);
    assert.equal(inside.status, 0, inside.stderr);
    assert.deepEqual(JSON.parse(inside.stdout), {
      x: -90,
      y: 10,
      width: 20,
      height: 20
    });

    const crossing = runSelectorResolution({
      kind: "display_region",
      displayId: leftDisplayId,
      region: parseRegionSelector("pixel:-10,10,20,20")
    }, topology);
    assert.equal(crossing.status, 9, crossing.stderr);
  }
);

test(
  "helper returns a stable display snapshot without creating capture files",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cu-helper-display-query-"));
    const helperTemp = join(root, "helper-temp");
    mkdirSync(helperTemp);
    try {
      const requestId = `req_${"7".repeat(32)}`;
      const execution = runHelper(`${JSON.stringify({
        kind: "cu.windows-display.request/v1",
        requestId
      })}\n`, helperTemp);

      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stderr, "");
      const result = JSON.parse(execution.stdout) as Record<string, unknown>;
      assert.deepEqual(Object.keys(result).sort(), [
        "kind",
        "monitors",
        "requestId",
        "virtualScreen"
      ]);
      assert.equal(result.kind, "cu.windows-display.result/v1");
      assert.equal(result.requestId, requestId);
      assert.ok(Array.isArray(result.monitors));
      assert.ok(result.monitors.length >= 1);
      assert.deepEqual(readdirSync(helperTemp), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "helper rejects noncanonical display requests without creating files",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cu-helper-display-exact-"));
    const helperTemp = join(root, "helper-temp");
    mkdirSync(helperTemp);
    try {
      const requestId = `req_${"6".repeat(32)}`;
      const variants = [
        `${JSON.stringify({ kind: "cu.windows-display.request/v1", requestId, extra: true })}\n`,
        `{"kind":"ignored","kind":"cu.windows-display.request/v1","requestId":"${requestId}"}\n`,
        `${JSON.stringify({ kind: "cu.windows-display.request/v1", requestId: `req_${"A".repeat(32)}` })}\n`
      ];
      for (const request of variants) {
        const execution = runHelper(request, helperTemp);
        assert.notEqual(execution.status, 0);
        assert.deepEqual(readdirSync(helperTemp), []);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  "helper rejects a stale display binding before creating its destination",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "cu-helper-display-stale-"));
    const helperTemp = join(root, "helper-temp");
    mkdirSync(helperTemp);
    const destinationPath = join(helperTemp, "stale.png");
    try {
      const execution = runHelper(`${JSON.stringify({
        kind: "cu.windows-capture.request/v1",
        requestId: `req_${"5".repeat(32)}`,
        destinationPath,
        selector: {
          kind: "display_region",
          displayId: `dsp_${"0".repeat(32)}`,
          region: { kind: "pixel", left: 0, top: 0, width: 1, height: 1 }
        }
      })}\n`, helperTemp);

      assert.notEqual(execution.status, 0);
      assert.equal(existsSync(destinationPath), false);
      assert.deepEqual(readdirSync(helperTemp), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test("controlled fixture requires PMv2 before loading WinForms", () => {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
    "test/fixtures/controlled-window/fixture.ps1"
  );
  const fixture = readFileSync(fixturePath, "utf8");
  assert.match(
    fixture,
    /\$dpiAware = \[CuFixtureNative\]::SetProcessDpiAwarenessContext\(\[IntPtr\]\(-4\)\)\s+if \(-not \$dpiAware\) \{\s+throw 'dpi_awareness_failed'/
  );
  assert.ok(fixture.indexOf("$dpiAware =") < fixture.indexOf("Add-Type -AssemblyName System.Windows.Forms"));
});

test("package build copies the capture-only helper asset", () => {
  const helper = readFileSync(helperPath(), "utf8");
  assert.match(helper, /CopyFromScreen/);
  assert.match(helper, /FileMode\]::CreateNew/);
  assert.match(helper, /Flush\(\$true\)/);
  assert.match(helper, /WTSQuerySessionInformation/);
  assert.doesNotMatch(helper, /SendInput|mouse_event|keybd_event|SendKeys|begin_effect/i);
});
