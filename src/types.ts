export type EvidenceKind = "plan" | "state";
export type FailureMode = "warn" | "error";
export type ApplyOutcome = "success" | "failure" | "cancelled";
export type CaptureStatus = "pending" | "succeeded" | "failed";

export interface ActionInputs {
  evidence: EvidenceKind;
  workingDirectory: string;
  planFile?: string;
  instance?: string;
  sourceRef?: string;
  applyOutcome?: ApplyOutcome;
  production?: boolean;
  failureMode: FailureMode;
  endpoint: URL;
}

export interface StartV1 {
  schema_version: 1;
  submission_id: string;
  evidence_kind: EvidenceKind;
  working_directory: string;
  instance?: string;
  source_ref?: string;
  terraform_workspace?: string;
  checkout_sha: string;
  github_sha: string;
  pull_request_number?: number;
  pull_request_head_sha?: string;
  pull_request_base_sha?: string;
  github_job?: string;
  capture_started_at: string;
  capture_status: "pending";
  reported_plan_outcome?: "success";
  reported_apply_outcome?: ApplyOutcome;
  production?: boolean;
  action_version: string;
}

export interface CompletionV1 {
  schema_version: 1;
  capture_status: Exclude<CaptureStatus, "pending">;
  capture_completed_at: string;
  capture_diagnostic_code?: string;
}

export interface Diagnostic {
  code: string;
  severity: "notice" | "warning" | "error";
  message: string;
}

export interface Receipt {
  invocation_id: string;
  evidence_kind: EvidenceKind;
  status: string;
  revision_id?: string;
  assessment_id?: string;
  analysis_status: string;
  diagnostics: Diagnostic[];
}

export interface ReceiptEnvelope {
  data: Receipt;
}
