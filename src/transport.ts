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

export interface HTTPResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface TransportLimits {
  continueTimeoutMs: number;
  requestTimeoutMs: number;
  responseBytes: number;
  retryAttempts: number;
}

export interface SubmitRequest<TCapture> {
  endpoint: URL;
  material: IdempotencyMaterial;
  getOIDCToken: () => Promise<string>;
  writeBody: (
    request: ClientRequest,
    boundary: string,
    signal: AbortSignal,
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

function attemptRequest<TCapture>(
  endpoint: URL,
  token: string,
  idempotencyKey: string,
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
    const timers: {
      continue?: NodeJS.Timeout;
      request?: NodeJS.Timeout;
    } = {};

    const cleanup = (): void => {
      if (timers.continue !== undefined) clearTimeout(timers.continue);
      if (timers.request !== undefined) clearTimeout(timers.request);
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
        error instanceof Error ? error : new Error("transport attempt failed"),
      );
    };

    const request = requestForURL(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "idempotency-key": idempotencyKey,
        "user-agent": `chamber-terraform-evidence-action/${ACTION_VERSION}`,
        expect: "100-continue",
      },
    });

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

    const beginBody = (): void => {
      if (bodyStarted || responseSeen || settled) return;
      bodyStarted = true;
      if (timers.continue !== undefined) clearTimeout(timers.continue);
      void writeBody(request, boundary, captureAbort.signal)
        .then((result) => {
          capture = result;
          bodyCompleted = true;
          request.end();
        })
        .catch(() => {
          request.destroy();
          if (!responseSeen) settleReject(new AttemptNetworkError(true));
        });
    };

    request.once("continue", beginBody);
    request.once("response", (response) => {
      responseSeen = true;
      if (timers.continue !== undefined) clearTimeout(timers.continue);
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

    timers.continue = setTimeout(beginBody, limits.continueTimeoutMs);
    timers.continue.unref();
    timers.request = setTimeout(() => {
      captureAbort.abort();
      request.destroy();
      settleReject(new AttemptNetworkError(bodyStarted));
    }, limits.requestTimeoutMs);
    timers.request.unref();
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
    continueTimeoutMs:
      request.limits?.continueTimeoutMs ?? LIMITS.continueTimeoutMs,
    requestTimeoutMs:
      request.limits?.requestTimeoutMs ?? LIMITS.requestTimeoutMs,
    responseBytes: request.limits?.responseBytes ?? LIMITS.responseBytes,
    retryAttempts: request.limits?.retryAttempts ?? LIMITS.retryAttempts,
  };
  const sleep = request.sleep ?? defaultSleep;
  let stableClaims: OIDCStableClaims | undefined;
  let idempotencyKey: string | undefined;
  const seenTokenIdentifiers = new Set<string>();

  for (let attempt = 1; attempt <= limits.retryAttempts; attempt += 1) {
    if (signalAborted(request.signal)) {
      throw new SafeError(
        "action_cancelled",
        "Terraform evidence capture was cancelled.",
      );
    }
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
    if (idempotencyKey === undefined) {
      throw new SafeError(
        "idempotency_key_unavailable",
        "The Action could not derive a stable idempotency key.",
      );
    }
    const currentIdempotencyKey = idempotencyKey;

    let result: AttemptResult<TCapture>;
    try {
      result = await attemptRequest(
        request.endpoint,
        token,
        currentIdempotencyKey,
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

    if (
      !result.bodyStarted &&
      retryableStatus(result.response.statusCode) &&
      attempt < limits.retryAttempts
    ) {
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
    "Chamber could not be reached before evidence streaming began.",
  );
}
