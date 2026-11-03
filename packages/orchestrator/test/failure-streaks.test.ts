import { assert, it } from "@effect/vitest";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { RepositoryPollFailure } from "../src/polling/cycle.ts";
import { advance, type RepositoryOutcome } from "../src/polling/failure-streaks.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const githubFailure = new RepositoryPollFailure({
  repository,
  errorTag: "GitHubApiError",
  message: "502",
});
const configFailure = new RepositoryPollFailure({
  repository,
  errorTag: "ConfigFileError",
  message: "Invalid loop",
});
const failed: RepositoryOutcome = {
  _tag: "Failed",
  source: "Polling",
  repository,
  failure: githubFailure,
  failures: [],
};

it("reports the third failed cycle, preserves incomplete checks, and clears on success or removal", () => {
  const first = advance(new Map(), [repository], [{ ...failed, failures: [configFailure] }]);
  assert.deepStrictEqual(first.failures, [configFailure]);
  assert.deepStrictEqual(first.decisions, [{ _tag: "Counting", repository, consecutive: 1 }]);
  const second = advance(first.streaks, [repository], [failed]);
  assert.deepStrictEqual(second.failures, []);
  const third = advance(second.streaks, [repository], [failed]);
  assert.deepStrictEqual(third.failures, [githubFailure]);
  assert.deepStrictEqual(third.decisions, [{ _tag: "Reported", repository, consecutive: 3 }]);

  for (const _tag of ["RateLimited", "Skipped"] as const) {
    const paused = advance(
      third.streaks,
      [repository],
      [{ _tag, source: "Polling", repository, failures: [] }],
    );
    assert.deepStrictEqual(paused.streaks, third.streaks);
    assert.deepStrictEqual(paused.failures, [githubFailure]);
    assert.deepStrictEqual(paused.decisions, [{ _tag: "Preserved", repository }]);
    const resumed = advance(paused.streaks, [repository], [failed]);
    assert.deepStrictEqual(resumed.decisions, [{ _tag: "Reported", repository, consecutive: 4 }]);
  }
  assert.deepStrictEqual(advance(third.streaks, [repository], []).streaks, third.streaks);
  const recovered = advance(
    third.streaks,
    [repository],
    [
      {
        _tag: "Polled",
        source: "Polling",
        repository,
        failures: [],
      },
    ],
  );
  assert.deepStrictEqual(recovered.failures, []);
  assert.strictEqual(recovered.streaks.size, 0);
  assert.deepStrictEqual(recovered.decisions, [
    { _tag: "Recovered", repository, previousConsecutive: 3 },
  ]);
  assert.deepStrictEqual(advance(recovered.streaks, [repository], [failed]).failures, []);
  const removed = advance(third.streaks, [], []);
  assert.strictEqual(removed.streaks.size, 0);
  assert.deepStrictEqual(removed.failures, []);
  assert.deepStrictEqual(removed.decisions, []);
  assert.strictEqual(
    third.streaks.get(canonicalRepositoryName(repository))?.consecutiveFailures,
    3,
  );
});

it("counts CI and snapshot failures once per repository and preserves them through a polling pause", () => {
  const ci: RepositoryOutcome = {
    _tag: "Polled",
    source: "Ci",
    repository,
    failures: [githubFailure],
  };
  const snapshot: RepositoryOutcome = {
    _tag: "Polled",
    source: "Polling",
    repository,
    failures: [githubFailure],
  };
  const first = advance(new Map(), [repository, repository], [ci, snapshot]);
  assert.deepStrictEqual(first.decisions, [{ _tag: "Counting", repository, consecutive: 1 }]);
  const second = advance(first.streaks, [repository], [ci, snapshot]);
  const third = advance(second.streaks, [repository], [ci, snapshot]);
  assert.deepStrictEqual(third.failures, [githubFailure, githubFailure]);
  const paused = advance(
    third.streaks,
    [repository],
    [
      ci,
      {
        _tag: "RateLimited",
        source: "Polling",
        repository,
        failures: [configFailure],
      },
    ],
  );
  assert.deepStrictEqual(paused.streaks, third.streaks);
  assert.deepStrictEqual(paused.failures, [configFailure, githubFailure, githubFailure]);

  // A CI wait keeps its repository watched after configuration removal.
  const ciOnly = advance(third.streaks, [repository], [ci]);
  assert.deepStrictEqual(ciOnly.decisions, [{ _tag: "Reported", repository, consecutive: 4 }]);
  assert.deepStrictEqual(ciOnly.failures, [githubFailure]);
  const recovered = advance(ciOnly.streaks, [repository], [{ ...ci, failures: [] }]);
  assert.deepStrictEqual(recovered.failures, []);
  assert.strictEqual(recovered.streaks.size, 0);
});
