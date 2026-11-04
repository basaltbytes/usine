import { assert, it } from "@effect/vitest";
import { ManagedRepo } from "@usine/config/factory";
import { GitHubLabelName } from "@usine/config/label";
import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import { EventId } from "@usine/core/event";
import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Claimed } from "@usine/engine/engine";
import { GitHubApiError, GitHubRateLimitError } from "@usine/github/github-app";
import { DateTime, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import {
  type InterruptedRepositoryCycle,
  latestPollAt,
  PollCycle,
  type RepositoryCycle,
  RepositoryPoll,
  RepositoryPollFailure,
} from "../src/polling/cycle.ts";
import type { PollFailureStreak, RepositoryOutcome } from "../src/polling/failure-streaks.ts";
import { pollAll } from "../src/polling/poll-all.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const sibling = RepositoryName.make("basaltbytes/sibling");
const watched = [repository, sibling].map((name) => ({
  repository: ManagedRepo.make({ name, tags: [], lanes: [] }),
}));
const idleCi = { outcomes: [], failures: [], nextPollAt: Option.none<DateTime.Utc>() };
const submission = Claimed.make({ eventId: EventId.make("event"), runId: RunId.make("run") });
const polled: RepositoryCycle = {
  _tag: "Polled",
  changedItems: 2,
  submissions: [submission],
  revokedRuns: 1,
  failures: [],
  preflightFindings: [],
  nextPollAt: Option.none(),
};

const makeState = Effect.fn("test.makePollAllState")(function* () {
  return {
    latest: yield* Ref.make(Option.none<PollCycle>()),
    completedPolls: yield* Ref.make<ReadonlyMap<string, RepositoryPoll>>(new Map()),
    failureStreaks: yield* Ref.make<ReadonlyMap<string, PollFailureStreak>>(new Map()),
  };
});

it.effect(
  "retains completion times across isolated failures and publishes attention changes once",
  () =>
    Effect.gen(function* () {
      const state = yield* makeState();
      const bus = yield* ChangeBus;
      const failing = yield* Ref.make(false);
      const dependencies = {
        pollRepository: ({ repository: repo }: (typeof watched)[number]) =>
          Effect.gen(function* () {
            if (repo.name === repository && (yield* Ref.get(failing))) {
              return yield* GitHubApiError.make({
                operation: "poll-repository-changes",
                status: Option.some(502),
                message: "unavailable",
              });
            }
            return polled;
          }),
        defer: () => Effect.void,
        publish: bus.publish,
      };
      const first = yield* pollAll(watched, idleCi, state, dependencies);
      assert.strictEqual(first.repositories, 2);
      assert.strictEqual(first.changedItems, 4);
      assert.deepStrictEqual(first.submissions, [submission, submission]);
      assert.strictEqual(first.revokedRuns, 2);
      assert.strictEqual(first.repositoryPolls.length, 2);
      assert.deepStrictEqual(first.failures, []);
      assert.deepStrictEqual((yield* bus.open).history, []);

      yield* Ref.set(failing, true);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual((yield* pollAll(watched, idleCi, state, dependencies)).failures, []);
      assert.deepStrictEqual((yield* pollAll(watched, idleCi, state, dependencies)).failures, []);
      const failed = yield* pollAll(watched, idleCi, state, dependencies);
      assert.strictEqual(failed.changedItems, 2);
      assert.deepStrictEqual(failed.submissions, [submission]);
      assert.strictEqual(failed.revokedRuns, 1);
      assert.deepStrictEqual(
        failed.failures.map(({ repository, errorTag }) => ({ repository, errorTag })),
        [{ repository, errorTag: "GitHubApiError" }],
      );
      assert.deepStrictEqual(
        failed.repositoryPolls.map(({ repository, completedAt }) => [
          repository,
          DateTime.toEpochMillis(completedAt),
        ]),
        [
          [repository, 0],
          [sibling, 60_000],
        ],
      );
      const latest = yield* Ref.get(state.latest);
      assert.deepStrictEqual(latest, Option.some(failed));
      const notices = (yield* bus.open).history;
      assert.deepStrictEqual(
        notices.map(({ changes }) => changes),
        [
          [
            {
              audience: { _tag: "Repository", repository },
              target: { kind: "attention", id: "instance" },
            },
          ],
        ],
      );
      yield* pollAll(watched, idleCi, state, dependencies);
      assert.deepStrictEqual((yield* bus.open).history, notices);

      yield* Ref.set(failing, false);
      const recovered = yield* pollAll(watched, idleCi, state, dependencies);
      assert.deepStrictEqual(recovered.failures, []);
      assert.strictEqual((yield* Ref.get(state.failureStreaks)).size, 0);
      assert.strictEqual((yield* bus.open).history.length, 2);
      const removed = yield* pollAll([], idleCi, state, dependencies);
      assert.strictEqual(removed.repositories, 0);
      assert.deepStrictEqual(removed.repositoryPolls, []);
    }).pipe(Effect.provide(changeBusLayer)),
);

it.effect(
  "CI backoff skips polling, preserves poll streaks, and counts CI-only repository failures",
  () =>
    Effect.gen(function* () {
      const state = yield* makeState();
      const prior = RepositoryPollFailure.make({
        repository,
        errorTag: "GitHubApiError",
        message: "prior",
      });
      const completion = RepositoryPoll.make({ repository, completedAt: DateTime.makeUnsafe(0) });
      yield* Ref.set(
        state.completedPolls,
        new Map([[canonicalRepositoryName(repository), completion]]),
      );
      yield* Ref.set(
        state.failureStreaks,
        new Map([
          [
            canonicalRepositoryName(repository),
            {
              consecutiveFailures: 3,
              failures: [prior],
            },
          ],
        ]),
      );
      const ciFailure = RepositoryPollFailure.make({
        repository: sibling,
        errorTag: "GitHubApiError",
        message: "CI unavailable",
      });
      const outcome: RepositoryOutcome = {
        _tag: "Failed",
        repository: sibling,
        source: "Ci",
        failures: [],
        failure: ciFailure,
      };
      const nextPollAt = Option.some(DateTime.makeUnsafe(60_000));
      const deferred = yield* Ref.make(Option.none<DateTime.Utc>());
      const ci = { outcomes: [outcome], failures: [], nextPollAt };
      const dependencies = {
        pollRepository: () => Effect.die("CI backoff must prevent repository requests"),
        defer: (until: Option.Option<DateTime.Utc>) => Ref.set(deferred, until),
        publish: () => Effect.void,
      };
      const active = watched.slice(0, 1);
      yield* pollAll(active, ci, state, dependencies);
      yield* pollAll(active, ci, state, dependencies);
      const cycle = yield* pollAll(active, ci, state, dependencies);
      assert.strictEqual(cycle.repositories, 1);
      assert.strictEqual(cycle.changedItems, 0);
      assert.deepStrictEqual(cycle.repositoryPolls, [completion]);
      assert.deepStrictEqual(cycle.failures, [prior, ciFailure]);
      assert.deepStrictEqual(cycle.nextPollAt, nextPollAt);
      const requestedBackoff = yield* Ref.get(deferred);
      assert.deepStrictEqual(requestedBackoff, nextPollAt);
      assert.strictEqual(
        (yield* Ref.get(state.failureStreaks)).get(canonicalRepositoryName(repository))
          ?.consecutiveFailures,
        3,
      );
    }),
);

it.effect(
  "combines completed and interrupted preflight findings and defers the latest backoff",
  () =>
    Effect.gen(function* () {
      const state = yield* makeState();
      const finding = LabelPreflightFinding.make({
        repository,
        label: GitHubLabelName.make("ready"),
        errorTag: "GitHubApiError",
        message: "label creation failed",
      });
      const failure = RepositoryPollFailure.make({
        repository,
        errorTag: "ConfigFileError",
        message: "invalid loop",
      });
      const requested = Option.some(DateTime.makeUnsafe(180_000));
      const interrupted: InterruptedRepositoryCycle = {
        _tag: "InterruptedRepositoryCycle",
        error: GitHubRateLimitError.make({
          operation: "poll-repository-changes",
          retryAt: DateTime.makeUnsafe(120_000),
          message: "rate limited",
        }),
        failures: [failure],
        preflightFindings: [finding],
        nextPollAt: requested,
      };
      const deferred = yield* Ref.make(Option.none<DateTime.Utc>());
      const siblingFinding = LabelPreflightFinding.make({ ...finding, repository: sibling });
      const cycle = yield* pollAll(watched, idleCi, state, {
        pollRepository: ({ repository: repo }) =>
          repo.name === repository
            ? Effect.fail(interrupted)
            : Effect.succeed({
                ...polled,
                _tag: "RateLimited",
                preflightFindings: [siblingFinding],
                nextPollAt: Option.some(DateTime.makeUnsafe(60_000)),
              } satisfies RepositoryCycle),
        defer: (until) => Ref.update(deferred, (current) => latestPollAt([current, until])),
        publish: () => Effect.void,
      });
      assert.deepStrictEqual(cycle.failures, [failure]);
      assert.deepStrictEqual(cycle.preflightFindings, [finding, siblingFinding]);
      assert.deepStrictEqual(cycle.nextPollAt, requested);
      const requestedBackoff = yield* Ref.get(deferred);
      assert.deepStrictEqual(requestedBackoff, requested);
      assert.deepStrictEqual(
        cycle.repositoryPolls.map(({ repository }) => repository),
        [sibling],
      );
      assert.strictEqual(cycle.changedItems, 2);
    }),
);
