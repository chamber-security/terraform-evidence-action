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
