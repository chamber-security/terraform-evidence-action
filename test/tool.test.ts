import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SafeError } from "../src/errors";
import { resolveTool } from "../src/tool";

async function pathWith(
  t: test.TestContext,
  executables: readonly string[],
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "chamber-tool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of executables) {
    const file = path.join(dir, name);
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
  }
  return dir;
}

void test("uses the only installed tool", async (t) => {
  const tofu = await pathWith(t, ["tofu"]);
  assert.deepEqual(await resolveTool(undefined, { PATH: tofu }, "linux"), {
    tool: "tofu",
    known: true,
  });
  const terraform = await pathWith(t, ["terraform"]);
  assert.deepEqual(await resolveTool(undefined, { PATH: terraform }, "linux"), {
    tool: "terraform",
    known: true,
  });
});

void test("finds the tool in a later PATH directory", async (t) => {
  const empty = await pathWith(t, []);
  const tofu = await pathWith(t, ["tofu"]);
  assert.deepEqual(
    await resolveTool(
      undefined,
      { PATH: `${empty}:relative:${tofu}` },
      "linux",
    ),
    { tool: "tofu", known: true },
  );
});

void test("asks for the tool input when both are installed", async (t) => {
  const terraform = await pathWith(t, ["terraform"]);
  const tofu = await pathWith(t, ["tofu"]);
  await assert.rejects(
    resolveTool(undefined, { PATH: `${terraform}:${tofu}` }, "linux"),
    (error: unknown) =>
      error instanceof SafeError &&
      error.code === "tool_ambiguous" &&
      /set the tool input/u.test(error.message),
  );
  assert.deepEqual(
    await resolveTool("tofu", { PATH: `${terraform}:${tofu}` }, "linux"),
    { tool: "tofu", known: true },
  );
});

void test("the input names the tool without looking", async () => {
  assert.deepEqual(await resolveTool("terraform", {}, "linux"), {
    tool: "terraform",
    known: true,
  });
});

void test("falls back to terraform without claiming to know it", async (t) => {
  const empty = await pathWith(t, []);
  assert.deepEqual(await resolveTool(undefined, { PATH: empty }, "linux"), {
    tool: "terraform",
    known: false,
  });
  assert.deepEqual(await resolveTool(undefined, {}, "linux"), {
    tool: "terraform",
    known: false,
  });
});

void test("ignores a file that isn't executable", async (t) => {
  const dir = await pathWith(t, []);
  await writeFile(path.join(dir, "tofu"), "not executable");
  assert.deepEqual(await resolveTool(undefined, { PATH: dir }, "linux"), {
    tool: "terraform",
    known: false,
  });
});

void test("matches Windows executables by PATHEXT", async (t) => {
  const dir = await pathWith(t, ["tofu.EXE"]);
  assert.deepEqual(
    await resolveTool(undefined, { Path: dir, PATHEXT: ".COM;.EXE" }, "win32"),
    { tool: "tofu", known: true },
  );
});
