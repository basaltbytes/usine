import { assert, it } from "@effect/vitest";
import { GitHubApiError, InvalidGitHubResponseError } from "@usine/github/github-app";
import { Option } from "effect";
import { repositoryFailureLogFields } from "../src/polling/cycle.ts";

it("bounds GitHub decode details in logs and operator messages", () => {
  const detail = `Missing field: ${"x".repeat(600)}`;
  const fields = repositoryFailureLogFields(
    new InvalidGitHubResponseError({
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

it("identifies GitHub API failures that have no decode detail", () => {
  assert.deepStrictEqual(
    repositoryFailureLogFields(
      new GitHubApiError({
        operation: "poll-repository-changes",
        status: Option.some(502),
        message: "GitHub returned HTTP status 502",
      }),
    ),
    {
      errorTag: "GitHubApiError",
      operation: "poll-repository-changes",
      message: "poll-repository-changes: GitHub returned HTTP status 502",
    },
  );
});
