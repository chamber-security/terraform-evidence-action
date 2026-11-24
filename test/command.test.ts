import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  commandEnvironment,
  runBoundedCommand,
  spawnToolShow,
} from "../src/command";
import { SafeError } from "../src/errors";

const FILE_COMMANDS = [
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
];

void test("gives commands the null device for every GitHub file command, and no runtime token", () => {
  const parent = {
    PATH: "/usr/bin",
    TERRAFORM_CLI_PATH: "/opt/terraform",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request",
    ACTIONS_RUNTIME_TOKEN: "runtime-token",
    ACTIONS_RUNTIME_URL: "https://runtime.example/",
    ACTIONS_CACHE_URL: "https://cache.example/",
    ACTIONS_RESULTS_URL: "https://results.example/",
    GITHUB_OUTPUT: "/runner/_temp/_runner_file_commands/set_output_1",
    GITHUB_ENV: "/runner/_temp/_runner_file_commands/set_env_1",
  };
  const before = { ...parent };
  const env = commandEnvironment(parent);
  for (const name of FILE_COMMANDS) assert.equal(env[name], devNull, name);
  for (const name of [
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_CACHE_URL",
    "ACTIONS_RESULTS_URL",
  ]) {
    assert.equal(name in env, false, name);
  }
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TERRAFORM_CLI_PATH, "/opt/terraform");
  // An azurerm backend signs in with the OIDC request variables.
  assert.equal(
    env.ACTIONS_ID_TOKEN_REQUEST_URL,
    "https://token.example/request",
  );
  assert.deepEqual(parent, before);
});

// hashicorp/setup-terraform installs a wrapper as `terraform` that prints what
// the real binary prints and then saves it with core.setOutput. This stand-in
// does the same through the Action's own @actions/core, and also tries every
// other file command.
void test(
  "keeps a Terraform wrapper from writing step outputs, environment, path, state or summary",
  {
    skip:
      process.platform === "win32" &&
      "the stand-in wrapper is a /bin/sh script",
  },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evidence-wrapper-"));
    const saved = Object.fromEntries(
      ["PATH", ...FILE_COMMANDS].map((name) => [name, process.env[name]]),
    );
    try {
      const core = pathToFileURL(
        path.resolve("node_modules/@actions/core/lib/core.js"),
      ).href;
      const state = '{"format_version":"1.0","values":{"secret":"canary"}}';
      await writeFile(
        path.join(dir, "wrapper.mjs"),
        [
          `import * as core from ${JSON.stringify(core)};`,
          `const out = process.argv[2] === "show" ? ${JSON.stringify(state)} : "default\\n";`,
          "process.stdout.write(out);",
          'core.setOutput("stdout", out);',
          'core.setOutput("exitcode", "0");',
          'core.exportVariable("TF_STDOUT", out);',
          'core.addPath("/wrapper/bin");',
          'core.saveState("stdout", out);',
          "await core.summary.addRaw(out).write();",
        ].join("\n"),
      );
      const terraform = path.join(dir, "terraform");
      await writeFile(
        terraform,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, "wrapper.mjs"))} "$@"\n`,
      );
      await chmod(terraform, 0o755);
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
      for (const name of FILE_COMMANDS) {
        const file = path.join(dir, name);
        await writeFile(file, "");
        process.env[name] = file;
      }

      const show = spawnToolShow("terraform", ["show", "-json"], dir);
      const chunks: Buffer[] = [];
      show.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      show.stderr.resume();
      const completion = await show.completion;
      assert.equal(completion.exitCode, 0);
      assert.equal(Buffer.concat(chunks).toString("utf8"), state);

      const workspace = await runBoundedCommand(
        "terraform",
        ["workspace", "show"],
        {
          cwd: dir,
        },
      );
      assert.equal(workspace.exitCode, 0);
      assert.equal(workspace.stdout, "default");

      for (const name of FILE_COMMANDS) {
        assert.equal(
          await readFile(path.join(dir, name), "utf8"),
          "",
          `${name} was written`,
        );
        // The Action's own outputs still go to the step's files.
        assert.equal(process.env[name], path.join(dir, name));
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);

void test("counts bounded stderr before marking truncation", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", "process.stderr.write('1234567890')"],
    { cwd: process.cwd(), stderrLimit: 4 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrBytes, 4);
  assert.equal(result.stderrTruncated, true);
});

void test("stops a command that exceeds its deadline", async () => {
  await assert.rejects(
    runBoundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 10,
    }),
    (error: unknown) =>
      error instanceof SafeError && error.code === "command_timeout",
  );
});

void test("does not retain or return stderr contents", async () => {
  const canary = "COMMAND_SECRET_CANARY_DO_NOT_LOG";
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", `process.stderr.write('${canary}')`],
    { cwd: process.cwd(), stderrLimit: 4096 },
  );
  assert.equal("stderr" in result, false);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

void test("names the tool it couldn't start", async () => {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    const show = spawnToolShow("tofu", ["show", "-json"], process.cwd());
    await assert.rejects(
      show.completion,
      (error: unknown) =>
        error instanceof SafeError &&
        error.code === "terraform_unavailable" &&
        error.message.startsWith("OpenTofu is required in PATH"),
    );
  } finally {
    process.env.PATH = saved;
  }
});
