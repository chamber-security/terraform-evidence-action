import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

void test("the committed bundle executes its Action entrypoint", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "terraform-evidence-bundle-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const outputPath = join(directory, "github-output");
  writeFileSync(outputPath, "", "utf8");

  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      "INPUT_FAILURE-MODE": "error",
    },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  const outputs = readFileSync(outputPath, "utf8");
  assert.match(outputs, /status/u);
  assert.match(outputs, /action_failed/u);
});
