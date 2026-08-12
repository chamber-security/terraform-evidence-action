import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ACTION_VERSION, OIDC_AUDIENCE } from "../src/constants";

void test("freezes the version and exact OIDC audience", () => {
  assert.equal(ACTION_VERSION, "1.0.0");
  assert.equal(
    OIDC_AUDIENCE,
    "https://api.chamber.security/terraform-evidence",
  );
});

void test("declares the Node 24 JavaScript runtime and exact public surface", async () => {
  const metadata = await readFile("action.yml", "utf8");
  assert.match(metadata, /using: node24/u);
  for (const input of [
    "evidence",
    "working-directory",
    "plan-file",
    "instance",
    "source-ref",
    "apply-outcome",
    "failure-mode",
    "endpoint",
  ]) {
    assert.match(metadata, new RegExp(`^  ${input}:`, "mu"));
  }
  for (const forbidden of [
    "organization-id",
    "repository-id",
    "source-id",
    "binding-id",
    "deployment-key",
    "token:",
    "lineage",
    "serial",
  ]) {
    assert.doesNotMatch(metadata, new RegExp(`^  ${forbidden}`, "mu"));
  }
});
