import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeAction, runAction } from "../src/action";
import type { CommandRunner } from "../src/command";
import type { SubmitRequest } from "../src/transport";
import { FakeCore, MemoryDestination, fakeJWT, showProcess } from "./helpers";

const checkoutSHA = "0123456789abcdef0123456789abcdef01234567";
const githubSHA = "89abcdef0123456789abcdef0123456789abcdef";
const receipt = Buffer.from(
  JSON.stringify({
    data: {
      invocation_id: "c7e7e9ef-a483-4a0c-b7e2-4f130d8a47ab",
      evidence_kind: "plan",
      status: "accepted",
      revision_id: "84d8e2eb-7880-41ad-a153-582988136c18",
      analysis_status: "pending_snapshot",
      diagnostics: [],
    },
  }),
);

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chamber-action-"));
  await mkdir(path.join(root, "terraform", "prod"), { recursive: true });
  await writeFile(path.join(root, "terraform", "prod", "saved.tfplan"), "plan");
  return root;
}

function commandRunner(): CommandRunner {
  return async (executable, args) => {
    if (executable === "git") {
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return {
        exitCode: 0,
        stdout: checkoutSHA,
        stderrBytes: 0,
        stderrTruncated: false,
      };
    }
    assert.deepEqual(args, ["workspace", "show"]);
    return {
      exitCode: 0,
      stdout: "prod",
      stderrBytes: 0,
      stderrTruncated: false,
    };
  };
}

void test("builds exact explicit StartV1 and requests exact OIDC audience", async () => {
  const root = await workspace();
  const token = fakeJWT({
    repository_id: "123456789",
    run_id: "987654321",
    run_attempt: "2",
    check_run_id: "555555",
    jti: "action-test-jti",
  });
  const core = new FakeCore(
    {
      evidence: "plan",
      "working-directory": "terraform/prod",
      "plan-file": "saved.tfplan",
      instance: "prod",
      "failure-mode": "warn",
      endpoint: "https://example.test/evidence",
    },
    [token],
  );
  let submitted: SubmitRequest<unknown> | undefined;
  let submittedBody = "";
  const execution = await executeAction({
    core,
    env: {
      GITHUB_WORKSPACE: root,
      GITHUB_SHA: githubSHA,
      GITHUB_JOB: "terraform-plan-prod",
    },
    runCommand: commandRunner(),
    spawnShow: () => showProcess(['{"format_version":"1.2"}']),
    now: () => new Date("2026-08-12T10:11:12Z"),
    newSubmissionID: () => "018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10",
    submit: async (request) => {
      submitted = request;
      const freshToken = await request.getOIDCToken();
      assert.equal(freshToken, token);
      const destination = new MemoryDestination();
      const capture = await request.writeBody(
        destination as unknown as ClientRequest,
        "action-test-boundary",
        new AbortController().signal,
      );
      destination.end();
      submittedBody = destination.body().toString("latin1");
      return {
        response: { statusCode: 202, headers: {}, body: receipt },
        capture,
        attempts: 1,
        idempotencyKey:
          "sha256=e8493bb4610c15c987d761986e3f61edb464a9e06f5f78e2b9280bc06bbea17a",
      };
    },
  });
  assert.equal(execution.receipt.status, "accepted");
  assert.equal(submitted?.material.selector, "prod");
  assert.match(submittedBody, /"instance":"prod"/u);
  assert.doesNotMatch(submittedBody, /"terraform_workspace"/u);
  assert.deepEqual(core.secrets, [token]);
  assert.deepEqual(core.audiences, [
    "https://api.chamber.security/terraform-evidence",
  ]);
});

void test("warn mode never changes Terraform outcome or logs secrets", async () => {
  const canary = "SECRET_TOKEN_EVIDENCE_STDERR_CANARY";
  const core = new FakeCore({
    evidence: "bad",
    "failure-mode": "warn",
    instance: canary,
  });
  await runAction({ core, env: {} });
  assert.equal(core.failures.length, 0);
  assert.equal(core.outputs.get("status"), "action_failed");
  assert.equal(core.logs.join("\n").includes(canary), false);
});

void test("error mode fails the Action with a safe message", async () => {
  const core = new FakeCore({
    evidence: "state",
    "failure-mode": "error",
    "apply-outcome": "skipped",
  });
  await runAction({ core, env: {} });
  assert.deepEqual(core.failures, [
    "State evidence requires apply-outcome set to success, failure, or cancelled; skipped is not accepted.",
  ]);
});
