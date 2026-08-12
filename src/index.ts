import * as core from "@actions/core";

import { runAction, type ActionCore } from "./action";

const actionCore: ActionCore = {
  getInput: (name) => core.getInput(name),
  getIDToken: async (audience) => await core.getIDToken(audience),
  setSecret: (secret) => {
    core.setSecret(secret);
  },
  setOutput: (name, value) => {
    core.setOutput(name, value);
  },
  info: (message) => {
    core.info(message);
  },
  notice: (message) => {
    core.notice(message);
  },
  warning: (message) => {
    core.warning(message);
  },
  error: (message) => {
    core.error(message);
  },
  setFailed: (message) => {
    core.setFailed(message);
  },
};

if (require.main === module) {
  const cancellation = new AbortController();
  const cancel = (): void => {
    cancellation.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  void runAction({ core: actionCore, signal: cancellation.signal }).finally(
    () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  );
}
