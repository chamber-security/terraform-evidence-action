import { DEFAULT_ENDPOINT } from "./constants";
import { SafeError } from "./errors";
import type { ActionInputs, ApplyOutcome, FailureMode } from "./types";

export type InputReader = (name: string) => string;

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function optionalText(
  value: string,
  name: string,
  maximumLength: number,
): string | undefined {
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > maximumLength || hasControlCharacter(normalized)) {
    throw new SafeError(
      "invalid_input",
      `The ${name} input is not a bounded printable value.`,
    );
  }
  return normalized;
}

function parseEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw || DEFAULT_ENDPOINT);
  } catch {
    throw new SafeError(
      "invalid_endpoint",
      "The endpoint input must be a valid HTTPS URL.",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new SafeError(
      "invalid_endpoint",
      "The endpoint input must be an HTTPS URL without credentials or a fragment.",
    );
  }
  return endpoint;
}

export function readInputs(getInput: InputReader): ActionInputs {
  const evidenceInput = getInput("evidence").trim();
  if (evidenceInput !== "plan" && evidenceInput !== "state") {
    throw new SafeError(
      "invalid_evidence_kind",
      "The evidence input must be plan or state.",
    );
  }
  const evidence = evidenceInput;

  const failureModeInput = getInput("failure-mode").trim() || "warn";
  if (failureModeInput !== "warn" && failureModeInput !== "error") {
    throw new SafeError(
      "invalid_failure_mode",
      "The failure-mode input must be warn or error.",
    );
  }
  const failureMode = failureModeInput;

  const instance = optionalText(getInput("instance"), "instance", 120);
  if (instance !== undefined && !INSTANCE_PATTERN.test(instance)) {
    throw new SafeError(
      "invalid_instance",
      "The instance input must be 1–120 ASCII letters, digits, dots, underscores, or hyphens and begin with a letter or digit.",
    );
  }

  const sourceRef = optionalText(getInput("source-ref"), "source-ref", 512);
  const planFile = optionalText(getInput("plan-file"), "plan-file", 1024);
  const applyOutcomeInput = optionalText(
    getInput("apply-outcome"),
    "apply-outcome",
    16,
  );
  let applyOutcome: ApplyOutcome | undefined;

  if (evidence === "plan" && planFile === undefined) {
    throw new SafeError(
      "plan_file_required",
      "The plan-file input is required for plan evidence.",
    );
  }
  if (evidence === "state" && planFile !== undefined) {
    throw new SafeError(
      "plan_file_not_allowed",
      "The plan-file input is only valid for plan evidence.",
    );
  }
  if (evidence === "state") {
    if (
      applyOutcomeInput !== "success" &&
      applyOutcomeInput !== "failure" &&
      applyOutcomeInput !== "cancelled"
    ) {
      throw new SafeError(
        "apply_outcome_required",
        "State evidence requires apply-outcome set to success, failure, or cancelled; skipped is not accepted.",
      );
    }
    applyOutcome = applyOutcomeInput;
  } else if (applyOutcomeInput !== undefined) {
    throw new SafeError(
      "apply_outcome_not_allowed",
      "The apply-outcome input is only valid for state evidence.",
    );
  }

  const workingDirectory = getInput("working-directory").trim() || ".";
  const endpoint = parseEndpoint(getInput("endpoint").trim());

  return {
    evidence,
    workingDirectory,
    failureMode,
    endpoint,
    ...(planFile === undefined ? {} : { planFile }),
    ...(instance === undefined ? {} : { instance }),
    ...(sourceRef === undefined ? {} : { sourceRef }),
    ...(applyOutcome === undefined ? {} : { applyOutcome }),
  };
}

export function requestedFailureMode(getInput: InputReader): FailureMode {
  const value = getInput("failure-mode").trim();
  // Only a valid, explicit warn may soften failures. Invalid control input is
  // fail-closed even though readInputs will later emit its bounded diagnostic.
  return value === "warn" || value === "" ? "warn" : "error";
}
