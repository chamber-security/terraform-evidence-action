import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SafeError } from "../src/errors";
import { resolvePaths } from "../src/paths";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chamber-action-paths-"));
  await mkdir(path.join(root, "terraform", "prod"), { recursive: true });
  await writeFile(path.join(root, "terraform", "prod", "saved.tfplan"), "plan");
  return root;
}

void test("normalizes contained repository-relative paths", async () => {
  const root = await fixture();
  const result = await resolvePaths(
    root,
    "./terraform//prod/.",
    "saved.tfplan",
  );
  assert.equal(result.workingDirectory, "terraform/prod");
  assert.equal(result.planFile, "saved.tfplan");
});

void test("rejects absolute and escaping paths", async () => {
  const root = await fixture();
  await assert.rejects(
    resolvePaths(root, "../outside", undefined),
    (error: unknown) =>
      error instanceof SafeError && error.code === "unsafe_path",
  );
  await assert.rejects(
    resolvePaths(root, "/absolute", undefined),
    (error: unknown) =>
      error instanceof SafeError && error.code === "unsafe_path",
  );
});

void test("rejects a symlinked directory or plan", async () => {
  const root = await fixture();
  await symlink(
    path.join(root, "terraform", "prod"),
    path.join(root, "linked"),
  );
  await symlink(
    path.join(root, "terraform", "prod", "saved.tfplan"),
    path.join(root, "terraform", "prod", "linked.tfplan"),
  );
  await assert.rejects(
    resolvePaths(root, "linked", undefined),
    (error: unknown) =>
      error instanceof SafeError && error.code === "symlink_path_rejected",
  );
  await assert.rejects(
    resolvePaths(root, "terraform/prod", "linked.tfplan"),
    (error: unknown) =>
      error instanceof SafeError && error.code === "symlink_path_rejected",
  );
});

void test("requires the saved plan to exist as a regular file", async () => {
  const root = await fixture();
  await assert.rejects(
    resolvePaths(root, "terraform/prod", "missing.tfplan"),
    (error: unknown) =>
      error instanceof SafeError && error.code === "path_not_found",
  );
  await assert.rejects(
    resolvePaths(root, "terraform", "prod"),
    (error: unknown) =>
      error instanceof SafeError && error.code === "path_type_mismatch",
  );
});

void test("uses native paths without restricting runner operating system", async () => {
  const root = await fixture();
  const resolved = await resolvePaths(root, ".", undefined);
  assert.equal(resolved.workspace, await realpath(root));
  assert.equal(resolved.workingDirectory, ".");
});
