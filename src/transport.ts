import http, {
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import https from "node:https";

import { ACTION_VERSION, LIMITS } from "./constants";
import { AmbiguousTransportError, SafeError } from "./errors";
import {
  decodeStableOIDCClaims,
  decodeOIDCTokenJTI,
  deriveIdempotencyKey,
  sameStableClaims,
  type IdempotencyMaterial,
  type OIDCStableClaims,
} from "./github";
import { createMultipartBoundary } from "./multipart";
import type { StartV1 } from "./types";

export interface HTTPResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface TransportLimits {
  preflightTimeoutMs: number;
  requestTimeoutMs: number;
  responseBytes: number;
  retryAttempts: number;
}

export interface SubmitRequest<TCapture> {
  endpoint: URL;
  start: StartV1;
  material: IdempotencyMaterial;
  getOIDCToken: () => Promise<string>;
  now?: () => Date;
  protectSecret?: (value: string) => void;
  writeBody: (
    request: ClientRequest,
    boundary: string,
    signal: AbortSignal,
    start: StartV1,
  ) => Promise<TCapture>;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  limits?: Partial<TransportLimits>;
}

export interface Submission<TCapture> {
  response: HTTPResponse;
  capture?: TCapture;
  attempts: number;
  idempotencyKey: string;
}

interface AttemptResult<TCapture> {
  response: HTTPResponse;
  capture?: TCapture;
  bodyStarted: boolean;
}

interface PreflightGrant {
  grant: string;
  startDigest: string;
}

class AttemptNetworkError extends Error {
  readonly bodyStarted: boolean;

  constructor(bodyStarted: boolean) {
    super("transport attempt failed");
    this.name = "AttemptNetworkError";
    this.bodyStarted = bodyStarted;
  }
}

function requestForURL(url: URL, options: RequestOptions): ClientRequest {
  return url.protocol === "http:"
    ? http.request(url, options)
    : https.request(url, options);
}

async function readBoundedResponse(
  response: IncomingMessage,
  maximumBytes: number,
): Promise<HTTPResponse> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > maximumBytes) {
      response.destroy();
      throw new SafeError(
        "response_size_limit_exceeded",
        "The Chamber response exceeded the Action's safe bound.",
      );
    }
    chunks.push(chunk);
  }
  return {
    statusCode: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks, length),
  };
}

function preflightURL(endpoint: URL): URL {
  const result = new URL(endpoint.href);
  result.pathname = `${result.pathname.replace(/\/$/u, "")}/preflight`;
  return result;
}

function preflightRequest(
  endpoint: URL,
  token: string,
  idempotencyKey: string,
  start: StartV1,
  limits: TransportLimits,
  callerSignal: AbortSignal | undefined,
): Promise<HTTPResponse> {
  const body = Buffer.from(JSON.stringify(start), "utf8");
  if (body.length > LIMITS.startBytes) {
    return Promise.reject(
      new SafeError(
        "start_size_limit_exceeded",
        "Terraform evidence metadata exceeded the Action's safe bound.",
      ),
    );
  }
  return new Promise<HTTPResponse>((resolve, reject) => {
    let settled = false;
    const request = requestForURL(preflightURL(endpoint), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(body.length),
        "idempotency-key": idempotencyKey,
        "user-agent": `chamber-terraform-evidence-action/${ACTION_VERSION}`,
      },
    });
    const timeout = setTimeout(() => {
      request.destroy();
      settleReject(new AttemptNetworkError(false));
    }, limits.preflightTimeoutMs);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const settleResolve = (response: HTTPResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new AttemptNetworkError(false));
    };
    const onCallerAbort = (): void => {
      request.destroy();
      settleReject(new AttemptNetworkError(false));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted === true) {
      onCallerAbort();
      return;
    }
    request.once("response", (response) => {
      void readBoundedResponse(response, limits.responseBytes).then(
        settleResolve,
        settleReject,
      );
    });
    request.once("error", () => {
      settleReject(new AttemptNetworkError(false));
    });
    request.end(body);
  });
}

function parsePreflightGrant(response: HTTPResponse): PreflightGrant {
  let decoded: unknown;
  try {
    decoded = JSON.parse(response.body.toString("utf8")) as unknown;
  } catch {
    throw new SafeError(
      "preflight_response_invalid",
      "Chamber returned an invalid Terraform evidence preflight response.",
    );
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new SafeError(
      "preflight_response_invalid",
      "Chamber returned an invalid Terraform evidence preflight response.",
    );
  }
  const data = (decoded as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SafeError(
      "preflight_response_invalid",
      "Chamber returned an invalid Terraform evidence preflight response.",
    );
  }
  const values = data as Record<string, unknown>;
  const grant = values.grant;
  const startDigest = values.start_digest;
  const expiresAt = values.expires_at;
  if (
    typeof grant !== "string" ||
    !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(grant) ||
    grant.length > 256 ||
    typeof startDigest !== "string" ||
    !/^sha256=[0-9a-f]{64}$/u.test(startDigest) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new SafeError(
      "preflight_response_invalid",
      "Chamber returned an invalid Terraform evidence preflight response.",
    );
  }
  return { grant, startDigest };
}

function uploadRequest<TCapture>(
  endpoint: URL,
  token: string,
  idempotencyKey: string,
  preflight: PreflightGrant,
  start: StartV1,
  writeBody: SubmitRequest<TCapture>["writeBody"],
  limits: TransportLimits,
  callerSignal: AbortSignal | undefined,
): Promise<AttemptResult<TCapture>> {
  const boundary = createMultipartBoundary();
  return new Promise<AttemptResult<TCapture>>((resolve, reject) => {
    let bodyStarted = false;
    let responseSeen = false;
    let settled = false;
    let bodyCompleted = false;
    let capture: TCapture | undefined;
    const captureAbort = new AbortController();

    const request = requestForURL(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "idempotency-key": idempotencyKey,
        "user-agent": `chamber-terraform-evidence-action/${ACTION_VERSION}`,
        "x-chamber-evidence-grant": preflight.grant,
        "x-chamber-start-digest": preflight.startDigest,
      },
    });
    const timeout = setTimeout(() => {
      captureAbort.abort();
      request.destroy();
      settleReject(new AttemptNetworkError(bodyStarted));
    }, limits.requestTimeoutMs);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const settleResolve = (response: HTTPResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        response,
        ...(capture === undefined ? {} : { capture }),
        bodyStarted,
      });
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error instanceof Error ? error : new AttemptNetworkError(bodyStarted),
      );
    };
    const onCallerAbort = (): void => {
      captureAbort.abort();
      request.destroy();
      settleReject(new AttemptNetworkError(bodyStarted));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted === true) {
      onCallerAbort();
      return;
    }

    request.once("response", (response) => {
      responseSeen = true;
      if (bodyStarted && !bodyCompleted) captureAbort.abort();
      void readBoundedResponse(response, limits.responseBytes).then(
        (boundedResponse) => {
          if (
            boundedResponse.statusCode >= 200 &&
            boundedResponse.statusCode < 300 &&
            bodyStarted &&
            !bodyCompleted
          ) {
            settleReject(new AttemptNetworkError(true));
            return;
          }
          settleResolve(boundedResponse);
        },
        (error: unknown) => {
          settleReject(
            error instanceof SafeError
              ? error
              : new AttemptNetworkError(bodyStarted),
          );
        },
      );
    });
    request.once("error", () => {
      if (!responseSeen) {
        captureAbort.abort();
        settleReject(new AttemptNetworkError(bodyStarted));
      }
    });
    request.flushHeaders();
    bodyStarted = true;
    void writeBody(request, boundary, captureAbort.signal, start)
      .then((result) => {
        capture = result;
        bodyCompleted = true;
        request.end();
      })
      .catch(() => {
        request.destroy();
        if (!responseSeen) settleReject(new AttemptNetworkError(true));
      });
  });
}

function retryableStatus(statusCode: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function submitWithFreshOIDC<TCapture>(
  request: SubmitRequest<TCapture>,
): Promise<Submission<TCapture>> {
  const limits: TransportLimits = {
    preflightTimeoutMs:
      request.limits?.preflightTimeoutMs ?? LIMITS.preflightTimeoutMs,
    requestTimeoutMs:
      request.limits?.requestTimeoutMs ?? LIMITS.requestTimeoutMs,
    responseBytes: request.limits?.responseBytes ?? LIMITS.responseBytes,
    retryAttempts: request.limits?.retryAttempts ?? LIMITS.retryAttempts,
  };
  const sleep = request.sleep ?? defaultSleep;
  const now = request.now ?? (() => new Date());
  let stableClaims: OIDCStableClaims | undefined;
  let idempotencyKey: string | undefined;
  const seenTokenIdentifiers = new Set<string>();

  const freshToken = async (): Promise<string> => {
    let token: string;
    try {
      token = await request.getOIDCToken();
    } catch {
      throw new SafeError(
        "oidc_token_unavailable",
        "GitHub could not issue an OIDC token. Grant this job id-token: write.",
      );
    }
    const tokenIdentifier = decodeOIDCTokenJTI(token);
    if (seenTokenIdentifiers.has(tokenIdentifier)) {
      throw new SafeError(
        "oidc_token_reused",
        "GitHub returned an OIDC token already used by this submission retry.",
      );
    }
    seenTokenIdentifiers.add(tokenIdentifier);
    const claims = decodeStableOIDCClaims(token);
    if (stableClaims === undefined) {
      stableClaims = claims;
      idempotencyKey = deriveIdempotencyKey(claims, request.material);
    } else if (!sameStableClaims(stableClaims, claims)) {
      throw new SafeError(
        "oidc_retry_context_changed",
        "GitHub changed stable workflow claims during a transport retry.",
      );
    }
    return token;
  };

  for (let attempt = 1; attempt <= limits.retryAttempts; attempt += 1) {
    if (signalAborted(request.signal)) {
      throw new SafeError(
        "action_cancelled",
        "Terraform evidence capture was cancelled.",
      );
    }
    const preflightToken = await freshToken();
    if (idempotencyKey === undefined) {
      throw new SafeError(
        "idempotency_key_unavailable",
        "The Action could not derive a stable idempotency key.",
      );
    }
    const currentIdempotencyKey = idempotencyKey;
    // No Terraform process or upload body exists yet, so a safe preflight retry
    // begins a fresh capture attempt. Carry this exact successful Start into the
    // multipart body so backend token-time admission and grant binding agree.
    const attemptStart: StartV1 = {
      ...request.start,
      capture_started_at: now().toISOString(),
    };

    let preflightResponse: HTTPResponse;
    try {
      preflightResponse = await preflightRequest(
        request.endpoint,
        preflightToken,
        currentIdempotencyKey,
        attemptStart,
        limits,
        request.signal,
      );
    } catch (error) {
      if (!(error instanceof AttemptNetworkError)) throw error;
      if (signalAborted(request.signal)) {
        throw new SafeError(
          "action_cancelled",
          "Terraform evidence capture was cancelled.",
        );
      }
      if (attempt === limits.retryAttempts) {
        throw new SafeError(
          "transport_unavailable",
          "Chamber could not authorize Terraform evidence capture.",
        );
      }
      await sleep(250 * attempt);
      continue;
    }
    if (
      retryableStatus(preflightResponse.statusCode) &&
      attempt < limits.retryAttempts
    ) {
      await sleep(250 * attempt);
      continue;
    }
    if (
      preflightResponse.statusCode < 200 ||
      preflightResponse.statusCode >= 300
    ) {
      return {
        response: preflightResponse,
        attempts: attempt,
        idempotencyKey: currentIdempotencyKey,
      };
    }
    const preflight = parsePreflightGrant(preflightResponse);
    request.protectSecret?.(preflight.grant);
    const uploadToken = await freshToken();

    let result: AttemptResult<TCapture>;
    try {
      result = await uploadRequest(
        request.endpoint,
        uploadToken,
        currentIdempotencyKey,
        preflight,
        attemptStart,
        request.writeBody,
        limits,
        request.signal,
      );
    } catch (error) {
      if (!(error instanceof AttemptNetworkError)) throw error;
      if (signalAborted(request.signal)) {
        if (error.bodyStarted) throw new AmbiguousTransportError();
        throw new SafeError(
          "action_cancelled",
          "Terraform evidence capture was cancelled.",
        );
      }
      if (error.bodyStarted) throw new AmbiguousTransportError();
      if (attempt === limits.retryAttempts) {
        throw new SafeError(
          "transport_unavailable",
          "Chamber could not be reached before evidence streaming began.",
        );
      }
      await sleep(250 * attempt);
      continue;
    }
    return {
      response: result.response,
      ...(result.capture === undefined ? {} : { capture: result.capture }),
      attempts: attempt,
      idempotencyKey: currentIdempotencyKey,
    };
  }
  throw new SafeError(
    "transport_unavailable",
    "Chamber could not authorize Terraform evidence capture.",
  );
}
