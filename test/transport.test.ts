import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";

import { AmbiguousTransportError } from "../src/errors";
import { writeWithBackpressure } from "../src/multipart";
import { submitWithFreshOIDC } from "../src/transport";
import type { StartV1 } from "../src/types";
import { fakeJWT } from "./helpers";

const material = {
  submissionID: "018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10",
  evidenceKind: "plan" as const,
  workingDirectory: "terraform/prod",
  selector: "prod",
};

const start: StartV1 = {
  schema_version: 1,
  submission_id: material.submissionID,
  evidence_kind: "plan",
  working_directory: material.workingDirectory,
  instance: "prod",
  checkout_sha: "0123456789abcdef0123456789abcdef01234567",
  github_sha: "0123456789abcdef0123456789abcdef01234567",
  capture_started_at: "2026-08-13T08:00:00.000Z",
  capture_status: "pending",
  reported_plan_outcome: "success",
  action_version: "1.0.2",
};

const startDigest =
  "sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const grantPayload = Buffer.from(
  JSON.stringify({
    admitted_at: "2026-08-13T08:00:00Z",
    ordinal: 41,
    expires_at: "2026-08-13T08:02:00Z",
  }),
).toString("base64url");
const grant = `v1.${grantPayload}.${"a".repeat(43)}`;

function grantResponse(): string {
  return JSON.stringify({
    data: {
      grant,
      start_digest: startDigest,
      expires_at: "2026-08-13T08:02:00Z",
    },
  });
}

function token(jti: string): string {
  return fakeJWT({
    repository_id: "123456789",
    run_id: "987654321",
    run_attempt: "2",
    check_run_id: "555555",
    jti,
  });
}

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  return new URL(`http://127.0.0.1:${address.port}/evidence`);
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

void test("completes authenticated metadata preflight before starting Terraform body", async () => {
  const events: string[] = [];
  const authorizations: string[] = [];
  let uploadBody = "";
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    if (request.url === "/evidence/preflight") {
      events.push("server_preflight");
      void readBody(request).then((body) => {
        assert.deepEqual(JSON.parse(body), start);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(grantResponse());
      });
      return;
    }
    assert.equal(request.url, "/evidence");
    assert.equal(request.headers.expect, undefined);
    assert.equal(request.headers["x-chamber-evidence-grant"], grant);
    assert.equal(request.headers["x-chamber-start-digest"], startDigest);
    events.push("server_upload_headers");
    request.on("data", (chunk: Buffer) => {
      uploadBody += chunk.toString("utf8");
    });
    request.on("end", () => {
      events.push("server_upload_body");
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"data":{"ok":true}}');
    });
  });
  const endpoint = await listen(server);
  const tokens = [token("preflight"), token("upload")];
  const protectedValues: string[] = [];
  try {
    const result = await submitWithFreshOIDC({
      endpoint,
      start,
      material,
      now: () => new Date(start.capture_started_at),
      getOIDCToken: async () => tokens.shift() ?? "",
      protectSecret: (value) => protectedValues.push(value),
      writeBody: async (request, _boundary, signal) => {
        events.push("client_upload_body");
        await writeWithBackpressure(request, "streamed-body", signal);
        return "captured";
      },
      limits: { preflightTimeoutMs: 5000, requestTimeoutMs: 5000 },
    });
    assert.equal(result.response.statusCode, 202);
    assert.equal(result.capture, "captured");
    assert.equal(uploadBody, "streamed-body");
    assert.deepEqual(events, [
      "server_preflight",
      "client_upload_body",
      "server_upload_headers",
      "server_upload_body",
    ]);
    assert.equal(new Set(authorizations).size, 2);
    assert.deepEqual(protectedValues, [grant]);
  } finally {
    await close(server);
  }
});

void test("retries only the safe preflight with fresh tokens before capture", async () => {
  let preflights = 0;
  let uploads = 0;
  const preflightStarts: StartV1[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/evidence/preflight") {
      preflights += 1;
      void readBody(request).then((body) => {
        preflightStarts.push(JSON.parse(body) as StartV1);
        if (preflights === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(grantResponse());
      });
      return;
    }
    uploads += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const endpoint = await listen(server);
  const tokens = [token("first"), token("second"), token("third")];
  const attemptTimes = [
    new Date("2026-08-13T08:00:00Z"),
    new Date("2026-08-13T08:01:01Z"),
  ];
  let bodyCalls = 0;
  let authorizedStart: StartV1 | undefined;
  try {
    const result = await submitWithFreshOIDC({
      endpoint,
      start,
      material,
      getOIDCToken: async () => tokens.shift() ?? "",
      now: () => attemptTimes.shift() ?? new Date("2026-08-13T08:01:01Z"),
      writeBody: async (request, _boundary, signal, successfulStart) => {
        bodyCalls += 1;
        authorizedStart = successfulStart;
        await writeWithBackpressure(request, "body", signal);
        return undefined;
      },
      sleep: async () => undefined,
      limits: {
        retryAttempts: 2,
        preflightTimeoutMs: 5000,
        requestTimeoutMs: 5000,
      },
    });
    assert.equal(result.attempts, 2);
    assert.equal(preflights, 2);
    assert.equal(uploads, 1);
    assert.equal(bodyCalls, 1);
    assert.equal(tokens.length, 0);
    assert.deepEqual(
      preflightStarts.map((value) => value.capture_started_at),
      ["2026-08-13T08:00:00.000Z", "2026-08-13T08:01:01.000Z"],
    );
    assert.equal(
      authorizedStart?.capture_started_at,
      "2026-08-13T08:01:01.000Z",
    );
  } finally {
    await close(server);
  }
});

void test("fails closed when GitHub reissues the preflight token for upload", async () => {
  let uploads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/evidence/preflight") {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(grantResponse());
      });
      return;
    }
    uploads += 1;
    response.end();
  });
  const endpoint = await listen(server);
  try {
    await assert.rejects(
      submitWithFreshOIDC({
        endpoint,
        start,
        material,
        getOIDCToken: async () => token("same-jti"),
        writeBody: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "oidc_token_reused",
    );
    assert.equal(uploads, 0);
  } finally {
    await close(server);
  }
});

void test("reports ambiguity and never retries after upload body starts", async () => {
  let preflights = 0;
  let uploads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/evidence/preflight") {
      preflights += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(grantResponse());
      });
      return;
    }
    uploads += 1;
    request.once("data", () => request.socket.destroy());
  });
  const endpoint = await listen(server);
  let tokenCalls = 0;
  try {
    await assert.rejects(
      submitWithFreshOIDC({
        endpoint,
        start,
        material,
        getOIDCToken: async () => {
          tokenCalls += 1;
          return token(String(tokenCalls));
        },
        writeBody: async (request, _boundary, signal) => {
          await writeWithBackpressure(
            request,
            Buffer.alloc(32 * 1024, "x"),
            signal,
          );
          return undefined;
        },
        sleep: async () => undefined,
        limits: {
          retryAttempts: 3,
          preflightTimeoutMs: 5000,
          requestTimeoutMs: 5000,
        },
      }),
      AmbiguousTransportError,
    );
    assert.equal(preflights, 1);
    assert.equal(uploads, 1);
    assert.equal(tokenCalls, 2);
  } finally {
    await close(server);
  }
});

void test("returns a preflight rejection without starting Terraform or fetching an upload token", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/evidence/preflight");
    request.resume();
    request.on("end", () => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"code":"github_actions_repository_not_admitted"}');
    });
  });
  const endpoint = await listen(server);
  let tokenCalls = 0;
  let bodyCalls = 0;
  try {
    const result = await submitWithFreshOIDC({
      endpoint,
      start,
      material,
      getOIDCToken: async () => {
        tokenCalls += 1;
        return token(String(tokenCalls));
      },
      writeBody: async () => {
        bodyCalls += 1;
        return undefined;
      },
    });
    assert.equal(result.response.statusCode, 403);
    assert.equal(tokenCalls, 1);
    assert.equal(bodyCalls, 0);
  } finally {
    await close(server);
  }
});
