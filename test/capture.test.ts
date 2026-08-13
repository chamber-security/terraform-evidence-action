import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import {
  discoverWorkspace,
  writeCapture,
  type WorkspaceSelection,
} from "../src/capture";
import type { CommandRunner, ShowProcess } from "../src/command";
import type { StartV1 } from "../src/types";
import { MemoryDestination, showProcess } from "./helpers";

const start: StartV1 = {
  schema_version: 1,
  submission_id: "018f5f36-88df-7a95-9e42-2bc2f09da610",
  evidence_kind: "plan",
  working_directory: "terraform/prod",
  instance: "prod",
  terraform_workspace: "prod",
  checkout_sha: "0123456789abcdef0123456789abcdef01234567",
  github_sha: "89abcdef0123456789abcdef0123456789abcdef",
  pull_request_number: 42,
  pull_request_head_sha: "0123456789abcdef0123456789abcdef01234567",
  pull_request_base_sha: "fedcba9876543210fedcba9876543210fedcba98",
  github_job: "terraform-plan-prod",
  reported_plan_outcome: "success",
  action_version: "1.0.2",
  capture_started_at: "2026-08-12T10:11:12.000Z",
  capture_status: "pending",
};

function bodyParts(
  body: Buffer,
  boundary: string,
): {
  start: Record<string, unknown>;
  evidence?: Buffer;
  completion: Record<string, unknown>;
} {
  const extract = (name: string): Buffer | undefined => {
    const disposition = Buffer.from(
      `Content-Disposition: form-data; name="${name}"`,
    );
    const dispositionIndex = body.indexOf(disposition);
    if (dispositionIndex < 0) return undefined;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), dispositionIndex);
    if (headerEnd < 0) return undefined;
    const valueStart = headerEnd + Buffer.byteLength("\r\n\r\n");
    const valueEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), valueStart);
    if (valueEnd < 0) return undefined;
    return body.subarray(valueStart, valueEnd);
  };
  const startPart = extract("start");
  const evidencePart = extract("evidence");
  const completionPart = extract("completion");
  if (startPart === undefined || completionPart === undefined) {
    throw new Error("multipart fixture missing terminal parts");
  }
  return {
    start: JSON.parse(startPart.toString("utf8")) as Record<string, unknown>,
    completion: JSON.parse(completionPart.toString("utf8")) as Record<
      string,
      unknown
    >,
    ...(evidencePart === undefined ? {} : { evidence: evidencePart }),
  };
}

const selected: WorkspaceSelection = {
  instance: "prod",
  terraformWorkspace: "prod",
  selector: "prod",
  captureAllowed: true,
};

function startWithSelectorShape(shape: "explicit" | "unknown"): StartV1 {
  const shaped = { ...start };
  delete shaped.terraform_workspace;
  if (shape === "unknown") delete shaped.instance;
  return shaped;
}

void test("streams ordered start, gzip evidence, and succeeded completion", async () => {
  const destination = new MemoryDestination();
  const controller = new AbortController();
  const timestamps = [new Date("2026-08-12T10:11:18Z")];
  const result = await writeCapture(
    destination,
    "fixture-boundary",
    controller.signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: (args, cwd) => {
        assert.deepEqual(args, ["show", "-json", "saved.tfplan"]);
        assert.equal(cwd, "/workspace/terraform/prod");
        return showProcess(['{"format_version":"1.2"}']);
      },
      now: () => timestamps.shift() ?? new Date(0),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "succeeded");
  const parts = bodyParts(destination.body(), "fixture-boundary");
  assert.equal(parts.start.capture_status, "pending");
  assert.equal(parts.start.capture_started_at, "2026-08-12T10:11:12.000Z");
  assert.equal(parts.completion.capture_status, "succeeded");
  assert.equal(
    parts.completion.capture_completed_at,
    "2026-08-12T10:11:18.000Z",
  );
  assert.equal(
    gunzipSync(parts.evidence ?? Buffer.alloc(0)).toString("utf8"),
    '{"format_version":"1.2"}',
  );
});

void test("finishes a failed receipt after partial Terraform stdout", async () => {
  const destination = new MemoryDestination();
  const result = await writeCapture(
    destination,
    "failed-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => showProcess(["partial-secret-canary"], 1, "raw secret"),
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "failed");
  assert.equal(result.diagnosticCode, "terraform_show_failed");
  const parts = bodyParts(destination.body(), "failed-boundary");
  assert.equal(parts.completion.capture_status, "failed");
  assert.equal(
    parts.completion.capture_diagnostic_code,
    "terraform_show_failed",
  );
  assert.ok(parts.evidence !== undefined);
  assert.equal(destination.body().includes(Buffer.from("raw secret")), false);
});

void test("finishes a start-plus-failed-completion when show cannot start", async () => {
  const destination = new MemoryDestination();
  const result = await writeCapture(
    destination,
    "spawn-failed-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => {
        throw new Error("spawn failed with secret canary");
      },
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "failed");
  const parts = bodyParts(destination.body(), "spawn-failed-boundary");
  assert.equal(parts.evidence, undefined);
  assert.equal(parts.completion.capture_status, "failed");
  assert.equal(
    destination.body().includes(Buffer.from("secret canary")),
    false,
  );
});

void test("finishes a failed completion when the child emits an async start error", async () => {
  const destination = new MemoryDestination();
  const result = await writeCapture(
    destination,
    "async-spawn-failed-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => ({
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        completion: Promise.reject(new Error("secret async spawn failure")),
        kill: () => undefined,
      }),
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "failed");
  assert.equal(result.diagnosticCode, "terraform_show_failed");
  const parts = bodyParts(destination.body(), "async-spawn-failed-boundary");
  assert.equal(parts.completion.capture_status, "failed");
  assert.equal(destination.body().includes(Buffer.from("secret async")), false);
});

void test("writes failed completion without evidence for unknown state selector", async () => {
  const destination = new MemoryDestination();
  let spawned = false;
  const result = await writeCapture(
    destination,
    "unknown-boundary",
    new AbortController().signal,
    {
      start: {
        ...start,
        evidence_kind: "state",
        reported_apply_outcome: "failure",
      },
      evidenceKind: "state",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      selection: {
        selector: "",
        captureAllowed: false,
        diagnosticCode: "target_unknown",
      },
      spawnShow: () => {
        spawned = true;
        return showProcess([]);
      },
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(spawned, false);
  assert.equal(result.captureStatus, "failed");
  const parts = bodyParts(destination.body(), "unknown-boundary");
  assert.equal(parts.evidence, undefined);
  assert.equal(parts.completion.capture_diagnostic_code, "target_unknown");
});

void test("enforces the evidence bound and completes safely", async () => {
  const destination = new MemoryDestination();
  let killed = false;
  const process: ShowProcess = {
    stdout: Readable.from([Buffer.alloc(32, "x")]),
    stderr: Readable.from([]),
    completion: Promise.resolve({ exitCode: 143, signal: "SIGTERM" }),
    kill: () => {
      killed = true;
    },
  };
  const result = await writeCapture(
    destination,
    "limit-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => process,
      now: () => new Date("2026-08-12T10:11:12Z"),
      limits: { evidenceBytes: 16 },
    },
  );
  destination.end();
  assert.equal(killed, true);
  assert.equal(result.diagnosticCode, "evidence_size_limit_exceeded");
  assert.equal(
    bodyParts(destination.body(), "limit-boundary").completion.capture_status,
    "failed",
  );
});

void test("enforces the compressed evidence bound and completes safely", async () => {
  const destination = new MemoryDestination();
  let killed = false;
  const result = await writeCapture(
    destination,
    "compressed-limit-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => ({
        ...showProcess([randomBytes(4096)]),
        kill: () => {
          killed = true;
        },
      }),
      now: () => new Date("2026-08-12T10:11:12Z"),
      limits: { compressedEvidenceBytes: 16 },
    },
  );
  destination.end();
  assert.equal(killed, true);
  assert.equal(
    result.diagnosticCode,
    "compressed_evidence_size_limit_exceeded",
  );
  assert.equal(
    bodyParts(destination.body(), "compressed-limit-boundary").completion
      .capture_status,
    "failed",
  );
});

void test("times out and kills Terraform show before failed completion", async () => {
  const destination = new MemoryDestination();
  const stdout = new Readable({ read() {} });
  let resolveCompletion:
    | ((value: { exitCode: number; signal: NodeJS.Signals | null }) => void)
    | undefined;
  const completion = new Promise<{
    exitCode: number;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveCompletion = resolve;
  });
  let killed = false;
  const result = await writeCapture(
    destination,
    "timeout-boundary",
    new AbortController().signal,
    {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => ({
        stdout,
        stderr: Readable.from([]),
        completion,
        kill: () => {
          killed = true;
          stdout.push(null);
          resolveCompletion?.({ exitCode: 143, signal: "SIGTERM" });
        },
      }),
      now: () => new Date("2026-08-12T10:11:12Z"),
      limits: { captureTimeoutMs: 10 },
    },
  );
  destination.end();
  assert.equal(killed, true);
  assert.equal(result.diagnosticCode, "terraform_show_timeout");
  assert.equal(
    bodyParts(destination.body(), "timeout-boundary").completion.capture_status,
    "failed",
  );
});

void test("kills capture and preserves transport ambiguity on disconnect", async () => {
  const destination = new MemoryDestination();
  const controller = new AbortController();
  let killed = false;
  const process: ShowProcess = {
    stdout: Readable.from(
      (async function* () {
        yield Buffer.alloc(1024, "x");
        controller.abort();
        await Promise.resolve();
      })(),
    ),
    stderr: Readable.from([]),
    completion: Promise.resolve({ exitCode: 143, signal: "SIGTERM" }),
    kill: () => {
      killed = true;
    },
  };
  await assert.rejects(
    writeCapture(destination, "abort-boundary", controller.signal, {
      start,
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: selected,
      spawnShow: () => process,
      now: () => new Date("2026-08-12T10:11:12Z"),
    }),
    (error: unknown) =>
      error instanceof Error &&
      ("code" in error ? error.code === "transport_aborted" : false),
  );
  assert.equal(killed, true);
  destination.end();
  const serialized = destination.body().toString("latin1");
  assert.equal(serialized.includes('name="completion"'), false);
});

void test("workspace discovery encodes only protocol-visible selector forms", async () => {
  const runner =
    (stdout: string, exitCode = 0): CommandRunner =>
    async () => ({ exitCode, stdout, stderrBytes: 0, stderrTruncated: false });
  assert.deepEqual(
    await discoverWorkspace(runner("prod"), "/cwd", "plan", "prod"),
    {
      instance: "prod",
      selector: "prod",
      captureAllowed: true,
    },
  );
  assert.deepEqual(
    await discoverWorkspace(runner("prod"), "/cwd", "plan", undefined),
    {
      instance: "prod",
      terraformWorkspace: "prod",
      selector: "prod",
      captureAllowed: true,
    },
  );
  assert.deepEqual(
    await discoverWorkspace(runner("default"), "/cwd", "state", undefined),
    {
      terraformWorkspace: "default",
      selector: "default",
      captureAllowed: true,
    },
  );
  assert.deepEqual(
    await discoverWorkspace(runner("", 1), "/cwd", "state", undefined),
    {
      selector: "",
      captureAllowed: false,
      diagnosticCode: "target_unknown",
    },
  );
});

void test("explicit selector still captures after workspace diagnostic", async () => {
  const destination = new MemoryDestination();
  const result = await writeCapture(
    destination,
    "workspace-diagnostic-boundary",
    new AbortController().signal,
    {
      start: startWithSelectorShape("explicit"),
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: {
        instance: "prod",
        selector: "prod",
        captureAllowed: true,
        diagnosticCode: "workspace_discovery_failed",
      },
      spawnShow: () => showProcess(['{"format_version":"1.2"}']),
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "succeeded");
  const completion = bodyParts(
    destination.body(),
    "workspace-diagnostic-boundary",
  ).completion;
  assert.equal(completion.capture_status, "succeeded");
  assert.equal(completion.capture_diagnostic_code, undefined);
  assert.equal(result.diagnosticCode, "workspace_discovery_failed");
});

void test("unknown plan target still captures with a safe diagnostic", async () => {
  const destination = new MemoryDestination();
  const result = await writeCapture(
    destination,
    "target-unknown-boundary",
    new AbortController().signal,
    {
      start: startWithSelectorShape("unknown"),
      evidenceKind: "plan",
      workingDirectoryAbsolute: "/workspace/terraform/prod",
      planFile: "saved.tfplan",
      selection: {
        selector: "",
        captureAllowed: true,
        diagnosticCode: "target_unknown",
      },
      spawnShow: () => showProcess(['{"format_version":"1.2"}']),
      now: () => new Date("2026-08-12T10:11:12Z"),
    },
  );
  destination.end();
  assert.equal(result.captureStatus, "succeeded");
  assert.equal(
    bodyParts(destination.body(), "target-unknown-boundary").completion
      .capture_diagnostic_code,
    undefined,
  );
  assert.equal(result.diagnosticCode, "target_unknown");
});
