import { PassThrough, Readable } from "node:stream";

import type { ShowProcess } from "../src/command";
import type { ActionCore } from "../src/action";

export function fakeJWT(claims: Record<string, string | number>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "not-a-real-signature",
  ].join(".");
}

export function showProcess(
  chunks: readonly (string | Buffer)[],
  exitCode = 0,
  stderr = "",
): ShowProcess {
  return {
    stdout: Readable.from(chunks),
    stderr: Readable.from(stderr === "" ? [] : [stderr]),
    completion: Promise.resolve({ exitCode, signal: null }),
    kill: () => undefined,
  };
}

export class MemoryDestination extends PassThrough {
  readonly chunks: Buffer[] = [];

  constructor() {
    super();
    this.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk)));
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class FakeCore implements ActionCore {
  readonly inputs: Record<string, string>;
  readonly tokens: string[];
  readonly audiences: string[] = [];
  readonly secrets: string[] = [];
  readonly outputs = new Map<string, string>();
  readonly logs: string[] = [];
  readonly failures: string[] = [];
  #tokenIndex = 0;

  constructor(inputs: Record<string, string>, tokens: string[] = []) {
    this.inputs = inputs;
    this.tokens = tokens;
  }

  getInput(name: string): string {
    return this.inputs[name] ?? "";
  }

  async getIDToken(audience: string): Promise<string> {
    this.audiences.push(audience);
    const token = this.tokens[this.#tokenIndex];
    this.#tokenIndex += 1;
    if (token === undefined) throw new Error("token unavailable");
    return token;
  }

  setSecret(secret: string): void {
    this.secrets.push(secret);
  }

  setOutput(name: string, value: string): void {
    this.outputs.set(name, value);
  }

  info(message: string): void {
    this.logs.push(`info:${message}`);
  }

  notice(message: string): void {
    this.logs.push(`notice:${message}`);
  }

  warning(message: string): void {
    this.logs.push(`warning:${message}`);
  }

  error(message: string): void {
    this.logs.push(`error:${message}`);
  }

  setFailed(message: string): void {
    this.failures.push(message);
  }
}
