import assert from "node:assert/strict";
import test from "node:test";

import { decodeStableOIDCClaims, deriveIdempotencyKey } from "../src/github";
import { fakeJWT } from "./helpers";

const claims = {
  repository_id: "123456789",
  run_id: "987654321",
  run_attempt: "2",
  check_run_id: "555555",
};

void test("derives the frozen server-recomputable idempotency test vector", () => {
  const parsed = decodeStableOIDCClaims(fakeJWT(claims));
  assert.deepEqual(parsed, {
    repositoryID: "123456789",
    runID: "987654321",
    runAttempt: "2",
    checkRunID: "555555",
  });
  assert.equal(
    JSON.stringify([
      "123456789",
      "987654321",
      "2",
      "555555",
      "018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10",
      "plan",
      "terraform/prod",
      "prod",
    ]),
    '["123456789","987654321","2","555555","018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10","plan","terraform/prod","prod"]',
  );
  assert.equal(
    deriveIdempotencyKey(parsed, {
      submissionID: "018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10",
      evidenceKind: "plan",
      workingDirectory: "terraform/prod",
      selector: "prod",
    }),
    "sha256=e8493bb4610c15c987d761986e3f61edb464a9e06f5f78e2b9280bc06bbea17a",
  );
});

void test("keeps the key stable across fresh tokens", () => {
  const left = decodeStableOIDCClaims(fakeJWT({ ...claims, jti: "one" }));
  const right = decodeStableOIDCClaims(fakeJWT({ ...claims, jti: "two" }));
  const material = {
    submissionID: "018f5f36-88df-7a95-9e42-2bc2f09da610",
    evidenceKind: "state" as const,
    workingDirectory: ".",
    selector: "default",
  };
  assert.equal(
    deriveIdempotencyKey(left, material),
    deriveIdempotencyKey(right, material),
  );
});
