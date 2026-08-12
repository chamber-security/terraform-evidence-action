import { SafeError } from "./errors";
import type { HTTPResponse } from "./transport";
import type { Diagnostic, Receipt, ReceiptEnvelope } from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalUUID(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value
    : undefined;
}

function parseDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  const diagnostics: Diagnostic[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const code = record?.code;
    const severity = record?.severity;
    const message = record?.message;
    let containsControlCharacter = false;
    if (typeof message === "string") {
      for (const character of message) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (
          codePoint <= 8 ||
          codePoint === 11 ||
          codePoint === 12 ||
          (codePoint >= 14 && codePoint <= 31) ||
          codePoint === 127
        ) {
          containsControlCharacter = true;
          break;
        }
      }
    }
    if (
      typeof code !== "string" ||
      !CODE_PATTERN.test(code) ||
      (severity !== "notice" &&
        severity !== "warning" &&
        severity !== "error") ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > 1024 ||
      containsControlCharacter
    ) {
      continue;
    }
    diagnostics.push({ code, severity, message });
  }
  return diagnostics;
}

function parseJSON(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new SafeError(
      "invalid_server_response",
      "Chamber returned an invalid response.",
    );
  }
}

function rejectionMessage(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Chamber rejected the submission metadata.";
    case 401:
      return "Chamber rejected GitHub OIDC authentication.";
    case 403:
      return "This repository is not admitted by its active Chamber GitHub App installation.";
    case 409:
      return "The Terraform evidence idempotency key conflicts with a different submission.";
    case 413:
      return "The Terraform evidence submission exceeded Chamber's size limit.";
    case 422:
      return "Chamber safely rejected the Terraform evidence document.";
    default:
      return "Chamber could not accept the Terraform evidence submission.";
  }
}

export class ServerRejectionError extends SafeError {
  readonly invocationID: string | undefined;
  readonly status: string;
  readonly diagnostics: Diagnostic[];

  constructor(
    code: string,
    message: string,
    status: string,
    invocationID: string | undefined,
    diagnostics: Diagnostic[],
  ) {
    super(code, message);
    this.name = "ServerRejectionError";
    this.status = status;
    this.invocationID = invocationID;
    this.diagnostics = diagnostics;
  }
}

export function parseReceipt(response: HTTPResponse): ReceiptEnvelope {
  const parsed = parseJSON(response.body);
  const root = asRecord(parsed);
  if (response.statusCode !== 202) {
    const error = asRecord(root?.error);
    const details = asRecord(error?.details);
    const responseCode = error?.code;
    const code =
      typeof responseCode === "string" && CODE_PATTERN.test(responseCode)
        ? responseCode
        : `http_${response.statusCode}`;
    const status =
      typeof details?.status === "string" && CODE_PATTERN.test(details.status)
        ? details.status
        : "rejected";
    throw new ServerRejectionError(
      code,
      rejectionMessage(response.statusCode),
      status,
      optionalUUID(details?.invocation_id),
      parseDiagnostics(details?.diagnostics),
    );
  }
  const data = asRecord(root?.data);
  const invocationID = optionalUUID(data?.invocation_id);
  const evidenceKind = data?.evidence_kind;
  const status = data?.status;
  const analysisStatus = data?.analysis_status;
  if (
    data === undefined ||
    invocationID === undefined ||
    (evidenceKind !== "plan" && evidenceKind !== "state") ||
    typeof status !== "string" ||
    !CODE_PATTERN.test(status) ||
    typeof analysisStatus !== "string" ||
    !CODE_PATTERN.test(analysisStatus)
  ) {
    throw new SafeError(
      "invalid_server_response",
      "Chamber returned an invalid response.",
    );
  }
  const revisionID = optionalUUID(data.revision_id);
  const assessmentID = optionalUUID(data.assessment_id);
  const receipt: Receipt = {
    invocation_id: invocationID,
    evidence_kind: evidenceKind,
    status,
    analysis_status: analysisStatus,
    diagnostics: parseDiagnostics(data.diagnostics),
    ...(revisionID === undefined ? {} : { revision_id: revisionID }),
    ...(assessmentID === undefined ? {} : { assessment_id: assessmentID }),
  };
  return { data: receipt };
}
