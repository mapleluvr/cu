// Build a command-scoped native helper; no desktop access during compilation/core tests.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "src/helper/native");
const outputRoot = join(repositoryRoot, "dist/helper");
const testCore = process.argv.includes("--test");
if (process.argv.slice(2).some((arg) => arg !== "--test")) throw new Error("Usage: node scripts/build-native.mjs [--test]");
if (process.platform !== "win32") throw new Error("The cu native helper must be built on Windows.");
mkdirSync(outputRoot, { recursive: true });
function run(executable, args) {
  // Build-only compiler selection is operator configuration; argv is separate and no shell is used.
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const result = spawnSync(executable, args, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true, shell: false, timeout: 180_000, maxBuffer: 4_194_304 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Native build command failed: ${executable}`, { cause: result.error });
}
const compiler = process.env.CU_CXX ?? "g++";
const probe = spawnSync(compiler, ["-dumpmachine"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
const triple = probe.stdout?.trim() ?? "";
const matchesArchitecture = (process.arch === "x64" && triple.startsWith("x86_64")) || (process.arch === "arm64" && triple.startsWith("aarch64")) || (process.arch === "ia32" && /^i[3-6]86/.test(triple));
if (probe.status === 0 && triple.includes("mingw") && matchesArchitecture) {
  const flags = ["-std=c++17", "-O2", "-s", "-static", "-static-libgcc", "-static-libstdc++", "-DUNICODE", "-D_UNICODE", "-D_WIN32_WINNT=0x0A00", "-Wall", "-Wextra", "-Wpedantic", "-Werror"];
  const libraries = ["-luser32", "-lgdi32", "-lgdiplus", "-lole32", "-lbcrypt", "-lwtsapi32"];
  run(compiler, [...flags, join(sourceRoot, "capture.cpp"), "-o", join(outputRoot, "cu-capture.exe"), ...libraries]);
  if (testCore) run(compiler, [...flags, join(repositoryRoot, "test/native/capture-core.cpp"), "-o", join(outputRoot, "cu-capture-core.exe"), ...libraries]);
} else {
  if (process.env.CU_CXX) throw new Error("CU_CXX must name a MinGW compiler matching the Node process architecture.");
  const buildRoot = join(repositoryRoot, "dist/native-build");
  const architecture = { x64: "x64", arm64: "ARM64", ia32: "Win32" }[process.arch];
  if (!architecture) throw new Error(`Unsupported native build architecture: ${process.arch}`);
  // Default CMake discovery uses the installed Visual Studio C++ toolchain on Windows.
  run("cmake", ["-S", sourceRoot, "-B", buildRoot, "-A", architecture, `-DCU_BUILD_TESTS=${testCore ? "ON" : "OFF"}`]);
  run("cmake", ["--build", buildRoot, "--config", "Release", "--parallel", "2"]);
  copyFileSync(join(buildRoot, "Release/cu-capture.exe"), join(outputRoot, "cu-capture.exe"));
  if (testCore) copyFileSync(join(buildRoot, "Release/cu-capture-core.exe"), join(outputRoot, "cu-capture-core.exe"));
}
copyFileSync(join(sourceRoot, "vendor/LICENSE.nlohmann-json"), join(outputRoot, "LICENSE.nlohmann-json"));
if (testCore) run(join(outputRoot, "cu-capture-core.exe"), []);
console.log(`Native capture helper built for ${process.arch}`);
