import { randomBytes } from "node:crypto";
import type { Writable } from "node:stream";

import { SafeError } from "./errors";

export function createMultipartBoundary(): string {
  return `chamber-${randomBytes(24).toString("hex")}`;
}

async function waitForDrain(
  destination: Writable,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      destination.off("drain", onDrain);
      destination.off("error", onError);
      destination.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(
        new SafeError(
          "transport_write_failed",
          "The evidence connection closed while streaming.",
        ),
      );
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new SafeError(
          "transport_write_failed",
          "The evidence connection closed while streaming.",
        ),
      );
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        new SafeError(
          "transport_aborted",
          "The evidence connection was cancelled.",
        ),
      );
    };
    destination.once("drain", onDrain);
    destination.once("error", onError);
    destination.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function writeWithBackpressure(
  destination: Writable,
  value: Uint8Array | string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new SafeError(
      "transport_aborted",
      "The evidence connection was cancelled.",
    );
  }
  if (!destination.write(value)) {
    await waitForDrain(destination, signal);
  }
}

export class MultipartWriter {
  readonly #destination: Writable;
  readonly #boundary: string;
  readonly #signal: AbortSignal;
  #partCount = 0;
  #evidenceOpen = false;
  #completed = false;

  constructor(destination: Writable, boundary: string, signal: AbortSignal) {
    this.#destination = destination;
    this.#boundary = boundary;
    this.#signal = signal;
  }

  async writeJSONPart(
    name: "start" | "completion",
    value: unknown,
    maximumBytes: number,
  ): Promise<void> {
    if (this.#evidenceOpen || this.#completed) {
      throw new SafeError(
        "multipart_order_invalid",
        "The evidence multipart stream entered an invalid state.",
      );
    }
    if (
      (name === "start" && this.#partCount !== 0) ||
      (name === "completion" && this.#partCount < 1)
    ) {
      throw new SafeError(
        "multipart_order_invalid",
        "The evidence multipart stream entered an invalid state.",
      );
    }
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > maximumBytes) {
      throw new SafeError(
        "metadata_limit_exceeded",
        "Terraform evidence metadata exceeds the protocol limit.",
      );
    }
    await writeWithBackpressure(
      this.#destination,
      `${this.#partCount === 0 ? "" : "\r\n"}--${this.#boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n` +
        "Content-Type: application/json\r\n\r\n",
      this.#signal,
    );
    await writeWithBackpressure(this.#destination, encoded, this.#signal);
    this.#partCount += 1;
    if (name === "completion") {
      await writeWithBackpressure(
        this.#destination,
        `\r\n--${this.#boundary}--\r\n`,
        this.#signal,
      );
      this.#completed = true;
    }
  }

  async openEvidence(): Promise<void> {
    if (this.#partCount !== 1 || this.#evidenceOpen || this.#completed) {
      throw new SafeError(
        "multipart_order_invalid",
        "The evidence multipart stream entered an invalid state.",
      );
    }
    await writeWithBackpressure(
      this.#destination,
      `\r\n--${this.#boundary}\r\n` +
        'Content-Disposition: form-data; name="evidence"\r\n' +
        "Content-Type: application/json\r\n" +
        "Content-Encoding: gzip\r\n\r\n",
      this.#signal,
    );
    this.#evidenceOpen = true;
  }

  async writeEvidence(value: Uint8Array): Promise<void> {
    if (!this.#evidenceOpen || this.#completed) {
      throw new SafeError(
        "multipart_order_invalid",
        "The evidence multipart stream entered an invalid state.",
      );
    }
    await writeWithBackpressure(this.#destination, value, this.#signal);
  }

  closeEvidence(): void {
    if (!this.#evidenceOpen || this.#completed) {
      throw new SafeError(
        "multipart_order_invalid",
        "The evidence multipart stream entered an invalid state.",
      );
    }
    this.#evidenceOpen = false;
    this.#partCount += 1;
  }

  assertCompleted(): void {
    if (!this.#completed) {
      throw new SafeError(
        "completion_missing",
        "The evidence multipart stream did not finish with completion metadata.",
      );
    }
  }
}
