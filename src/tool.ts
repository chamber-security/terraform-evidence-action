import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { SafeError } from "./errors";
import type { TerraformTool } from "./types";

// The tool that ran the root decides how Chamber reads its plan and state, and
// both print the same JSON, so the Action reports which one it ran. The tool
// input names it; without one, the Action uses whichever of terraform and tofu
// is installed. With both installed it can't tell which ran the plan or apply
// and asks for the input rather than guess.
export interface ToolChoice {
  tool: TerraformTool;
  // Whether the Action knows the tool: from the input or the only one
  // installed. Chamber is told the tool only when it does.
  known: boolean;
}

export const TOOL_NAMES: Readonly<Record<TerraformTool, string>> =
  Object.freeze({
    terraform: "Terraform",
    tofu: "OpenTofu",
  });

async function executableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const directories = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((directory) => directory !== "" && path.isAbsolute(directory));
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter((extension) => extension !== "")
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (platform !== "win32") await access(candidate, constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

export async function resolveTool(
  requested: TerraformTool | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<ToolChoice> {
  if (requested !== undefined) return { tool: requested, known: true };
  const [terraform, tofu] = await Promise.all([
    executableOnPath("terraform", env, platform),
    executableOnPath("tofu", env, platform),
  ]);
  if (terraform && tofu) {
    throw new SafeError(
      "tool_ambiguous",
      "Both terraform and tofu are installed; set the tool input to the one that ran this root.",
    );
  }
  if (tofu) return { tool: "tofu", known: true };
  return { tool: "terraform", known: terraform };
}
