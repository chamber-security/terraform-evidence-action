import { spawn } from "node:child_process";
import { devNull } from "node:os";
import type { Readable } from "node:stream";

import { LIMITS } from "./constants";
import { SafeError } from "./errors";

// A step records its outputs, environment, path, state and job summary by
// appending to the files these variables name. A Terraform wrapper, such as the
// one hashicorp/setup-terraform installs by default, saves what Terraform prints
// as step outputs through them, and for state that is every secret in plaintext.
// Commands the Action starts get the null device instead, so a wrapper that uses
// these variables writes nowhere. Setting them, rather than removing them, keeps
// such a wrapper from falling back to workflow commands on the stdout the Action
// streams. On Windows, @actions/core may not accept the null device as a file;
// a wrapper built on it then fails, and so does the capture, without leaking.
const GITHUB_FILE_COMMANDS = [
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
] as const;

// The runner gives JavaScript actions, but not run steps, these credentials for
// the cache, artifact and results services. Terraform and the providers it
// starts don't need them.
const ACTIONS_RUNTIME_VARIABLES = [
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
] as const;

export function commandEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const name of GITHUB_FILE_COMMANDS) child[name] = devNull;
  for (const name of ACTIONS_RUNTIME_VARIABLES)
    Reflect.deleteProperty(child, name);
  return child;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderrBytes: number;
  stderrTruncated: boolean;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

export async function runBoundedCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const stdoutLimit = options.stdoutLimit ?? LIMITS.commandOutputBytes;
  const stderrLimit = options.stderrLimit ?? LIMITS.stderrBytes;
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: commandEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? LIMITS.commandTimeoutMs);
    timer.unref();

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stdout.length + chunk.length > stdoutLimit) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          terminate();
          reject(
            new SafeError(
              "command_output_limit_exceeded",
              "A required command returned more metadata than the Action accepts.",
            ),
          );
        }
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunkLength = Buffer.isBuffer(value)
        ? value.length
        : Buffer.byteLength(value);
      const remaining = Math.max(0, stderrLimit - stderrBytes);
      stderrBytes += Math.min(chunkLength, remaining);
      if (chunkLength > remaining) {
        stderrTruncated = true;
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(
        new SafeError(
          `${executable}_unavailable`,
          `The required ${executable} executable is unavailable.`,
        ),
      );
    });
    child.once("close", (exitCode) => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new SafeError(
            "command_timeout",
            `The required ${executable} command exceeded its deadline.`,
          ),
        );
        return;
      }
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdout.toString("utf8").trim(),
        stderrBytes,
        stderrTruncated,
      });
    });
  });
}

export interface ShowCompletion {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export interface ShowProcess {
  stdout: Readable;
  stderr: Readable;
  completion: Promise<ShowCompletion>;
  kill(signal?: NodeJS.Signals): void;
}

export type ShowSpawner = (args: readonly string[], cwd: string) => ShowProcess;

export function spawnTerraformShow(
  args: readonly string[],
  cwd: string,
): ShowProcess {
  const child = spawn("terraform", [...args], {
    cwd,
    env: commandEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<ShowCompletion>((resolve, reject) => {
    child.once("error", () => {
      reject(
        new SafeError(
          "terraform_unavailable",
          "Terraform is required in PATH but could not be started.",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? -1, signal });
    });
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    kill: (signal = "SIGTERM") => {
      child.kill(signal);
    },
  };
}
