import { randomUUID } from "node:crypto";

import { discoverWorkspace, type CaptureResult, writeCapture } from "./capture";
import {
  runBoundedCommand,
  spawnTerraformShow,
  type CommandRunner,
  type ShowSpawner,
} from "./command";
import { ACTION_VERSION, OIDC_AUDIENCE } from "./constants";
import { SafeError } from "./errors";
import { boundedGitHubJob, readPullRequestContext, requireSHA } from "./github";
import { readInputs, requestedFailureMode } from "./inputs";
import { resolvePaths } from "./paths";
import { parseReceipt, ServerRejectionError } from "./response";
import {
  submitWithFreshOIDC,
  type SubmitRequest,
  type Submission,
} from "./transport";
import type { Diagnostic, FailureMode, Receipt, StartV1 } from "./types";

export interface ActionCore {
  getInput(name: string): string;
  getIDToken(audience: string): Promise<string>;
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  setFailed(message: string): void;
}

export interface ActionDependencies {
  core: ActionCore;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  spawnShow?: ShowSpawner;
  now?: () => Date;
  newSubmissionID?: () => string;
  signal?: AbortSignal;
  submit?: <TCapture>(
    request: SubmitRequest<TCapture>,
  ) => Promise<Submission<TCapture>>;
}

export interface ActionExecution {
  receipt: Receipt;
  capture?: CaptureResult;
  attempts: number;
}

const DIAGNOSTIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  target_unknown:
    "Terraform workspace discovery failed, so Chamber retained the plan without selecting a target.",
  workspace_discovery_failed:
    "Terraform workspace discovery failed; the explicit instance was used.",
  terraform_unavailable: "Terraform is required in PATH for evidence capture.",
  terraform_show_failed:
    "Terraform show failed; Chamber retained only a safe failed-capture receipt.",
  terraform_show_timeout:
    "Terraform show exceeded the capture deadline and was stopped.",
  terraform_show_empty:
    "Terraform show returned no evidence; Chamber retained only a safe failed-capture receipt.",
  evidence_size_limit_exceeded:
    "Terraform show exceeded the uncompressed evidence limit and was stopped.",
  compressed_evidence_size_limit_exceeded:
    "Compressed Terraform evidence exceeded the transport limit and was stopped.",
  terraform_evidence_root_unknown:
    "No active Chamber Terraform Source matches this repository directory.",
  terraform_evidence_source_ambiguous:
    "More than one active Source could own this evidence; pass source-ref or register the intended Source.",
  terraform_evidence_instance_ambiguous:
    "This Terraform root appears to use more than one state; pass a stable instance to each evidence step.",
  evidence_rejected:
    "Chamber rejected the Terraform document after safe validation; no revision or binding was created.",
});

function diagnosticAnnotation(diagnostic: Diagnostic): string {
  return (
    DIAGNOSTIC_MESSAGES[diagnostic.code] ??
    `Chamber reported diagnostic ${diagnostic.code}.`
  );
}

function emitDiagnostic(core: ActionCore, diagnostic: Diagnostic): void {
  const message = diagnosticAnnotation(diagnostic);
  switch (diagnostic.severity) {
    case "notice":
      core.notice(message);
      break;
    case "warning":
      core.warning(message);
      break;
    case "error":
      core.error(message);
      break;
  }
}

function initializeOutputs(core: ActionCore): void {
  for (const output of [
    "status",
    "invocation-id",
    "revision-id",
    "assessment-id",
    "analysis-status",
  ]) {
    core.setOutput(output, "");
  }
}

function writeReceiptOutputs(core: ActionCore, receipt: Receipt): void {
  core.setOutput("status", receipt.status);
  core.setOutput("invocation-id", receipt.invocation_id);
  core.setOutput("revision-id", receipt.revision_id ?? "");
  core.setOutput("assessment-id", receipt.assessment_id ?? "");
  core.setOutput("analysis-status", receipt.analysis_status);
}

export async function executeAction(
  dependencies: ActionDependencies,
): Promise<ActionExecution> {
  const env = dependencies.env ?? process.env;
  const runCommand = dependencies.runCommand ?? runBoundedCommand;
  const spawnShow = dependencies.spawnShow ?? spawnTerraformShow;
  const now = dependencies.now ?? (() => new Date());
  const newSubmissionID = dependencies.newSubmissionID ?? randomUUID;
  const submit = dependencies.submit ?? submitWithFreshOIDC;
  const inputs = readInputs((name) => dependencies.core.getInput(name));
  const paths = await resolvePaths(
    env.GITHUB_WORKSPACE,
    inputs.workingDirectory,
    inputs.planFile,
  );

  const git = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: paths.workspace,
  });
  if (git.exitCode !== 0) {
    throw new SafeError(
      "checkout_sha_unavailable",
      "The checked-out Git commit could not be identified.",
    );
  }
  const checkoutSHA = requireSHA(git.stdout, "git rev-parse HEAD");
  const githubSHA = requireSHA(env.GITHUB_SHA, "GITHUB_SHA");
  const pullRequest = await readPullRequestContext(env.GITHUB_EVENT_PATH);
  const selection = await discoverWorkspace(
    runCommand,
    paths.workingDirectoryAbsolute,
    inputs.evidence,
    inputs.instance,
  );
  const submissionID = newSubmissionID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      submissionID,
    )
  ) {
    throw new SafeError(
      "submission_id_invalid",
      "The Action could not allocate a valid submission identifier.",
    );
  }
  const githubJob = boundedGitHubJob(env.GITHUB_JOB);

  const start: StartV1 = {
    schema_version: 1,
    ...(inputs.production === undefined
      ? {}
      : { production: inputs.production }),
    submission_id: submissionID,
    evidence_kind: inputs.evidence,
    working_directory: paths.workingDirectory,
    checkout_sha: checkoutSHA,
    github_sha: githubSHA,
    action_version: ACTION_VERSION,
    capture_started_at: now().toISOString(),
    capture_status: "pending",
    ...(selection.instance === undefined
      ? {}
      : { instance: selection.instance }),
    ...(inputs.sourceRef === undefined ? {} : { source_ref: inputs.sourceRef }),
    ...(selection.terraformWorkspace === undefined
      ? {}
      : { terraform_workspace: selection.terraformWorkspace }),
    ...(pullRequest.pullRequestNumber === undefined
      ? {}
      : { pull_request_number: pullRequest.pullRequestNumber }),
    ...(pullRequest.pullRequestHeadSHA === undefined
      ? {}
      : { pull_request_head_sha: pullRequest.pullRequestHeadSHA }),
    ...(pullRequest.pullRequestBaseSHA === undefined
      ? {}
      : { pull_request_base_sha: pullRequest.pullRequestBaseSHA }),
    ...(githubJob === undefined ? {} : { github_job: githubJob }),
    ...(inputs.evidence === "plan"
      ? { reported_plan_outcome: "success" as const }
      : inputs.applyOutcome === undefined
        ? {}
        : {
            reported_apply_outcome: inputs.applyOutcome,
          }),
  };
  let bodyInvoked = false;
  const submission = await submit<CaptureResult>({
    endpoint: inputs.endpoint,
    start,
    material: {
      submissionID,
      evidenceKind: inputs.evidence,
      workingDirectory: paths.workingDirectory,
      selector: selection.selector,
    },
    getOIDCToken: async () => {
      const token = await dependencies.core.getIDToken(OIDC_AUDIENCE);
      dependencies.core.setSecret(token);
      return token;
    },
    now,
    protectSecret: (value) => {
      dependencies.core.setSecret(value);
    },
    writeBody: async (destination, boundary, signal, authorizedStart) => {
      if (bodyInvoked) {
        throw new SafeError(
          "capture_replay_blocked",
          "The Action refused to rerun Terraform under one submission.",
        );
      }
      bodyInvoked = true;
      return await writeCapture(destination, boundary, signal, {
        start: authorizedStart,
        evidenceKind: inputs.evidence,
        workingDirectoryAbsolute: paths.workingDirectoryAbsolute,
        ...(paths.planFile === undefined ? {} : { planFile: paths.planFile }),
        selection,
        spawnShow,
        now,
      });
    },
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal }),
  });
  const receipt = parseReceipt(submission.response).data;
  return {
    receipt,
    ...(submission.capture === undefined
      ? {}
      : { capture: submission.capture }),
    attempts: submission.attempts,
  };
}

export async function runAction(
  dependencies: ActionDependencies,
): Promise<void> {
  const { core } = dependencies;
  const failureMode: FailureMode = requestedFailureMode(
    (name: string): string => core.getInput(name),
  );
  initializeOutputs(core);
  try {
    const execution = await executeAction(dependencies);
    writeReceiptOutputs(core, execution.receipt);
    for (const diagnostic of execution.receipt.diagnostics) {
      emitDiagnostic(core, diagnostic);
    }
    if (execution.capture?.diagnosticCode !== undefined) {
      emitDiagnostic(core, {
        code: execution.capture.diagnosticCode,
        severity:
          execution.capture.captureStatus === "failed" ? "warning" : "notice",
        message: "safe client diagnostic",
      });
    }
    core.info(
      `Chamber recorded Terraform ${execution.receipt.evidence_kind} evidence with status ${execution.receipt.status}.`,
    );
    if (
      failureMode === "error" &&
      execution.receipt.status !== "accepted" &&
      execution.receipt.status !== "superseded"
    ) {
      core.setFailed(
        "Chamber did not accept a Terraform evidence revision; failure-mode is error.",
      );
    }
  } catch (error) {
    if (error instanceof ServerRejectionError) {
      core.setOutput("status", error.status);
      core.setOutput("invocation-id", error.invocationID ?? "");
      for (const diagnostic of error.diagnostics)
        emitDiagnostic(core, diagnostic);
    } else {
      core.setOutput("status", "action_failed");
    }
    const safe =
      error instanceof SafeError
        ? error
        : new SafeError(
            "unexpected_action_error",
            "The Terraform evidence Action failed without exposing command output.",
          );
    core.warning(`${safe.message} (${safe.code})`);
    if (failureMode === "error") core.setFailed(safe.message);
  }
}
