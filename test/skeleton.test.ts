import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_VERSION, OIDC_AUDIENCE } from "../src/constants";

void test("freezes the version and exact OIDC audience", () => {
  assert.equal(ACTION_VERSION, "1.0.0");
  assert.equal(
    OIDC_AUDIENCE,
    "https://api.chamber.security/terraform-evidence",
  );
});
