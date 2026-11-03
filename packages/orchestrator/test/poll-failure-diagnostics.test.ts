import { assert, it } from "@effect/vitest";
import { GitHubApiError, InvalidGitHubResponseError } from "@usine/github/github-app";
import { RepositoryName } from "@usine/core/repository";
import { Option } from "effect";
import {
  RepositoryPollFailure,
  repositoryFailureLogFields,
  sustainedPollFailures,
} from "../src/polling/cycle.ts";

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

it("retains sustained failures through rate-limit pauses and resets after success or removal", () => {
  const repository = RepositoryName.make("basaltbytes/usine");
  const failure = new RepositoryPollFailure({
    repository,
    errorTag: "GitHubApiError",
    message: "502",
  });
  const configFailure = new RepositoryPollFailure({
    repository,
    errorTag: "ConfigFileError",
    message: "Invalid loop",
  });
  const first = sustainedPollFailures(
    [failure, configFailure],
    new Map(),
    [repository],
    [repository],
  );
  assert.deepStrictEqual(first.failures, [configFailure]);
  const second = sustainedPollFailures(
    [failure, failure],
    first.streaks,
    [repository],
    [repository],
  );
  assert.deepStrictEqual(second.failures, []);
  const third = sustainedPollFailures([failure], second.streaks, [repository], [repository]);
  assert.deepStrictEqual(third.failures, [failure]);
  const paused = sustainedPollFailures([], third.streaks, [repository], []);
  assert.deepStrictEqual(paused.failures, [failure]);
  const recovered = sustainedPollFailures([], paused.streaks, [repository], [repository]);
  assert.deepStrictEqual(recovered.failures, []);
  assert.strictEqual(recovered.streaks.size, 0);
  assert.deepStrictEqual(
    sustainedPollFailures([failure], recovered.streaks, [repository], [repository]).failures,
    [],
  );
  assert.strictEqual(sustainedPollFailures([], third.streaks, [], []).streaks.size, 0);
});
