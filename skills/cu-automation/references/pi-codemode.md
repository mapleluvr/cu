# Pi codemode recipes

Use these inside the **codemode tool**, not as JavaScript passed to bash. Codemode
has `tools`, `text()`, `image()`, and `store()`; it has no Node.js `process`, `fs`,
`require`, or `import`. Resolve paths from an explicit workspace.

## Observe and optionally show the image in one call

Adapt `workspace`, `runId`, the region, and `view` before calling. Keep the explicit
workspace identical in the PowerShell command and image-path resolution. The
example expects `cu init --json` to have succeeded there already.

The current Pi shell extension can return a string; stock Pi can return an object
with `output` and `exit_code`. This recipe handles both. Check the active tool's
schema for its timeout fields; `timeout` below is in seconds. A host may still
background a command, so the recipe detects that result rather than rerunning it.

```js
const workspace = "D:/cu-work";
const runId = "work-1";
const view = "image"; // "none" saves/returns the receipt without showing pixels
const quotePS = (s) => "'" + s.replaceAll("'", "''") + "'";
const result = await tools.bash({
  command: `Set-Location -LiteralPath ${quotePS(workspace)} -ErrorAction Stop; cu observe ${quotePS(runId)} --region pixel:100,100,800,600 --json`,
  background: false,
  timeout: 30,
});
const output = typeof result === "string" ? result : result.output;
if (typeof output !== "string") throw new Error("Missing shell output; inspect this call before continuing.");
if (output.includes("background task created")) {
  text(output); // Follow the returned task ID using the host's background tools.
  exit();      // Do not issue observe/act again while that task is unfinished.
}
let receipt;
try {
  receipt = JSON.parse(output.trim());
} catch {
  text("No complete JSON receipt; inspect this command's result before another desktop operation.");
  exit();
}
text(receipt);
store(`cu:${workspace}:${runId}:receipt`, receipt);
if (receipt.kind === "cu.error/v1") exit();
if (typeof result !== "string" && result.exit_code !== 0) exit();
const observation = receipt.kind === "cu.observe.result/v1"
  ? receipt
  : receipt.kind === "cu.act.result/v1" && receipt.outcome === "checkpoint"
    ? receipt.checkpoint
    : undefined;
if (view === "none" || !observation) exit();
const id = observation.observationId;
if (!/^[a-z0-9._-]+$/.test(runId) || runId === "." || runId === ".." ||
    !/^obs_[a-f0-9]{32}$/.test(id) || receipt.runId !== runId ||
    observation.imagePath !== `.cu/${runId}/captures/${id}.png`) {
  throw new Error("Unexpected observation path or identity; inspect the receipt.");
}
const path = `${workspace.replace(/\/$/, "")}/${observation.imagePath}`;
try {
  const shot = await tools.read({ path, offset: 1, limit: 1 });
  if (typeof shot === "string" || shot.type !== "image") {
    throw new Error("Expected an image block.");
  }
  if (shot.note) text(shot.note);
  image(shot);
} catch {
  text({ imageDelivery: "failed", imagePath: path,
    next: "Read this same image if still available. Do not replay the command." });
}
```

`image(shot)` is the operation that makes the screenshot visible to the model.
`text(shot)` would dump base64 as text. Calling `read()` inside codemode without
`image()` does not expose its pixels to the parent model. A terminal image preview
or Markdown image path is not a substitute for an image content block.

The shell may throw on a nonzero exit instead of returning an object. In that
case, inspect the tool error and follow the skill's failure table. A failed
codemode call does not roll back any completed capture, file write, or input.

## Act and show the checkpoint in the same call

Use the recipe above with the `bash` command changed to:

```js
command: `Set-Location -LiteralPath ${quotePS(workspace)} -ErrorAction Stop; cu act ${quotePS(runId)} --action-file action.json --json`,
```

Its receipt handler already recognizes `receipt.checkpoint`. Keep it in that
same codemode call. `view = "image"` shows a returned checkpoint; `view = "none"`
returns only its receipt. A `completed` action has no checkpoint image and this
handler deliberately stops there.

When the plan is ready, eliminate a separate write-only turn by inserting an
awaited write **before** `tools.bash` in that same recipe:

```js
// plan was chosen from current evidence; never invent its observationId.
await tools.write({
  path: `${workspace}/action.json`,
  content: JSON.stringify(plan),
});
```

Use a distinct action-file name for unrelated tasks. Do not print the plan or
raw typed text. Do not interpolate JSON into shell code. Never run the write and
act in parallel. `--action-file -` also exists for callers with a proper stdin
channel; the file path avoids PowerShell encoding/quoting mistakes here.

## Look at an existing capture without taking a new one

Use the exact absolute path resolved from a successful receipt:

```js
const shot = await tools.read({
  path: "D:/cu-work/.cu/work-1/captures/obs_0123456789abcdef0123456789abcdef.png",
  offset: 1,
  limit: 1,
});
if (typeof shot === "string" || shot.type !== "image") throw new Error("Expected image");
if (shot.note) text(shot.note);
image(shot);
```

The ID above is a placeholder. Reading the image does not create a new observation,
extend its TTL, or restore consumed authority. If it has expired, been superseded,
been consumed, or been removed, obtain fresh evidence before another action.

## Efficiency boundaries

- Select `none` for collection, archiving, or processing where the model does not
  need pixels. Processing code may read bytes or pass an image to another tool
  without calling `image()`.
- Select `image` whenever the next model decision needs to interpret the screenshot.
  This avoids another model turn devoted only to opening the file.
- Keep observation → delivery and act → checkpoint delivery within their respective
  codemode calls. The next visual decision belongs to the next model turn; codemode
  cannot reason over a new screenshot in the middle of a running script.
- Reuse a checkpoint image; do not recapture solely because the first call returned
  a path. Never use `history` to revive action authority.
- If the shell auto-backgrounds, continue the original task, retrieve its completed
  receipt, and then deliver that PNG. Do not parse a task notice as a cu receipt.
- Prefer the host's `read` image conversion; keep its resize notes. Any additional
  crop requires a known mapping back to the original observation's coordinates.
