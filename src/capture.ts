import { createGzip } from "node:zlib";

import type { CommandRunner, ShowProcess, ShowSpawner } from "./command";
import { LIMITS } from "./constants";
import { SafeError } from "./errors";
import { MultipartWriter, writeWithBackpressure } from "./multipart";
import type { CompletionV1, EvidenceKind, StartV1 } from "./types";

const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export interface WorkspaceSelection {
  instance?: string;
  terraformWorkspace?: string;
  selector: string;
  captureAllowed: boolean;
  diagnosticCode?: string;
}

export interface CaptureLimits {
  startBytes: number;
  completionBytes: number;
  stderrBytes: number;
  evidenceBytes: number;
  compressedEvidenceBytes: number;
  captureTimeoutMs: number;
}

export interface CaptureRequest {
  start: StartV1;
  evidenceKind: EvidenceKind;
  workingDirectoryAbsolute: string;
  planFile?: string;
  selection: WorkspaceSelection;
  spawnShow: ShowSpawner;
  now: () => Date;
  limits?: Partial<CaptureLimits>;
}

export interface CaptureResult {
  captureStatus: "succeeded" | "failed";
  diagnosticCode?: string;
  stderrBytes: number;
  stderrTruncated: boolean;
  uncompressedBytes: number;
  compressedBytes: number;
}

export async function discoverWorkspace(
  runCommand: CommandRunner,
  workingDirectoryAbsolute: string,
  evidenceKind: EvidenceKind,
  explicitInstance: string | undefined,
): Promise<WorkspaceSelection> {
  let result;
  try {
    result = await runCommand("terraform", ["workspace", "show"], {
      cwd: workingDirectoryAbsolute,
    });
  } catch (error) {
    if (error instanceof SafeError) {
      if (explicitInstance !== undefined) {
        return {
          instance: explicitInstance,
          selector: explicitInstance,
          captureAllowed: true,
          diagnosticCode: "workspace_discovery_failed",
        };
      }
      return {
        selector: "",
        captureAllowed: evidenceKind === "plan",
        diagnosticCode:
          error.code === "terraform_unavailable"
            ? "terraform_unavailable"
            : "target_unknown",
      };
    }
    throw error;
  }

  const workspaceValid =
    result.exitCode === 0 && INSTANCE_PATTERN.test(result.stdout);
  if (!workspaceValid) {
    if (explicitInstance !== undefined) {
      return {
        instance: explicitInstance,
        selector: explicitInstance,
        captureAllowed: true,
        diagnosticCode: "workspace_discovery_failed",
      };
    }
    return {
      selector: "",
      captureAllowed: evidenceKind === "plan",
      diagnosticCode: "target_unknown",
    };
  }

  if (explicitInstance !== undefined) {
    return {
      instance: explicitInstance,
      selector: explicitInstance,
      captureAllowed: true,
    };
  }
  if (result.stdout !== "default") {
    return {
      instance: result.stdout,
      terraformWorkspace: result.stdout,
      selector: result.stdout,
      captureAllowed: true,
    };
  }
  return {
    terraformWorkspace: "default",
    selector: "default",
    captureAllowed: true,
  };
}

async function consumeStderr(
  process: ShowProcess,
  maximumBytes: number,
): Promise<{ bytes: number; truncated: boolean }> {
  let bytes = 0;
  let truncated = false;
  try {
    for await (const value of process.stderr) {
      const length = Buffer.byteLength(value as Uint8Array);
      if (bytes + length > maximumBytes) truncated = true;
      bytes = Math.min(maximumBytes, bytes + length);
    }
  } catch {
    truncated = true;
  }
  return { bytes, truncated };
}

async function pumpShow(
  writer: MultipartWriter,
  process: ShowProcess,
  signal: AbortSignal,
  limits: CaptureLimits,
): Promise<
  Omit<CaptureResult, "captureStatus" | "diagnosticCode"> & {
    diagnosticCode?: string;
  }
> {
  const gzip = createGzip();
  let uncompressedBytes = 0;
  let compressedBytes = 0;
  let diagnosticCode: string | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  type CompletionOutcome =
    | { ok: true; value: Awaited<ShowProcess["completion"]> }
    | { ok: false; error: unknown };
  const completion: Promise<CompletionOutcome> = process.completion.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  const stderr = consumeStderr(process, limits.stderrBytes);
  const kill = (): void => {
    process.kill("SIGTERM");
    forceKillTimer ??= setTimeout(() => {
      process.kill("SIGKILL");
    }, 1000);
    forceKillTimer.unref();
  };
  const onAbort = (): void => {
    kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    diagnosticCode = "terraform_show_timeout";
    kill();
  }, limits.captureTimeoutMs);
  timeout.unref();

  const compressedPump = (async (): Promise<void> => {
    let sizeExceeded = false;
    for await (const value of gzip) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      if (
        sizeExceeded ||
        compressedBytes + chunk.length > limits.compressedEvidenceBytes
      ) {
        sizeExceeded = true;
        continue;
      }
      compressedBytes += chunk.length;
      try {
        await writer.writeEvidence(chunk);
      } catch {
        gzip.destroy();
        throw new SafeError(
          "transport_write_failed",
          "The evidence connection closed while streaming.",
        );
      }
    }
    if (sizeExceeded) {
      throw new SafeError(
        "compressed_evidence_size_limit_exceeded",
        "Compressed Terraform evidence exceeded the transport limit.",
      );
    }
  })();

  try {
    let sourceError: unknown;
    try {
      for await (const value of process.stdout) {
        if (signal.aborted) {
          throw new SafeError(
            "transport_aborted",
            "The evidence connection was cancelled.",
          );
        }
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value as Uint8Array);
        if (uncompressedBytes + chunk.length > limits.evidenceBytes) {
          diagnosticCode = "evidence_size_limit_exceeded";
          kill();
          break;
        }
        uncompressedBytes += chunk.length;
        await writeWithBackpressure(gzip, chunk, signal);
      }
    } catch (error) {
      sourceError = error;
    } finally {
      gzip.end();
    }

    let compressedError: unknown;
    try {
      await compressedPump;
    } catch (error) {
      compressedError = error;
    }
    if (
      signal.aborted ||
      (sourceError instanceof SafeError &&
        (sourceError.code === "transport_aborted" ||
          sourceError.code === "transport_write_failed")) ||
      (compressedError instanceof SafeError &&
        compressedError.code === "transport_write_failed")
    ) {
      kill();
      throw new SafeError(
        "transport_aborted",
        "The evidence connection was cancelled while streaming.",
      );
    }
    if (
      compressedError instanceof SafeError &&
      compressedError.code === "compressed_evidence_size_limit_exceeded"
    ) {
      kill();
      diagnosticCode = compressedError.code;
    }
    if (sourceError !== undefined && diagnosticCode === undefined) {
      diagnosticCode = "terraform_show_failed";
      kill();
    }

    const completed = await completion;
    const stderrResult = await stderr;
    const abortedAfterCapture = (): boolean => signal.aborted;
    if (abortedAfterCapture()) {
      throw new SafeError(
        "transport_aborted",
        "The evidence connection was cancelled.",
      );
    }
    if (diagnosticCode === undefined && !completed.ok) {
      diagnosticCode =
        completed.error instanceof SafeError
          ? completed.error.code
          : "terraform_show_failed";
    } else if (
      diagnosticCode === undefined &&
      completed.ok &&
      completed.value.exitCode !== 0
    ) {
      diagnosticCode = "terraform_show_failed";
    } else if (diagnosticCode === undefined && uncompressedBytes === 0) {
      diagnosticCode = "terraform_show_empty";
    }

    return {
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
      stderrBytes: stderrResult.bytes,
      stderrTruncated: stderrResult.truncated,
      uncompressedBytes,
      compressedBytes,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
}

export async function writeCapture(
  destination: NodeJS.WritableStream,
  boundary: string,
  signal: AbortSignal,
  request: CaptureRequest,
): Promise<CaptureResult> {
  const limits: CaptureLimits = {
    startBytes: request.limits?.startBytes ?? LIMITS.startBytes,
    completionBytes: request.limits?.completionBytes ?? LIMITS.completionBytes,
    stderrBytes: request.limits?.stderrBytes ?? LIMITS.stderrBytes,
    evidenceBytes: request.limits?.evidenceBytes ?? LIMITS.evidenceBytes,
    compressedEvidenceBytes:
      request.limits?.compressedEvidenceBytes ?? LIMITS.compressedEvidenceBytes,
    captureTimeoutMs:
      request.limits?.captureTimeoutMs ?? LIMITS.captureTimeoutMs,
  };
  const writer = new MultipartWriter(
    destination as import("node:stream").Writable,
    boundary,
    signal,
  );
  await writer.writeJSONPart("start", request.start, limits.startBytes);

  if (!request.selection.captureAllowed) {
    const diagnosticCode =
      request.selection.diagnosticCode ?? "capture_not_started";
    const completion: CompletionV1 = {
      schema_version: 1,
      capture_status: "failed",
      capture_completed_at: request.now().toISOString(),
      capture_diagnostic_code: diagnosticCode,
    };
    await writer.writeJSONPart(
      "completion",
      completion,
      limits.completionBytes,
    );
    writer.assertCompleted();
    return {
      captureStatus: "failed",
      diagnosticCode,
      stderrBytes: 0,
      stderrTruncated: false,
      uncompressedBytes: 0,
      compressedBytes: 0,
    };
  }

  const showArguments =
    request.evidenceKind === "plan"
      ? ["show", "-json", request.planFile ?? ""]
      : ["show", "-json"];
  let process: ShowProcess;
  try {
    process = request.spawnShow(
      showArguments,
      request.workingDirectoryAbsolute,
    );
  } catch {
    const completion: CompletionV1 = {
      schema_version: 1,
      capture_status: "failed",
      capture_completed_at: request.now().toISOString(),
      capture_diagnostic_code: "terraform_show_failed",
    };
    await writer.writeJSONPart(
      "completion",
      completion,
      limits.completionBytes,
    );
    writer.assertCompleted();
    return {
      captureStatus: "failed",
      diagnosticCode: "terraform_show_failed",
      stderrBytes: 0,
      stderrTruncated: false,
      uncompressedBytes: 0,
      compressedBytes: 0,
    };
  }
  try {
    await writer.openEvidence();
  } catch (error) {
    process.kill("SIGTERM");
    throw error;
  }
  const result = await pumpShow(writer, process, signal, limits);
  writer.closeEvidence();
  const captureStatus =
    result.diagnosticCode === undefined ? "succeeded" : "failed";
  const completion: CompletionV1 = {
    schema_version: 1,
    capture_status: captureStatus,
    capture_completed_at: request.now().toISOString(),
    ...(result.diagnosticCode === undefined
      ? {}
      : { capture_diagnostic_code: result.diagnosticCode }),
  };
  await writer.writeJSONPart("completion", completion, limits.completionBytes);
  writer.assertCompleted();
  return {
    captureStatus,
    ...(result.diagnosticCode === undefined &&
    request.selection.diagnosticCode === undefined
      ? {}
      : {
          diagnosticCode:
            result.diagnosticCode ?? request.selection.diagnosticCode,
        }),
    stderrBytes: result.stderrBytes,
    stderrTruncated: result.stderrTruncated,
    uncompressedBytes: result.uncompressedBytes,
    compressedBytes: result.compressedBytes,
  };
}
