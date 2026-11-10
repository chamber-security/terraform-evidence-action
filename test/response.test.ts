import assert from "node:assert/strict";
import test from "node:test";

import { SafeError } from "../src/errors";
import { parseReceipt, ServerRejectionError } from "../src/response";

void test("returns only allowlisted receipt fields and diagnostics", () => {
  const receipt = parseReceipt({
    statusCode: 202,
    headers: {},
    body: Buffer.from(
      JSON.stringify({
        data: {
          invocation_id: "c7e7e9ef-a483-4a0c-b7e2-4f130d8a47ab",
          evidence_kind: "state",
          status: "not_captured",
          analysis_status: "not_requested",
          diagnostics: [
            {
              code: "terraform_show_failed",
              severity: "warning",
              message: "bounded server message",
              raw_output: "SECRET_CANARY",
            },
          ],
          raw_payload: "SECRET_CANARY",
        },
      }),
    ),
  });
  assert.deepEqual(receipt.data.diagnostics, [
    {
      code: "terraform_show_failed",
      severity: "warning",
      message: "bounded server message",
    },
  ]);
  assert.equal(JSON.stringify(receipt).includes("SECRET_CANARY"), false);
});

void test("maps typed rejection to a safe fixed message", () => {
  assert.throws(
    () =>
      parseReceipt({
        statusCode: 422,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            error: {
              code: "evidence_rejected",
              message: "raw unsafe server message SECRET_CANARY",
              details: {
                status: "evidence_rejected",
                invocation_id: "c7e7e9ef-a483-4a0c-b7e2-4f130d8a47ab",
                diagnostics: [],
              },
            },
          }),
        ),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ServerRejectionError);
      assert.equal(
        error.message,
        "Chamber safely rejected the Terraform evidence document.",
      );
      assert.equal(error.message.includes("SECRET_CANARY"), false);
      assert.equal(error.invocationID, "c7e7e9ef-a483-4a0c-b7e2-4f130d8a47ab");
      return true;
    },
  );
});

function rejection(statusCode: number, code: string): ServerRejectionError {
  try {
    parseReceipt({
      statusCode,
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          error: {
            code,
            message: "raw unsafe server message SECRET_CANARY",
            details: { status: "rejected" },
          },
        }),
      ),
    });
  } catch (error: unknown) {
    if (error instanceof ServerRejectionError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

void test("words a rejection by Chamber's code before its HTTP status", () => {
  const cases: [number, string, string][] = [
    [
      409,
      "terraform_evidence_invalid",
      "Chamber could not match this evidence to a single active Source, Terraform target and verified run of this repository.",
    ],
    [
      409,
      "terraform_evidence_idempotency_conflict",
      "This evidence conflicts with an earlier submission, or Chamber's Sources or state bindings changed while it was finalized; rerun the job to send a fresh capture.",
    ],
    [
      400,
      "terraform_evidence_root_unknown",
      "No active Chamber Terraform Source matches this repository directory, or the source-ref given.",
    ],
    [
      409,
      "terraform_evidence_source_ambiguous",
      "Chamber could not settle which active Source owns this evidence; check this directory's Sources in Chamber, pass source-ref if several share it, and rerun the job.",
    ],
    [
      409,
      "github_actions_oidc_replayed",
      "Chamber had already used this step's GitHub OIDC token; rerun the job.",
    ],
    [
      422,
      "terraform_evidence_invalid",
      "Chamber safely rejected the Terraform evidence document.",
    ],
  ];
  for (const [statusCode, code, message] of cases) {
    const error = rejection(statusCode, code);
    assert.equal(error.code, code);
    assert.equal(error.message, message, `${statusCode} ${code}`);
    assert.equal(error.message.includes("SECRET_CANARY"), false);
  }
});

void test("never words an unrecognised conflict as an idempotency conflict", () => {
  // constructor matches the code pattern and is a key every object inherits.
  for (const code of ["a_future_conflict", "http_409", "constructor"]) {
    const error = rejection(409, code);
    assert.equal(
      error.message,
      "Chamber refused the Terraform evidence because it conflicts with an earlier submission or with Chamber's current Sources.",
    );
  }
});

void test("rejects an oversized or malformed response without echoing it", () => {
  assert.throws(
    () =>
      parseReceipt({
        statusCode: 202,
        headers: {},
        body: Buffer.from("not-json SECRET_CANARY"),
      }),
    (error: unknown) =>
      error instanceof SafeError &&
      error.code === "invalid_server_response" &&
      !error.message.includes("SECRET_CANARY"),
  );
});
