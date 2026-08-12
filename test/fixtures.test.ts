import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseReceipt } from "../src/response";
import type { CompletionV1, StartV1 } from "../src/types";

const backendFixtures = path.resolve(process.cwd(), "test/fixtures/backend-v1");

async function readJSON(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(backendFixtures, name), "utf8"),
  ) as unknown;
}

void test("decodes backend-frozen start and completion fixtures", async () => {
  const start = (await readJSON("start-v1-plan.json")) as StartV1;
  const completion = (await readJSON(
    "completion-v1-succeeded.json",
  )) as CompletionV1;
  assert.equal(start.schema_version, 1);
  assert.equal(start.evidence_kind, "plan");
  assert.equal(start.capture_status, "pending");
  assert.equal(completion.schema_version, 1);
  assert.equal(completion.capture_status, "succeeded");
});

void test("parses the backend-frozen accepted response fixture", async () => {
  const body = Buffer.from(
    JSON.stringify(await readJSON("response-v1-accepted.json")),
  );
  const response = parseReceipt({
    statusCode: 202,
    headers: {},
    body,
  });
  assert.equal(
    response.data.invocation_id,
    "c7e7e9ef-a483-4a0c-b7e2-4f130d8a47ab",
  );
  assert.equal(response.data.analysis_status, "pending_snapshot");
});
