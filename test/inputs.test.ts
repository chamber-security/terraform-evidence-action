import assert from "node:assert/strict";
import test from "node:test";

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
        "https://api.chamber.security/integrations/github-actions/terraform-evidence",
      ),
    },
  );
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
