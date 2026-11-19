import { assert, it } from "@effect/vitest";
import { AttemptWindows } from "@usine/core/attempt";
import { ciHandoff, CiPolicy } from "@usine/core/ci";
import { Event } from "@usine/core/event";
import { jsonKey } from "@usine/core/json-key";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { harvestFacts } from "@usine/core/step/harvest";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { Effect, Fiber, Logger, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Submission } from "../src/engine/submission.ts";
import type { StepExecution } from "../src/step-executor.ts";
import { RunStore } from "../src/store/store.ts";
import { withRunStore } from "./store/support.ts";
import { submission } from "./support.ts";

class GhFailed extends Schema.TaggedError<GhFailed, { readonly Brand: unique symbol }>()(
  "GhFailed",
  { message: Schema.String },
) {}

class GitFailed extends Schema.TaggedError<GitFailed, { readonly Brand: unique symbol }>()(
  "GitFailed",
  { message: Schema.String },
) {}

type Answer = Effect.Effect<ReadonlyArray<string>, GhFailed | GitFailed>;

const BASE = CommitSha.make("0".repeat(40));
const HEAD = CommitSha.make("a".repeat(40));
const OTHER = CommitSha.make("c".repeat(40));
const BRANCH = "usine/fix";
const PULL_REQUEST = "gh api repos/basaltbytes/usine/pulls/815";
const BRANCH_PULL_REQUESTS =
  "gh api repos/basaltbytes/usine/pulls?head=basaltbytes:usine%2Ffix&state=open&per_page=100";
const INDEX = `gh api repos/basaltbytes/usine/commits/${HEAD}/pulls?per_page=100 --paginate --slurp`;
const URL_815 = "https://github.com/basaltbytes/usine/pull/815";

const policy = CiPolicy.make({ fixLoop: LoopName.make("fix"), timeoutSeconds: 3600 });

const handoff = (head: CommitSha) =>
  `[usine:awaiting-ci]\n${jsonKey({ pull_request: 815, head, fix_loop: "fix", timeout_seconds: 3600, on_green: [] })}`;

const OWN = { id: 1, full_name: "basaltbytes/usine" };
const FORK = { id: 2, full_name: "someone/usine" };

interface PullRequestFixture {
  readonly number?: number;
  readonly url?: string;
  readonly head: CommitSha;
  readonly branch?: string;
  readonly repository?: { readonly id: number; readonly full_name: string };
}

/** GitHub's REST response for an open pull request into the repository with ID 1, #815 by default. */
const pullResponse = ({
  number = 815,
  url = URL_815,
  head,
  branch = BRANCH,
  repository = OWN,
}: PullRequestFixture) => ({
  number,
  html_url: url,
  state: "open",
  merged_at: null,
  head: { sha: head, ref: branch, repo: repository },
  base: { repo: { id: 1 } },
});

/** GitHub's open pull request 815 of the repository with ID 1, with a head that lags at `BASE` by default. */
const pullRequest = (
  branch: string,
  repository: { readonly id: number; readonly full_name: string },
  head: CommitSha = BASE,
): Answer => Effect.succeed([jsonKey(pullResponse({ head, branch, repository }))]);

const ghFailed: Answer = Effect.fail(GhFailed.make({ message: "gh: Bad Gateway (HTTP 502)" }));
const branchAt = (commit: CommitSha) => `${commit}\trefs/heads/${BRANCH}`;
const PULL_REF = `${HEAD}\trefs/pull/815/head`;

interface Checkout {
  readonly head?: CommitSha;
  /** The checkout's branch, or `""` if HEAD is detached. */
  readonly branch: string;
  /** The `git ls-remote origin` lines or read effect. */
  readonly origin: ReadonlyArray<string> | Answer;
  /** The answers to each `gh` command, one per try; the last one repeats. */
  readonly github: ReadonlyArray<readonly [string, ReadonlyArray<Answer>]>;
}

/** Returns a runner that answers `git` and `gh` from `checkout` and records each command. */
const scripted = (checkout: Checkout, commands: Array<string>) => {
  const head = checkout.head ?? HEAD;
  const answers = new Map<string, ReadonlyArray<Answer>>([
    [
      `git log --reverse --format=%H %s ${BASE}..HEAD`,
      [Effect.succeed(head === BASE ? [] : [`${head} Fix it`])],
    ],
    ["git rev-parse HEAD", [Effect.succeed([head])]],
    [
      "git branch --show-current",
      [Effect.succeed(checkout.branch === "" ? [] : [checkout.branch])],
    ],
    [
      "git ls-remote origin refs/heads/* refs/pull/*/head",
      [Effect.isEffect(checkout.origin) ? checkout.origin : Effect.succeed(checkout.origin)],
    ],
    ...checkout.github,
  ]);
  return (command: "git" | "gh", args: ReadonlyArray<string>): Answer =>
    Effect.suspend(() => {
      const line = [command, ...args].join(" ");
      const tries = commands.filter((run) => run === line).length;
      commands.push(line);
      const answer = answers.get(line);
      return answer === undefined
        ? Effect.die(`unexpected command ${line}`)
        : (answer[Math.min(tries, answer.length - 1)] ?? Effect.die(`no answer for ${line}`));
    });
};

/** Runs `effect` on a test clock advanced past the 10-second harvest budget. */
const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(effect);
    yield* TestClock.adjust("10 seconds");
    return yield* Fiber.join(running);
  }).pipe(Effect.provide(TestClock.layer()));

/**
 * Harvests the scripted `checkout` for a CI-requiring Run's first Attempt, as an executor does
 * after the parent reports `message`, and finishes the Attempt with the result.
 */
const finishHarvested = (
  message: string,
  checkout: Checkout,
  revision = RepositoryRevision.make("revision-1"),
) =>
  withRunStore(
    Effect.gen(function* () {
      const store = yield* RunStore;
      const runId = RunId.make("unverified-handoff");
      const submitted = submission({ number: 1 });
      yield* store.recordAndClaim(
        Submission.make({
          ...submitted,
          event: Event.make({
            ...submitted.event,
            payload: { number: 1, url: "https://github.com/basaltbytes/usine/issues/1" },
          }),
          revision,
          ciPolicy: Option.some(policy),
        }),
        runId,
      );
      const started = yield* store.beginAttempt(
        runId,
        WorkerName.make("local"),
        "local",
        Option.none(),
      );
      assert(started._tag === "AttemptStarted");
      const execution: StepExecution = started.execution;
      const commands: Array<string> = [];
      const infos: Array<unknown> = [];
      const warnings: Array<unknown> = [];
      const harvest = yield* onTestClock(
        harvestFacts(
          {
            attemptId: execution.attempt.id,
            repository: execution.repository,
            revision: execution.revision,
            baseCommit: BASE,
            payload: execution.event.payload,
            preparedAt: Option.none(),
            botLogin: Option.none(),
            agent: execution.agent,
            requiresCi: execution.requiresCi,
          },
          scripted(checkout, commands),
          Effect.succeed(AttemptWindows.make({ own: Option.none(), overlapping: [] })),
          Result.getOrElse(ciHandoff(message), () => Option.none()),
        ),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, message: logged }) => {
              if (logLevel === "Info") infos.push(logged);
              if (logLevel === "Warn") warnings.push(logged);
            }),
          ]),
        ),
      );
      const decision = yield* store.finishAttempt(
        execution.attempt,
        Result.succeed(StepResult.make({ message, ...harvest })),
      );
      const snapshot = yield* store.snapshot(runId);
      const failure = Option.flatMap(snapshot.attempts[0]?.outcome ?? Option.none(), (outcome) =>
        outcome._tag === "Failed" ? Option.some(outcome.failure) : Option.none(),
      );
      return {
        execution,
        decision,
        failure,
        commands,
        infos,
        warnings,
        state: snapshot.run.state,
      };
    }),
  );

const tries = (commands: ReadonlyArray<string>, command: string) =>
  commands.filter((run) => run === command).length;

it.live("a plain success retries the attempt as an InfraFailure when origin can't be read", () =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: BRANCH,
      origin: Effect.fail(GitFailed.make({ message: "git: Could not resolve host" })),
      github: [],
    });
    assert.strictEqual(finished.decision._tag, "RetryAttempt");
    assert(Option.isSome(finished.failure));
    assert.strictEqual(finished.failure.value._tag, "InfraFailure");
    assert.strictEqual(
      finished.failure.value.message,
      "CI can't wait on the pushed pull request: git couldn't read the checkout or origin: GitFailed: git: Could not resolve host",
    );
  }),
);

it.live(
  "an unchanged detached checkout fails instead of waiting on an unrelated pull request",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("No changes needed.", {
        head: BASE,
        branch: "",
        origin: [`${BASE}\trefs/heads/revision-1`],
        github: [
          [
            "gh api repos/basaltbytes/usine/pulls?head=basaltbytes:revision-1&state=open&per_page=100",
            [
              Effect.succeed([
                jsonKey([
                  pullResponse({
                    number: 900,
                    url: "https://github.com/basaltbytes/usine/pull/900",
                    head: BASE,
                    branch: "revision-1",
                  }),
                ]),
              ]),
            ],
          ],
        ],
      });
      assert.strictEqual(finished.decision._tag, "RunFailed");
      assert(Option.isSome(finished.failure));
      assert.strictEqual(finished.failure.value._tag, "AgentFailure");
      assert.strictEqual(
        finished.failure.value.message,
        `CI can't wait on the pushed pull request: no open pull request has the checkout's HEAD ${BASE} as its head`,
      );
      assert.isFalse(finished.commands.some((command) => command.startsWith("gh ")));
    }),
);

it.live(
  "an unchanged checkout at a fixed commit revision with detached HEAD still waits on its pull request's CI",
  () =>
    Effect.gen(function* () {
      const revision = RepositoryRevision.make(BASE);
      const finished = yield* finishHarvested(
        "No changes needed.",
        {
          head: BASE,
          branch: "",
          origin: [branchAt(BASE)],
          github: [
            [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([pullResponse({ head: BASE })])])]],
          ],
        },
        revision,
      );
      assert.strictEqual(finished.execution.revision, revision);
      assert.isTrue(finished.execution.requiresCi);
      assert.strictEqual(finished.decision._tag, "RunAwaitingCi");
      assert(finished.state._tag === "AwaitingCi");
      assert.strictEqual(finished.state.handoff.pullRequest, 815);
      assert.strictEqual(finished.state.handoff.head, BASE);
      assert.isTrue(Option.isNone(finished.failure));
    }),
);

it.live.each([
  {
    reason: "HeadMismatch",
    message: handoff(OTHER),
    checkout: { branch: BRANCH, origin: [branchAt(OTHER), PULL_REF], github: [] },
    failure: "AgentFailure",
    detail: `the handoff names head ${OTHER} for pull request #815, but the checkout's HEAD is ${HEAD}`,
    reads: 0,
  },
  {
    reason: "PullRequestNotFound",
    message: handoff(HEAD),
    checkout: { branch: BRANCH, origin: [branchAt(HEAD)], github: [[PULL_REQUEST, [ghFailed]]] },
    failure: "AgentFailure",
    detail: "origin has no pull request #815",
    reads: 1,
  },
  {
    reason: "RepositoryMismatch",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [pullRequest(BRANCH, FORK)]]],
    },
    failure: "AgentFailure",
    detail: "pull request #815 comes from someone/usine, not from the Run's repository",
    reads: 1,
  },
  {
    reason: "VerificationTimedOut",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [Effect.never]]],
    },
    failure: "InfraFailure",
    detail: "the git and GitHub reads didn't finish within 10 seconds",
    reads: 1,
  },
  {
    reason: "GitHubReadFailed on invalid output after retries",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [Effect.succeed(["invalid JSON"])]]],
    },
    failure: "InfraFailure",
    detail: "GitHub couldn't be read: HarvestError: GitHub returned invalid pull request #815",
    reads: 3,
  },
] satisfies ReadonlyArray<{
  readonly reason: string;
  readonly message: string;
  readonly checkout: Checkout;
  readonly failure: "AgentFailure" | "InfraFailure";
  readonly detail: string;
  readonly reads: number;
}>)(
  "an unverified CI handoff ($reason) fails with an $failure that names the reason",
  ({ message, checkout, failure, detail, reads }) =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested(message, checkout);
      assert.strictEqual(
        finished.decision._tag,
        failure === "InfraFailure" ? "RetryAttempt" : "RunFailed",
      );
      assert(Option.isSome(finished.failure));
      assert.strictEqual(finished.failure.value._tag, failure);
      assert.strictEqual(
        finished.failure.value.message,
        `CI can't wait on the pushed pull request: ${detail}`,
      );
      assert.strictEqual(tries(finished.commands, PULL_REQUEST), reads);
      assert.notInclude(finished.commands, INDEX);
      assert.lengthOf(
        finished.infos.filter(
          (logged) =>
            Array.isArray(logged) &&
            logged[0] === "Could not verify the pull request that CI waits on",
        ),
        1,
      );
    }),
);

it.live(
  "a CI handoff from a renamed repository keeps its pull request when the index can't be read",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested(handoff(HEAD), {
        branch: BRANCH,
        origin: [branchAt(HEAD), PULL_REF],
        github: [
          // GitHub answers for the renamed repository under its old name.
          [PULL_REQUEST, [pullRequest(BRANCH, { id: 1, full_name: "basaltbytes/old-usine" })]],
          [INDEX, [ghFailed]],
        ],
      });
      assert(finished.decision._tag === "RunAwaitingCi");
      assert.deepStrictEqual(
        finished.decision.result.facts.flatMap((fact) =>
          fact._tag === "PullRequest" && Option.contains(fact.head, HEAD) ? [fact.number] : [],
        ),
        [815],
      );
      assert.lengthOf(
        finished.warnings.filter(
          (logged) =>
            Array.isArray(logged) &&
            logged[0] ===
              "Pull request discovery failed; keeping only the CI handoff's pull request",
        ),
        1,
      );
    }),
);

it.live(
  "a CI loop's success without a handoff fails with an AgentFailure when the pushed branch has no open pull request",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("Finished the change.", {
        branch: BRANCH,
        origin: [branchAt(HEAD)],
        github: [[BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([])])]]],
      });
      assert.isTrue(finished.execution.requiresCi);
      assert.strictEqual(finished.decision._tag, "RunFailed");
      assert.deepStrictEqual(
        Option.map(finished.failure, ({ message }) => message),
        Option.some(
          `CI can't wait on the pushed pull request: no open pull request has branch ${BRANCH} as its head`,
        ),
      );
    }),
);

/** GitHub's commit-to-pull-request index listing pull request 815 at `HEAD`. */
const indexed: Answer = Effect.succeed([jsonKey([[pullResponse({ head: HEAD })]])]);

it.live("a plain success waits on CI after retrying a failed read of the named branch", () =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: BRANCH,
      origin: [branchAt(HEAD)],
      github: [
        [
          BRANCH_PULL_REQUESTS,
          [ghFailed, Effect.succeed([jsonKey([pullResponse({ head: HEAD })])])],
        ],
      ],
    });
    assert.strictEqual(finished.decision._tag, "RunAwaitingCi");
    assert(finished.state._tag === "AwaitingCi");
    assert.strictEqual(finished.state.handoff.pullRequest, 815);
    assert.strictEqual(finished.state.handoff.head, HEAD);
    assert.isTrue(Option.isNone(finished.failure));
    assert.strictEqual(tries(finished.commands, BRANCH_PULL_REQUESTS), 2);
    assert.lengthOf(
      finished.warnings.filter(
        (logged) =>
          Array.isArray(logged) &&
          logged[0] === `Could not read the pull requests of branch ${BRANCH} on GitHub; retrying`,
      ),
      1,
    );
  }),
);

it.live(
  "a plain success retries the attempt as an InfraFailure after exhausting reads of the pull request whose ref is the detached checkout's HEAD",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("Finished the change.", {
        branch: "",
        origin: [PULL_REF],
        github: [[PULL_REQUEST, [ghFailed]]],
      });
      assert.strictEqual(finished.decision._tag, "RetryAttempt");
      assert(Option.isSome(finished.failure));
      assert.strictEqual(finished.failure.value._tag, "InfraFailure");
      assert.strictEqual(
        finished.failure.value.message,
        "CI can't wait on the pushed pull request: GitHub couldn't be read: GhFailed: gh: Bad Gateway (HTTP 502)",
      );
      assert.strictEqual(tries(finished.commands, PULL_REQUEST), 3);
      assert.lengthOf(
        finished.warnings.filter(
          (logged) =>
            Array.isArray(logged) &&
            logged[0] === "Could not read pull request #815 on GitHub; retrying",
        ),
        2,
      );
    }),
);

// GitHub's commit-to-pull-request index can lag, so the detached checkout's pull request ref is
// read by number.
it.live(
  "a CI loop's success from a detached checkout waits on the open pull request from the Run's repository",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("Finished the change.", {
        branch: "",
        origin: [PULL_REF],
        github: [
          [PULL_REQUEST, [pullRequest(BRANCH, OWN, HEAD)]],
          [INDEX, [indexed]],
        ],
      });
      assert.strictEqual(finished.decision._tag, "RunAwaitingCi");
      assert.isTrue(Option.isNone(finished.failure));
      assert.notInclude(finished.commands, INDEX);
      assert.notInclude(finished.commands, BRANCH_PULL_REQUESTS);
    }),
);

it.live(
  "a detached success with one unreadable candidate branch waits on the other branch's open pull request",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("Finished the change.", {
        branch: "",
        origin: [`${HEAD}\trefs/heads/unreadable`, branchAt(HEAD)],
        github: [
          [
            "gh api repos/basaltbytes/usine/pulls?head=basaltbytes:unreadable&state=open&per_page=100",
            [ghFailed],
          ],
          [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([pullResponse({ head: HEAD })])])]],
        ],
      });
      assert.strictEqual(finished.decision._tag, "RunAwaitingCi");
      assert.lengthOf(
        finished.warnings.filter(
          (logged) =>
            Array.isArray(logged) &&
            logged[0] ===
              "Could not read one candidate's pull requests; CI waits on the other candidates' open pull requests",
        ),
        1,
      );
    }),
);

it.live("a plain success fails when its branch isn't on origin", () =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: BRANCH,
      origin: [PULL_REF],
      github: [[BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([pullResponse({ head: HEAD })])])]]],
    });
    assert.strictEqual(finished.decision._tag, "RunFailed");
    assert(Option.isSome(finished.failure));
    assert.strictEqual(finished.failure.value._tag, "AgentFailure");
    assert.strictEqual(
      finished.failure.value.message,
      `CI can't wait on the pushed pull request: branch ${BRANCH} isn't on origin`,
    );
  }),
);

it.live(
  "a detached success fails when candidate branches have no open pull request despite a matching PR ref",
  () =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested("Finished the change.", {
        branch: "",
        origin: [`${HEAD}\trefs/heads/no-pr`, branchAt(HEAD), `${OTHER}\trefs/heads/old`, PULL_REF],
        github: [
          [
            "gh api repos/basaltbytes/usine/pulls?head=basaltbytes:no-pr&state=open&per_page=100",
            [Effect.succeed([jsonKey([])])],
          ],
          [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([])])]],
          [INDEX, [indexed]],
        ],
      });
      assert.strictEqual(finished.decision._tag, "RunFailed");
      assert.notInclude(finished.commands, INDEX);
      assert(Option.isSome(finished.failure));
      assert.strictEqual(finished.failure.value._tag, "AgentFailure");
      assert.strictEqual(
        finished.failure.value.message,
        `CI can't wait on the pushed pull request: no open pull request has the checkout's HEAD ${HEAD} as its head`,
      );
    }),
);
