import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { SafeError } from "../src/errors";
import { MultipartWriter, writeWithBackpressure } from "../src/multipart";

void test("waits for destination backpressure", async () => {
  let writes = 0;
  const destination = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes += 1;
      setImmediate(callback);
    },
  });
  await writeWithBackpressure(
    destination,
    Buffer.alloc(1024),
    new AbortController().signal,
  );
  assert.equal(writes, 1);
  destination.end();
});

void test("rejects disconnect while waiting for drain", async () => {
  const destination = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      this.destroy();
    },
  });
  await assert.rejects(
    writeWithBackpressure(
      destination,
      Buffer.alloc(1024),
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof SafeError && error.code === "transport_write_failed",
  );
});

void test("enforces start/evidence/completion ordering", async () => {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const writer = new MultipartWriter(
    destination,
    "unit-boundary",
    new AbortController().signal,
  );
  await writer.writeJSONPart("start", { schema_version: 1 }, 1024);
  await writer.openEvidence();
  await writer.writeEvidence(Buffer.from("gzip"));
  writer.closeEvidence();
  await writer.writeJSONPart("completion", { capture_status: "failed" }, 1024);
  writer.assertCompleted();
  destination.end();
  assert.match(
    Buffer.concat(chunks).toString("utf8"),
    /name="start"[\s\S]*name="evidence"[\s\S]*name="completion"/u,
  );
});
