import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { SafeError } from "./errors";

export interface ResolvedPaths {
  workspace: string;
  workingDirectory: string;
  workingDirectoryAbsolute: string;
  planFile?: string;
  planFileAbsolute?: string;
}

export function normalizeRepositoryRelative(
  raw: string,
  label: string,
): string {
  if (raw.length > 1024) {
    throw new SafeError(
      "unsafe_path",
      `The ${label} exceeds the accepted length.`,
    );
  }
  if (
    raw.includes("\\") ||
    path.posix.isAbsolute(raw) ||
    path.win32.isAbsolute(raw)
  ) {
    throw new SafeError(
      "unsafe_path",
      `The ${label} must be a slash-separated repository-relative path.`,
    );
  }
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new SafeError(
      "unsafe_path",
      `The ${label} must not escape its allowed directory.`,
    );
  }
  const normalized = parts
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return normalized === "" ? "." : normalized;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function requireNoSymlinkComponents(
  root: string,
  relative: string,
  finalKind: "directory" | "regular_file",
): Promise<string> {
  const components = relative === "." ? [] : relative.split("/");
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      throw new SafeError(
        "path_not_found",
        "The configured Terraform path does not exist.",
      );
    }
    if (stat.isSymbolicLink()) {
      throw new SafeError(
        "symlink_path_rejected",
        "Terraform evidence paths must not contain symbolic links.",
      );
    }
  }

  let finalStat;
  try {
    finalStat = await lstat(current);
  } catch {
    throw new SafeError(
      "path_not_found",
      "The configured Terraform path does not exist.",
    );
  }
  if (
    (finalKind === "directory" && !finalStat.isDirectory()) ||
    (finalKind === "regular_file" && !finalStat.isFile())
  ) {
    throw new SafeError(
      "path_type_mismatch",
      finalKind === "directory"
        ? "The working-directory input must identify a directory."
        : "The plan-file input must identify a regular file.",
    );
  }
  return current;
}

export async function resolvePaths(
  workspaceInput: string | undefined,
  workingDirectoryInput: string,
  planFileInput: string | undefined,
): Promise<ResolvedPaths> {
  if (workspaceInput === undefined || !path.isAbsolute(workspaceInput)) {
    throw new SafeError(
      "github_workspace_missing",
      "GITHUB_WORKSPACE must identify the checked-out repository.",
    );
  }

  let workspaceStat;
  try {
    workspaceStat = await lstat(workspaceInput);
  } catch {
    throw new SafeError(
      "github_workspace_missing",
      "GITHUB_WORKSPACE must identify the checked-out repository.",
    );
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new SafeError(
      "unsafe_github_workspace",
      "GITHUB_WORKSPACE must be a non-symlink directory.",
    );
  }
  const workspace = await realpath(workspaceInput);
  const workingDirectory = normalizeRepositoryRelative(
    workingDirectoryInput,
    "working-directory input",
  );
  const workingDirectoryAbsolute = await requireNoSymlinkComponents(
    workspace,
    workingDirectory,
    "directory",
  );
  const resolvedWorkingDirectory = await realpath(workingDirectoryAbsolute);
  if (!isContained(workspace, resolvedWorkingDirectory)) {
    throw new SafeError(
      "path_escape_rejected",
      "The working directory resolves outside GITHUB_WORKSPACE.",
    );
  }

  if (planFileInput === undefined) {
    return {
      workspace,
      workingDirectory,
      workingDirectoryAbsolute: resolvedWorkingDirectory,
    };
  }

  const planFile = normalizeRepositoryRelative(
    planFileInput,
    "plan-file input",
  );
  if (planFile === ".") {
    throw new SafeError(
      "invalid_plan_file",
      "The plan-file input must identify a regular file.",
    );
  }
  const planFileAbsolute = await requireNoSymlinkComponents(
    resolvedWorkingDirectory,
    planFile,
    "regular_file",
  );
  const resolvedPlanFile = await realpath(planFileAbsolute);
  if (!isContained(resolvedWorkingDirectory, resolvedPlanFile)) {
    throw new SafeError(
      "path_escape_rejected",
      "The plan file resolves outside the Terraform working directory.",
    );
  }
  return {
    workspace,
    workingDirectory,
    workingDirectoryAbsolute: resolvedWorkingDirectory,
    planFile,
    planFileAbsolute: resolvedPlanFile,
  };
}
