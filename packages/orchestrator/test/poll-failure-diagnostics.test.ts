import { assert, it } from "@effect/vitest";
import { InvalidGitHubResponseError } from "@usine/github/github-app";
import { repositoryFailureLogFields } from "../src/polling/cycle.ts";

it("bounds GitHub decode details in logs and operator messages", () => {
  const detail = `Missing field: ${"x".repeat(600)}`;
  const fields = repositoryFailureLogFields(
    InvalidGitHubResponseError.make({
      operation: "fetch-issue-snapshot",
      message: "GitHub returned a response in an unexpected format",
      detail,
    }),
  );
  assert("detail" in fields);
  assert.strictEqual(fields.detail, detail.slice(0, 500));
  assert.include(fields.message, detail.slice(0, 500));
  assert.notInclude(fields.message, detail.slice(0, 501));
});
