import assert from "node:assert/strict";
import test from "node:test";

import { runBoundedCommand } from "../src/command";
import { SafeError } from "../src/errors";

void test("counts bounded stderr before marking truncation", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", "process.stderr.write('1234567890')"],
    { cwd: process.cwd(), stderrLimit: 4 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrBytes, 4);
  assert.equal(result.stderrTruncated, true);
});

void test("stops a command that exceeds its deadline", async () => {
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 10,
    }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "command_timeout",
  );
});

void test("does not retain or return stderr contents", async () => {
  const canary = "COMMAND_SECRET_CANARY_DO_NOT_LOG";
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", `process.stderr.write('${canary}')`],
    { cwd: process.cwd(), stderrLimit: 4096 },
  );
  assert.equal("stderr" in result, false);
  assert.equal(JSON.stringify(result).includes(canary), false);
});
