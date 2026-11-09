// Research-only variants. Does not change the installed cu runtime or package assets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const [destination, pwshArgument] = process.argv.slice(2);
if (!destination || !pwshArgument || !isAbsolute(destination) || !isAbsolute(pwshArgument)) {
  throw new Error("Usage: node scripts/experiments/observe-powershell/prepare.mjs ABSOLUTE_NEW_DIRECTORY ABSOLUTE_PWSH_EXE");
}
if (existsSync(destination)) throw new Error("The output directory must not already exist.");
if (process.platform !== "win32") throw new Error("Interactive Windows is required.");
const { stockPowerShellPath } = await import(pathToFileURL(join(repositoryRoot, "dist/test/support/controlled-window.js")));
const stock = stockPowerShellPath();
const systemRoot = resolve(dirname(stock), "../../..");
const compiler = join(systemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
for (const path of [compiler, pwshArgument, join(repositoryRoot, "dist/src/cli.js")]) {
  if (!existsSync(path)) throw new Error(`Missing prerequisite: ${path}`);
}
const source = readFileSync(join(repositoryRoot, "dist/helper/windows-capture.ps1"), "utf8");
const parent = readFileSync(join(repositoryRoot, "dist/src/windows-capture.js"), "utf8");
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, `Source changed; inspect the adaptation for ${before}`);
  return text.replace(before, after);
}
const portable = replaceOnce(source,
  "[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)",
  "[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)");
mkdirSync(destination);
const assemblies = {};
for (const stem of ["CuCaptureNative", "CuCaptureTopology"]) {
  const output = join(destination, `${stem}.dll`);
  const result = spawnSync(compiler, ["/nologo", "/target:library", "/optimize+", "/platform:anycpu", `/out:${output}`, join(here, `${stem}.cs`)], {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assemblies[stem] = output;
}
const variants = [];
for (const [runtime, executable] of [["ps51", stock], ["ps7", pwshArgument]]) {
  const modes = runtime === "ps51" ? ["current", "portable", "dll", "load", "dll-load", "dll-load-native"] : ["portable", "dll", "load", "dll-load", "dll-load-native"];
  for (const mode of modes) {
    const name = `${runtime}-${mode}`;
    const root = join(destination, name);
    mkdirSync(root);
    cpSync(join(repositoryRoot, "dist"), join(root, "dist"), { recursive: true });
    cpSync(join(repositoryRoot, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
    cpSync(join(repositoryRoot, "package.json"), join(root, "package.json"));
    let helper = mode === "current" ? source : portable;
    if (mode.includes("dll")) {
      const start = helper.indexOf("function Initialize-CaptureNative {");
      const end = helper.indexOf("function Test-SessionConnected");
      assert.ok(start > 0 && end > start);
      helper = helper.slice(0, start) + "function Initialize-CaptureNative {\n  [void][Reflection.Assembly]::LoadFrom([IO.Path]::Combine($PSScriptRoot, 'CuCaptureNative.dll'))\n}\n\n" + helper.slice(end);
      cpSync(assemblies[mode.endsWith("native") ? "CuCaptureTopology" : "CuCaptureNative"], join(root, "dist/helper/CuCaptureNative.dll"));
    }
    if (mode.includes("load")) {
      for (const [assembly, token] of [["System.Windows.Forms", "b77a5c561934e089"], ["System.Drawing", "b03f5f7f11d50a3a"]]) {
        helper = replaceOnce(helper, `Add-Type -AssemblyName ${assembly}`, `[void][Reflection.Assembly]::Load('${assembly}, Version=4.0.0.0, Culture=neutral, PublicKeyToken=${token}')`);
      }
    }
    if (mode.endsWith("native")) {
      helper = replaceOnce(helper, "  [void][Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')", "");
      helper = replaceOnce(helper, "[System.Windows.Forms.SystemInformation]::VirtualScreen", "[CuCaptureNative]::VirtualScreen()");
      helper = replaceOnce(helper, "[System.Windows.Forms.Screen]::AllScreens", "[CuCaptureNative]::AllScreens()");
    }
    writeFileSync(join(root, "dist/helper/windows-capture.ps1"), helper);
    // Reconstruct the legacy dispatcher from the current native parent. The system-root
    // resolution and every parent-side content/identity check stay identical.
    let legacyParent = replaceOnce(parent, 'new URL("../helper/cu-capture.exe", import.meta.url)', 'new URL("../helper/windows-capture.ps1", import.meta.url)');
    const runtimeArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
    legacyParent = replaceOnce(legacyParent, "spawnSync(helperPath, [], {", `spawnSync(${JSON.stringify(executable)}, [...${JSON.stringify(runtimeArgs)}, helperPath], {`);
    writeFileSync(join(root, "dist/src/windows-capture.js"), legacyParent);
    variants.push({ name, root, executable, mode, helperSha256: createHash("sha256").update(helper).digest("hex") });
  }
}
const manifest = {
  note: "Experimental PowerShell built copies of the legacy capture endpoint. Production uses native capture. DLLs are managed AnyCPU assemblies compiled locally; no experiment binaries are checked in. Only capture/displays runtime changes, not input.",
  createdAt: new Date().toISOString(), node: process.version, compiler,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  variants,
};
writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
