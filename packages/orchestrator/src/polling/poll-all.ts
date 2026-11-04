import type { ManagedRepo } from "@usine/config/factory";
import type { ScopedChange } from "@usine/core/changes";
import { jsonKey } from "@usine/core/json-key";
import { canonicalRepositoryName } from "@usine/core/repository";
import { DateTime, Effect, Option, Ref, Result } from "effect";
import type { CiMonitor } from "../ci.ts";
import type { LabelPreflightFinding } from "../label-reconciler.ts";
import {
  type InterruptedRepositoryCycle,
  latestPollAt,
  PollCycle,
  type RepositoryCycle,
  RepositoryPoll,
  type RepositoryPollError,
  RepositoryPollFailure,
  repositoryFailureLogFields,
} from "./cycle.ts";
import {
  advance,
  decisionLogFields,
  type PollFailureStreak,
  type RepositoryOutcome,
} from "./failure-streaks.ts";

/** The number of repositories polled in parallel, kept low for GitHub's per-token limits. */
const REPOSITORY_CONCURRENCY = 4;

interface PollAllState {
  readonly latest: Ref.Ref<Option.Option<PollCycle>>;
  readonly completedPolls: Ref.Ref<ReadonlyMap<string, RepositoryPoll>>;
  readonly failureStreaks: Ref.Ref<ReadonlyMap<string, PollFailureStreak>>;
}

/** Settles repository polls and CI observations, retaining failures and publishing attention changes. */
export const pollAll = Effect.fn("PollingTriggers.pollAll")(function* <
  Watched extends { readonly repository: ManagedRepo },
  R,
>(
  watched: ReadonlyArray<Watched>,
  ciCycle: Effect.Success<ReturnType<CiMonitor["Service"]["reconcile"]>>,
  { latest, completedPolls, failureStreaks }: PollAllState,
  {
    pollRepository,
    defer,
    publish,
  }: {
    readonly pollRepository: (
      watched: Watched,
    ) => Effect.Effect<RepositoryCycle, RepositoryPollError | InterruptedRepositoryCycle, R>;
    readonly defer: (until: Option.Option<DateTime.Utc>) => Effect.Effect<void>;
    readonly publish: (changes: ReadonlyArray<ScopedChange>) => Effect.Effect<void>;
  },
) {
  yield* Effect.annotateCurrentSpan({
    repositories: watched.map(({ repository }) => repository.name),
  });
  yield* defer(ciCycle.nextPollAt);
  const settled = yield* Effect.forEach(
    Option.isSome(ciCycle.nextPollAt) ? [] : watched,
    (repository) =>
      Effect.result(pollRepository(repository)).pipe(
        Effect.map((result) => ({ repository, result }) as const),
      ),
    { concurrency: REPOSITORY_CONCURRENCY },
  );

  const cycles: Array<RepositoryCycle> = [];
  const backoffs: Array<Option.Option<DateTime.Utc>> = [ciCycle.nextPollAt];
  const preflightFindings: Array<LabelPreflightFinding> = [];
  const completedAt = yield* DateTime.now;
  const outcomes: Array<RepositoryOutcome> = [...ciCycle.outcomes];
  if (Option.isSome(ciCycle.nextPollAt)) {
    outcomes.push(
      ...watched.map(({ repository }): RepositoryOutcome => ({
        _tag: "RateLimited",
        repository: repository.name,
        source: "Polling",
        failures: [],
      })),
    );
  }
  for (const { repository, result } of settled) {
    if (Result.isSuccess(result)) {
      outcomes.push({
        _tag: result.success._tag,
        repository: repository.repository.name,
        source: "Polling",
        failures: result.success.failures,
      });
      cycles.push(result.success);
      preflightFindings.push(...result.success.preflightFindings);
      yield* Ref.update(completedPolls, (current) =>
        new Map(current).set(
          canonicalRepositoryName(repository.repository.name),
          RepositoryPoll.make({ repository: repository.repository.name, completedAt }),
        ),
      );
      continue;
    }
    const interrupted = result.failure._tag === "InterruptedRepositoryCycle";
    const error: RepositoryPollError = interrupted ? result.failure.error : result.failure;
    const failures = interrupted ? result.failure.failures : [];
    if (interrupted) {
      preflightFindings.push(...result.failure.preflightFindings);
      backoffs.push(result.failure.nextPollAt);
      yield* defer(result.failure.nextPollAt);
    }
    if (error._tag === "GitHubRateLimitError") {
      outcomes.push({
        _tag: "RateLimited",
        source: "Polling",
        repository: repository.repository.name,
        failures,
      });
      // A rate-limit pause is scheduling input, not a repository failure.
      yield* Effect.logWarning("GitHub rate limit reached; delaying the next cycle", {
        repository: repository.repository.name,
        operation: error.operation,
        retryAt: DateTime.formatIso(error.retryAt),
      });
      backoffs.push(Option.some(error.retryAt));
      yield* defer(Option.some(error.retryAt));
      continue;
    }
    yield* Effect.logError("Repository poll cycle failed; siblings were unaffected", {
      repository: repository.repository.name,
      ...repositoryFailureLogFields(error),
    });
    outcomes.push({
      _tag: "Failed",
      source: "Polling",
      repository: repository.repository.name,
      failures,
      failure: RepositoryPollFailure.make({
        repository: repository.repository.name,
        errorTag: error._tag,
        message: repositoryFailureLogFields(error).message,
      }),
    });
  }
  const failureStreaksState = yield* Ref.get(failureStreaks);
  const reported = advance(
    failureStreaksState,
    [
      ...watched.map(({ repository }) => repository.name),
      ...ciCycle.outcomes.map(({ repository }) => repository),
    ],
    outcomes,
  );
  yield* Ref.set(failureStreaks, reported.streaks);
  for (const decision of reported.decisions) {
    const { level, ...fields } = decisionLogFields(decision);
    yield* Effect.logWithLevel(level)("Repository poll failure streak updated", fields);
  }
  const polls = yield* Ref.get(completedPolls);
  const cycle = PollCycle.make({
    repositoryPolls: watched.flatMap(({ repository }) =>
      Option.toArray(Option.fromNullishOr(polls.get(canonicalRepositoryName(repository.name)))),
    ),
    repositories: watched.length,
    changedItems: cycles.reduce((sum, cycle) => sum + cycle.changedItems, 0),
    submissions: cycles.flatMap(({ submissions }) => submissions),
    revokedRuns: cycles.reduce((sum, cycle) => sum + cycle.revokedRuns, 0),
    failures: reported.failures,
    preflightFindings,
    nextPollAt: latestPollAt([...cycles.map(({ nextPollAt }) => nextPollAt), ...backoffs]),
  });
  const previous = yield* Ref.getAndSet(latest, Option.some(cycle));
  yield* publish(
    watched.flatMap(({ repository }) => {
      const audience = { _tag: "Repository", repository: repository.name } as const;
      const findings = (value: PollCycle | undefined) =>
        jsonKey([
          (value?.failures ?? []).filter(
            (failure) =>
              canonicalRepositoryName(failure.repository) ===
              canonicalRepositoryName(repository.name),
          ),
          (value?.preflightFindings ?? []).filter(
            (finding) =>
              canonicalRepositoryName(finding.repository) ===
              canonicalRepositoryName(repository.name),
          ),
        ]);
      const changed = findings(Option.getOrUndefined(previous)) !== findings(cycle);
      return changed ? [{ audience, target: { kind: "attention", id: "instance" } as const }] : [];
    }),
  );
  return cycle;
});
