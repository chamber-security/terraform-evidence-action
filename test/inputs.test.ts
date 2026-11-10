import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_ENDPOINT } from "../src/constants";
import { SafeError } from "../src/errors";
import { readInputs } from "../src/inputs";

function read(values: Record<string, string>) {
  return readInputs((name) => values[name] ?? "");
}

void test("reads the exact plan input contract", () => {
  assert.deepEqual(
    read({
      evidence: "plan",
      "plan-file": "saved.tfplan",
      "working-directory": "terraform/prod",
      instance: "prod",
      "source-ref": "main",
      "failure-mode": "error",
    }),
    {
      evidence: "plan",
      planFile: "saved.tfplan",
      workingDirectory: "terraform/prod",
      instance: "prod",
      sourceRef: "main",
      failureMode: "error",
      endpoint: new URL(
        "https://api.chambersecurity.io/integrations/github-actions/terraform-evidence",
      ),
    },
  );
});

void test("defaults to Chamber's production API on a domain Chamber owns", async () => {
  const production =
    "https://api.chambersecurity.io/integrations/github-actions/terraform-evidence";
  assert.equal(
    read({ evidence: "plan", "plan-file": "saved.tfplan" }).endpoint.href,
    production,
  );
  assert.equal(DEFAULT_ENDPOINT, production);
  const metadata = await readFile("action.yml", "utf8");
  const declared = /^ {2}endpoint:\n(?: {4}.*\n)*? {4}default: (\S+)$/mu.exec(
    metadata,
  );
  assert.equal(declared?.[1], DEFAULT_ENDPOINT);
});

void test("requires state outcome and rejects skipped", () => {
  assert.throws(
    () => read({ evidence: "state", "apply-outcome": "skipped" }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "apply_outcome_required",
  );
});

void test("rejects unsafe endpoint and invalid selector", () => {
  assert.throws(
    () =>
      read({
        evidence: "plan",
        "plan-file": "plan",
        instance: "bad selector",
      }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "invalid_instance",
  );
  assert.throws(
    () =>
      read({
        evidence: "plan",
        "plan-file": "plan",
        endpoint: "http://api.example.test",
      }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "invalid_endpoint",
  );
});

void test("state requires an explicit production boolean, with no default", () => {
  for (const value of ["true", "false"]) {
    assert.equal(
      read({ evidence: "state", "apply-outcome": "success", production: value })
        .production,
      value === "true",
    );
  }
  for (const value of ["", "other", "1", "False", "mixed"]) {
    assert.throws(
      () =>
        read({
          evidence: "state",
          "apply-outcome": "success",
          production: value,
        }),
      (error: unknown) =>
        error instanceof SafeError && error.code === "production_required",
    );
  }
  assert.throws(
    () => read({ evidence: "plan", "plan-file": "plan", production: "true" }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "production_not_allowed",
  );
});
