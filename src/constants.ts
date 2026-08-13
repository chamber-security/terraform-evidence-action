export const ACTION_VERSION = "1.0.2";
export const OIDC_AUDIENCE = "https://api.chamber.security/terraform-evidence";
export const DEFAULT_ENDPOINT =
  "https://api.chamber.security/integrations/github-actions/terraform-evidence";

export const LIMITS = Object.freeze({
  startBytes: 16 * 1024,
  completionBytes: 4 * 1024,
  responseBytes: 1024 * 1024,
  eventBytes: 1024 * 1024,
  stderrBytes: 4 * 1024,
  commandOutputBytes: 4 * 1024,
  evidenceBytes: 64 * 1024 * 1024,
  compressedEvidenceBytes: 68 * 1024 * 1024,
  preflightTimeoutMs: 30 * 1000,
  commandTimeoutMs: 30 * 1000,
  captureTimeoutMs: 10 * 60 * 1000,
  requestTimeoutMs: 12 * 60 * 1000,
  retryAttempts: 3,
});
