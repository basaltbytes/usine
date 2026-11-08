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
import { Effect, Fiber, Logger, Option, Result, Schema, Tracer } from "effect";
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

type Answer = Effect.Effect<ReadonlyArray<string>, GhFailed>;

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

/** GitHub's pull request 815 with a head that lags at `BASE`. */
const pullRequest = (branch: string, repository: string): Answer =>
  Effect.succeed([
    jsonKey({
      number: 815,
      html_url: URL_815,
      head: { sha: BASE, ref: branch, repo: { full_name: repository } },
    }),
  ]);

const ghFailed: Answer = Effect.fail(GhFailed.make({ message: "gh: Bad Gateway (HTTP 502)" }));
const branchAt = (commit: CommitSha) => `${commit}\trefs/heads/${BRANCH}`;
const PULL_REF = `${HEAD}\trefs/pull/815/head`;

interface Checkout {
  readonly head?: CommitSha;
  /** The checkout's branch, or `""` if HEAD is detached. */
  readonly branch: string;
  /** The `git ls-remote origin` lines. */
  readonly origin: ReadonlyArray<string>;
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
    ["git ls-remote origin refs/heads/* refs/pull/*/head", [Effect.succeed(checkout.origin)]],
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
      const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
      assert(started._tag === "AttemptStarted");
      const execution: StepExecution = started.execution;
      const commands: Array<string> = [];
      const infos: Array<unknown> = [];
      const warnings: Array<unknown> = [];
      const spans: Array<Tracer.Span> = [];
      const native = yield* Effect.tracer;
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
        Effect.withTracer(
          Tracer.make({
            span: (options) => {
              const span = native.span(options);
              spans.push(span);
              return span;
            },
          }),
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
        spans,
        state: snapshot.run.state,
      };
    }),
  );

const tries = (commands: ReadonlyArray<string>, command: string) =>
  commands.filter((run) => run === command).length;

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
                  { number: 900, html_url: "https://github.com/basaltbytes/usine/pull/900" },
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

it.live.each([
  {
    checkout: "a fixed commit revision with detached HEAD",
    revision: RepositoryRevision.make(BASE),
    branch: "",
  },
  {
    checkout: "a branch revision with a named branch",
    revision: RepositoryRevision.make(BRANCH),
    branch: BRANCH,
  },
])(
  "an unchanged checkout at $checkout still waits on its pull request's CI",
  ({ revision, branch }) =>
    Effect.gen(function* () {
      const finished = yield* finishHarvested(
        "No changes needed.",
        {
          head: BASE,
          branch,
          origin: [branchAt(BASE)],
          github: [
            [
              BRANCH_PULL_REQUESTS,
              [Effect.succeed([jsonKey([{ number: 815, html_url: URL_815 }])])],
            ],
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
      github: [[PULL_REQUEST, [pullRequest(BRANCH, "someone/usine")]]],
    },
    failure: "AgentFailure",
    detail: "pull request #815 comes from someone/usine, not from the Run's repository",
    reads: 1,
  },
  {
    reason: "BranchNotAtHead",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(OTHER), PULL_REF],
      github: [[PULL_REQUEST, [pullRequest(BRANCH, "basaltbytes/usine")]]],
    },
    failure: "AgentFailure",
    detail: `branch ${BRANCH} of pull request #815 is at ${OTHER} on origin, not at the checkout's HEAD ${HEAD}`,
    reads: 1,
  },
  {
    reason: "GitHubReadFailed on timeout",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [Effect.never]]],
    },
    failure: "InfraFailure",
    detail: "GitHub couldn't be read: the reads didn't finish within 10 seconds",
    reads: 1,
  },
  {
    reason: "GitHubReadFailed on invalid output without retrying",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [
        [
          PULL_REQUEST,
          [Effect.succeed(["invalid JSON"]), pullRequest(BRANCH, "basaltbytes/usine")],
        ],
      ],
    },
    failure: "InfraFailure",
    detail:
      "GitHub couldn't be read: HarvestError: GitHub returned invalid CI handoff pull request",
    reads: 1,
  },
  {
    reason: "GitHubReadFailed",
    message: handoff(HEAD),
    checkout: {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [ghFailed]]],
    },
    failure: "InfraFailure",
    detail: "GitHub couldn't be read: GhFailed: gh: Bad Gateway (HTTP 502)",
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

it.live("a CI handoff verifies after a failed pull request read is retried", () =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested(handoff(HEAD), {
      branch: BRANCH,
      origin: [branchAt(HEAD), PULL_REF],
      github: [[PULL_REQUEST, [ghFailed, pullRequest(BRANCH, "basaltbytes/usine")]]],
    });
    assert.strictEqual(finished.decision._tag, "RunAwaitingCi");
    assert(finished.state._tag === "AwaitingCi");
    assert.strictEqual(finished.state.handoff.head, HEAD);
    assert.strictEqual(tries(finished.commands, PULL_REQUEST), 2);
    assert.lengthOf(
      finished.warnings.filter(
        (logged) =>
          Array.isArray(logged) &&
          logged[0] === "Could not read pull request #815 on GitHub; retrying",
      ),
      1,
    );
    const discovery = finished.spans.find((span) => span.name === "StepResult.harvestPullRequests");
    const verification = finished.spans.find(
      (span) => span.name === "StepResult.verificationOutcome",
    );
    assert(discovery && verification);
    assert.strictEqual(Option.getOrNull(verification.parent), discovery);
    for (const span of [discovery, verification]) {
      assert.strictEqual(span.attributes.get("attemptId"), finished.execution.attempt.id);
      assert.strictEqual(span.attributes.get("repository"), finished.execution.repository);
      assert.strictEqual(span.attributes.get("item"), 1);
    }
    // Each read logs the branch's commit on origin against GitHub's lagging pull request head.
    assert.deepStrictEqual(
      finished.infos.filter(
        (logged) => Array.isArray(logged) && logged[0] === "Read the CI handoff's pull request",
      ),
      [
        [
          "Read the CI handoff's pull request",
          {
            attemptId: finished.execution.attempt.id,
            pullRequest: 815,
            branch: BRANCH,
            branchHead: HEAD,
            pullRequestHead: BASE,
          },
        ],
      ],
    );
  }),
);

it.live.each([
  {
    outcome: "waits on the open pull request of the pushed branch",
    github: [
      [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([{ number: 815, html_url: URL_815 }])])]],
      // GitHub's commit-to-pull-request index lags and doesn't list the pull request yet.
      [INDEX, [Effect.succeed([jsonKey([[]])])]],
    ],
    decision: "RunAwaitingCi",
    failure: Option.none<string>(),
  },
  {
    outcome: "fails with an AgentFailure when the pushed branch has no open pull request",
    github: [[BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([])])]]],
    decision: "RunFailed",
    failure: Option.some(
      `CI can't wait on the pushed pull request: no open pull request has branch ${BRANCH} as its head`,
    ),
  },
] satisfies ReadonlyArray<{
  readonly outcome: string;
  readonly github: Checkout["github"];
  readonly decision: string;
  readonly failure: Option.Option<string>;
}>)("a CI loop's success without a handoff $outcome", ({ github, decision, failure }) =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: BRANCH,
      origin: [branchAt(HEAD)],
      github,
    });
    assert.isTrue(finished.execution.requiresCi);
    assert.strictEqual(finished.decision._tag, decision);
    assert.deepStrictEqual(
      Option.map(finished.failure, ({ message }) => message),
      failure,
    );
    if (decision === "RunAwaitingCi") {
      assert(finished.state._tag === "AwaitingCi");
      assert.strictEqual(finished.state.handoff.pullRequest, 815);
      assert.strictEqual(finished.state.handoff.head, HEAD);
    }
  }),
);

/** GitHub's commit-to-pull-request index listing pull request 815 at `HEAD`. */
const indexed = (state: "open" | "closed", repository: string): Answer =>
  Effect.succeed([
    jsonKey([
      [
        {
          number: 815,
          html_url: URL_815,
          state,
          head: { sha: HEAD, repo: { full_name: repository } },
        },
      ],
    ]),
  ]);

it.live.each([
  {
    outcome: "waits on the open pull request from the Run's repository",
    index: indexed("open", "basaltbytes/usine"),
    decision: "RunAwaitingCi",
    failure: Option.none<string>(),
  },
  {
    outcome: "fails with an AgentFailure for an open pull request from a fork",
    index: indexed("open", "someone/usine"),
    decision: "RunFailed",
    failure: Option.some(
      "CI can't wait on the pushed pull request: pull request #815 comes from someone/usine, not from the Run's repository",
    ),
  },
  {
    outcome: "fails with an AgentFailure for a closed pull request",
    index: indexed("closed", "basaltbytes/usine"),
    decision: "RunFailed",
    failure: Option.some(
      `CI can't wait on the pushed pull request: no open pull request has the checkout's HEAD ${HEAD} as its head`,
    ),
  },
] satisfies ReadonlyArray<{
  readonly outcome: string;
  readonly index: Answer;
  readonly decision: string;
  readonly failure: Option.Option<string>;
}>)("a CI loop's success from a detached checkout $outcome", ({ index, decision, failure }) =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: "",
      origin: [PULL_REF],
      github: [[INDEX, [index]]],
    });
    assert.strictEqual(finished.decision._tag, decision);
    assert.deepStrictEqual(
      Option.map(finished.failure, ({ message }) => message),
      failure,
    );
    assert.notInclude(finished.commands, BRANCH_PULL_REQUESTS);
  }),
);

it.live.each([
  {
    origin: [branchAt(OTHER)],
    detail: `is at ${OTHER} on origin, not at the checkout's HEAD ${HEAD}`,
  },
  { origin: [PULL_REF], detail: "isn't on origin" },
])("a plain success fails when its branch $detail", ({ origin, detail }) =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: BRANCH,
      origin,
      github: [
        [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey([{ number: 815, html_url: URL_815 }])])]],
      ],
    });
    assert.strictEqual(finished.decision._tag, "RunFailed");
    assert(Option.isSome(finished.failure));
    assert.strictEqual(finished.failure.value._tag, "AgentFailure");
    assert.strictEqual(
      finished.failure.value.message,
      `CI can't wait on the pushed pull request: branch ${BRANCH} ${detail}`,
    );
  }),
);

it.live("an unpushed detached HEAD fails as an agent mistake without reading GitHub", () =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: "",
      origin: [branchAt(OTHER)],
      github: [[INDEX, [ghFailed]]],
    });
    assert.strictEqual(finished.decision._tag, "RunFailed");
    assert(Option.isSome(finished.failure));
    assert.strictEqual(finished.failure.value._tag, "AgentFailure");
    assert.strictEqual(
      finished.failure.value.message,
      `CI can't wait on the pushed pull request: no open pull request has the checkout's HEAD ${HEAD} as its head`,
    );
    assert.isFalse(finished.commands.some((command) => command.startsWith("gh ")));
  }),
);

it.live.each([
  {
    outcome: "waits despite a lagging commit index",
    open: [{ number: 815, html_url: URL_815 }],
    decision: "RunAwaitingCi",
  },
  {
    outcome: "fails when no candidate branch has an open pull request",
    open: [],
    decision: "RunFailed",
  },
])("a detached success $outcome", ({ open, decision }) =>
  Effect.gen(function* () {
    const finished = yield* finishHarvested("Finished the change.", {
      branch: "",
      origin: [`${HEAD}\trefs/heads/no-pr`, branchAt(HEAD), `${OTHER}\trefs/heads/old`],
      github: [
        [
          "gh api repos/basaltbytes/usine/pulls?head=basaltbytes:no-pr&state=open&per_page=100",
          [Effect.succeed([jsonKey([])])],
        ],
        [BRANCH_PULL_REQUESTS, [Effect.succeed([jsonKey(open)])]],
        [INDEX, [Effect.succeed([jsonKey([[]])])]],
      ],
    });
    assert.strictEqual(finished.decision._tag, decision);
    assert.notInclude(finished.commands, INDEX);
    if (decision === "RunAwaitingCi") {
      assert(finished.state._tag === "AwaitingCi");
      assert.strictEqual(finished.state.handoff.pullRequest, 815);
      assert.strictEqual(finished.state.handoff.head, HEAD);
    } else {
      assert(Option.isSome(finished.failure));
      assert.strictEqual(finished.failure.value._tag, "AgentFailure");
      assert.strictEqual(
        finished.failure.value.message,
        `CI can't wait on the pushed pull request: no open pull request has the checkout's HEAD ${HEAD} as its head`,
      );
    }
  }),
);
