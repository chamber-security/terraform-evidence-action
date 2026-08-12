import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { LIMITS } from "./constants";
import { SafeError } from "./errors";

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DECIMAL_ID_PATTERN = /^[0-9]+$/u;

export interface PullRequestContext {
  pullRequestNumber?: number;
  pullRequestHeadSHA?: string;
  pullRequestBaseSHA?: string;
}

export interface OIDCStableClaims {
  repositoryID: string;
  runID: string;
  runAttempt: string;
  checkRunID: string;
}

export interface IdempotencyMaterial {
  submissionID: string;
  evidenceKind: "plan" | "state";
  workingDirectory: string;
  selector: string;
}

function decodeOIDCPayload(token: string): Record<string, unknown> {
  const segments = token.split(".");
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) {
    throw new SafeError(
      "oidc_token_invalid",
      "GitHub returned an invalid OIDC token.",
    );
  }
  let payload: unknown;
  try {
    const decoded = Buffer.from(payloadSegment, "base64url");
    if (decoded.length > 16 * 1024) throw new Error("bounded");
    payload = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new SafeError(
      "oidc_token_invalid",
      "GitHub returned an invalid OIDC token.",
    );
  }
  const claims = asRecord(payload);
  if (claims === undefined) {
    throw new SafeError(
      "oidc_token_invalid",
      "GitHub returned an invalid OIDC token.",
    );
  }
  return claims;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizedSHA(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return SHA_PATTERN.test(normalized) ? normalized : undefined;
}

export function requireSHA(value: string | undefined, name: string): string {
  const sha = normalizedSHA(value);
  if (sha === undefined) {
    throw new SafeError(
      "github_context_invalid",
      `${name} must contain a full Git commit SHA.`,
    );
  }
  return sha;
}

export async function readPullRequestContext(
  eventPath: string | undefined,
): Promise<PullRequestContext> {
  if (eventPath === undefined || eventPath === "") return {};
  let eventStat;
  try {
    eventStat = await stat(eventPath);
  } catch {
    throw new SafeError(
      "github_event_unavailable",
      "The GitHub event metadata file could not be read.",
    );
  }
  if (!eventStat.isFile() || eventStat.size > LIMITS.eventBytes) {
    throw new SafeError(
      "github_event_invalid",
      "The GitHub event metadata exceeds the Action's safe bound.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
  } catch {
    throw new SafeError(
      "github_event_invalid",
      "The GitHub event metadata is not valid JSON.",
    );
  }
  const root = asRecord(parsed);
  const pullRequest = asRecord(root?.pull_request);
  if (pullRequest === undefined) return {};
  const head = asRecord(pullRequest.head);
  const base = asRecord(pullRequest.base);
  const number =
    typeof pullRequest.number === "number"
      ? pullRequest.number
      : typeof root?.number === "number"
        ? root.number
        : undefined;
  if (number === undefined || !Number.isSafeInteger(number) || number <= 0) {
    throw new SafeError(
      "github_pr_context_invalid",
      "Pull request evidence requires a valid event pull request number.",
    );
  }
  const headSHA = normalizedSHA(head?.sha);
  const baseSHA = normalizedSHA(base?.sha);
  if (headSHA === undefined || baseSHA === undefined) {
    throw new SafeError(
      "github_pr_context_invalid",
      "Pull request evidence requires full head and base commit SHAs.",
    );
  }
  return {
    pullRequestNumber: number,
    pullRequestHeadSHA: headSHA,
    pullRequestBaseSHA: baseSHA,
  };
}

function requiredDecimalClaim(
  payload: Record<string, unknown>,
  name: string,
): string {
  const value = payload[name];
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!DECIMAL_ID_PATTERN.test(normalized) || normalized.length > 64) {
    throw new SafeError(
      "oidc_claims_unavailable",
      "The GitHub OIDC token is missing stable submission claims.",
    );
  }
  return normalized;
}

export function decodeStableOIDCClaims(token: string): OIDCStableClaims {
  const claims = decodeOIDCPayload(token);
  return {
    repositoryID: requiredDecimalClaim(claims, "repository_id"),
    runID: requiredDecimalClaim(claims, "run_id"),
    runAttempt: requiredDecimalClaim(claims, "run_attempt"),
    checkRunID: requiredDecimalClaim(claims, "check_run_id"),
  };
}

export function decodeOIDCTokenJTI(token: string): string {
  const jti = decodeOIDCPayload(token).jti;
  const hasControlCharacter = (value: string): boolean => {
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 31 || code === 127) return true;
    }
    return false;
  };
  if (
    typeof jti !== "string" ||
    jti.length === 0 ||
    jti.length > 255 ||
    hasControlCharacter(jti)
  ) {
    throw new SafeError(
      "oidc_token_invalid",
      "GitHub returned an OIDC token without a usable token identifier.",
    );
  }
  return jti;
}

export function sameStableClaims(
  left: OIDCStableClaims,
  right: OIDCStableClaims,
): boolean {
  return (
    left.repositoryID === right.repositoryID &&
    left.runID === right.runID &&
    left.runAttempt === right.runAttempt &&
    left.checkRunID === right.checkRunID
  );
}

export function deriveIdempotencyKey(
  claims: OIDCStableClaims,
  material: IdempotencyMaterial,
): string {
  const canonical = JSON.stringify([
    claims.repositoryID,
    claims.runID,
    claims.runAttempt,
    claims.checkRunID,
    material.submissionID,
    material.evidenceKind,
    material.workingDirectory,
    material.selector,
  ]);
  return `sha256=${createHash("sha256").update(canonical).digest("hex")}`;
}

export function boundedGitHubJob(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  let containsControlCharacter = false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      containsControlCharacter = true;
      break;
    }
  }
  if (value.length > 255 || containsControlCharacter) {
    return undefined;
  }
  return value;
}
