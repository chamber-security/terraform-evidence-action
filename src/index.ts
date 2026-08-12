import * as core from "@actions/core";

import { ACTION_VERSION } from "./constants";

export function run(): void {
  core.setOutput("status", "not_started");
  core.info(`Chamber Terraform evidence Action ${ACTION_VERSION}`);
}

if (require.main === module) {
  run();
}
