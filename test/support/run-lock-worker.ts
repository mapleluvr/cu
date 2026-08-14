import { ensureRun } from "../../src/run.js";
import { acquireRunLock } from "../../src/run-lock.js";

const [workspace, runId, mode] = process.argv.slice(2);
if (workspace === undefined || runId === undefined) {
  process.exitCode = 2;
} else if (mode === "ensure") {
  try {
    const result = ensureRun(workspace, runId);
    process.stdout.write(`${JSON.stringify({ kind: "result", created: result.created })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", name: (error as Error).constructor.name })}\n`
    );
  }
} else if (mode === undefined) {
  const lock = acquireRunLock(workspace, runId);
  process.stdout.write("acquired\n");
  process.stdin.resume();
  process.stdin.once("data", () => {
    lock.release();
    process.exitCode = 0;
  });
} else {
  process.exitCode = 2;
}
