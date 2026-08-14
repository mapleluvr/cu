import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = join(repositoryRoot, "dist", "helper");
mkdirSync(destinationRoot, { recursive: true });
for (const helper of ["windows-capture.ps1", "windows-input.ps1"]) {
  copyFileSync(
    join(repositoryRoot, "src", "helper", helper),
    join(destinationRoot, helper)
  );
}
