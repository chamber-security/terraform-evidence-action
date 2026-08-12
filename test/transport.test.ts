import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { AmbiguousTransportError } from "../src/errors";
import { writeWithBackpressure } from "../src/multipart";
import { submitWithFreshOIDC } from "../src/transport";
import { fakeJWT } from "./helpers";

const material = {
  submissionID: "018f47a1-91e4-7cc5-91fe-2f5f5d7a9d10",
  evidenceKind: "plan" as const,
  workingDirectory: "terraform/prod",
  selector: "prod",
};

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

void test("authenticates headers before server sends 100 Continue and starts body", async () => {
  const events: string[] = [];
  let body = "";
  const server = createServer();
  server.on("checkContinue", (request, response) => {
    events.push("server_headers");
    assert.match(request.headers.authorization ?? "", /^Bearer /u);
    assert.equal(
      request.headers["idempotency-key"],
      "sha256=e8493bb4610c15c987d761986e3f61edb464a9e06f5f78e2b9280bc06bbea17a",
    );
    assert.equal(request.headers.expect, "100-continue");
    response.writeContinue();
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      events.push("server_body");
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"data":{"ok":true}}');
    });
  });
  const endpoint = await listen(server);
  try {
    const result = await submitWithFreshOIDC({
      endpoint,
      material,
      getOIDCToken: async () => token("one"),
      writeBody: async (request, _boundary, signal) => {
        events.push("client_body");
        await writeWithBackpressure(request, "streamed-body", signal);
        return "captured";
      },
      limits: { continueTimeoutMs: 5000, requestTimeoutMs: 5000 },
    });
    assert.equal(result.response.statusCode, 202);
    assert.equal(result.capture, "captured");
    assert.equal(body, "streamed-body");
    assert.deepEqual(events, ["server_headers", "client_body", "server_body"]);
  } finally {
    await close(server);
  }
});

void test("retries only before body and fetches a fresh OIDC token", async () => {
  let connections = 0;
  const server = createServer();
  server.on("checkContinue", (request, response) => {
    connections += 1;
    if (connections === 1) {
      request.socket.destroy();
      return;
    }
    response.writeContinue();
    request.resume();
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const endpoint = await listen(server);
  const tokens = [token("first"), token("second")];
  const keys: string[] = [];
  let bodyCalls = 0;
  try {
    const result = await submitWithFreshOIDC({
      endpoint,
      material,
      getOIDCToken: async () => {
        const value = tokens.shift();
        if (value === undefined) throw new Error("missing token");
        return value;
      },
      writeBody: async (request, _boundary, signal) => {
        bodyCalls += 1;
        keys.push(String(request.getHeader("idempotency-key")));
        await writeWithBackpressure(request, "body", signal);
        return undefined;
      },
      sleep: async () => undefined,
      limits: {
        retryAttempts: 2,
        continueTimeoutMs: 5000,
        requestTimeoutMs: 5000,
      },
    });
    assert.equal(result.attempts, 2);
    assert.equal(bodyCalls, 1);
    assert.equal(tokens.length, 0);
    assert.deepEqual(keys, [
      "sha256=e8493bb4610c15c987d761986e3f61edb464a9e06f5f78e2b9280bc06bbea17a",
    ]);
  } finally {
    await close(server);
  }
});

void test("fails closed when GitHub reissues the same token identifier", async () => {
  let connections = 0;
  const server = createServer();
  server.on("checkContinue", (request) => {
    connections += 1;
    request.socket.destroy();
  });
  const endpoint = await listen(server);
  try {
    await assert.rejects(
      submitWithFreshOIDC({
        endpoint,
        material,
        getOIDCToken: async () => token("same-jti"),
        writeBody: async () => undefined,
        sleep: async () => undefined,
        limits: {
          retryAttempts: 2,
          continueTimeoutMs: 5000,
          requestTimeoutMs: 5000,
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "oidc_token_reused",
    );
    assert.equal(connections, 1);
  } finally {
    await close(server);
  }
});

void test("reports ambiguity and never retries after body starts", async () => {
  let connections = 0;
  const server = createServer();
  server.on("checkContinue", (request, response) => {
    connections += 1;
    response.writeContinue();
    request.once("data", () => request.socket.destroy());
  });
  const endpoint = await listen(server);
  let tokenCalls = 0;
  try {
    await assert.rejects(
      submitWithFreshOIDC({
        endpoint,
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
          continueTimeoutMs: 5000,
          requestTimeoutMs: 5000,
        },
      }),
      AmbiguousTransportError,
    );
    assert.equal(connections, 1);
    assert.equal(tokenCalls, 1);
  } finally {
    await close(server);
  }
});

void test("uses bounded continue timeout when an intermediary sends no interim response", async () => {
  let body = "";
  const server = createServer((request, response) => {
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.on("checkContinue", (request, response) => {
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const endpoint = await listen(server);
  try {
    await submitWithFreshOIDC({
      endpoint,
      material,
      getOIDCToken: async () => token("one"),
      writeBody: async (request, _boundary, signal) => {
        await writeWithBackpressure(request, "fallback-body", signal);
        return undefined;
      },
      limits: { continueTimeoutMs: 10, requestTimeoutMs: 5000 },
    });
    assert.equal(body, "fallback-body");
  } finally {
    await close(server);
  }
});
