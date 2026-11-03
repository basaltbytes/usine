import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { Match } from "effect";
import type { RepositoryPollFailure } from "./cycle.ts";

export interface PollFailureStreak {
  readonly consecutiveFailures: number;
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
}

/** A settled repository observation, including failures isolated within a partial cycle. */
export type RepositoryOutcome = {
  readonly repository: RepositoryName;
  readonly source: "Polling" | "Ci";
  readonly failures: ReadonlyArray<RepositoryPollFailure>;
} & (
  | { readonly _tag: "Polled" }
  | { readonly _tag: "Failed"; readonly failure: RepositoryPollFailure }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "Skipped" }
);

export type StreakDecision = { readonly repository: RepositoryName } & (
  | { readonly _tag: "Recovered"; readonly previousConsecutive: number }
  | { readonly _tag: "Counting"; readonly consecutive: number }
  | { readonly _tag: "Reported"; readonly consecutive: number }
  | { readonly _tag: "Preserved" }
);

/** Returns safe fields and severity for a streak transition. */
export const decisionLogFields = (decision: StreakDecision) => ({
  repository: decision.repository,
  decision: decision._tag,
  ...Match.valueTags(decision, {
    Recovered: ({ previousConsecutive }) => ({
      level: previousConsecutive > 0 ? ("Info" as const) : ("Debug" as const),
      previousConsecutive,
    }),
    Counting: ({ consecutive }) => ({
      level: "Info" as const,
      consecutiveFailures: consecutive,
      reported: false,
    }),
    Reported: ({ consecutive }) => ({
      level: "Info" as const,
      consecutiveFailures: consecutive,
      reported: true,
    }),
    Preserved: () => ({ level: "Info" as const }),
  }),
});

const isGitHubFailure = (failure: RepositoryPollFailure): boolean =>
  failure.errorTag === "GitHubApiError" || failure.errorTag === "InvalidGitHubResponseError";

/** Advances each watched repository once; incomplete observations preserve its last streak. */
export const advance = (
  previous: ReadonlyMap<string, PollFailureStreak>,
  watched: ReadonlyArray<RepositoryName>,
  outcomes: ReadonlyArray<RepositoryOutcome>,
) => {
  const active = new Set(watched.map(canonicalRepositoryName));
  const streaks = new Map([...previous].filter(([repository]) => active.has(repository)));
  const settled = new Map<string, Array<RepositoryOutcome>>();
  for (const outcome of outcomes) {
    const key = canonicalRepositoryName(outcome.repository);
    settled.set(key, [...(settled.get(key) ?? []), outcome]);
  }
  const failures: Array<RepositoryPollFailure> = [];
  const decisions: Array<StreakDecision> = [];

  for (const repository of new Map(
    watched.map((name) => [canonicalRepositoryName(name), name]),
  ).values()) {
    const key = canonicalRepositoryName(repository);
    const observations = settled.get(key) ?? [];
    const outcome = observations.find(({ source }) => source === "Polling") ??
      observations[0] ?? {
        _tag: "Skipped",
        source: "Polling",
        repository,
        failures: [],
      };
    const observed = observations.flatMap((observation) =>
      Match.valueTags(observation, {
        Polled: ({ failures }) => failures,
        Failed: ({ failures, failure }) => [...failures, failure],
        RateLimited: ({ failures }) => failures,
        Skipped: ({ failures }) => failures,
      }),
    );
    failures.push(...observed.filter((failure) => !isGitHubFailure(failure)));
    const count = (): StreakDecision => {
      const github = observed.filter(isGitHubFailure);
      if (github.length === 0) {
        const previousConsecutive = streaks.get(key)?.consecutiveFailures ?? 0;
        streaks.delete(key);
        return { _tag: "Recovered", repository, previousConsecutive };
      }
      const consecutive = (streaks.get(key)?.consecutiveFailures ?? 0) + 1;
      streaks.set(key, { consecutiveFailures: consecutive, failures: github });
      return { _tag: consecutive >= 3 ? "Reported" : "Counting", repository, consecutive };
    };
    const preserve = (): StreakDecision => ({ _tag: "Preserved", repository });
    decisions.push(
      Match.valueTags(outcome, {
        Polled: count,
        Failed: count,
        RateLimited: preserve,
        Skipped: preserve,
      }),
    );
  }
  failures.push(
    ...[...streaks.values()].flatMap((streak) =>
      streak.consecutiveFailures >= 3 ? streak.failures : [],
    ),
  );
  return { streaks, failures, decisions };
};
