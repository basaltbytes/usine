import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Settings, UsineConfig } from "@usine/config/factory";
import { githubSignature } from "@usine/core/agent";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { Attempt, AttemptNumber, AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { Event } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import { Run, RunId } from "@usine/core/run";
import { Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import {
  claudeLoginLockLayer,
  CheckoutRequest,
  CredentialProvider,
  CredentialUnavailableError,
  type CredentialUnavailableReason,
  Executor,
  ExecutorError,
  ExecutorOperationError,
} from "@usine/executor";
import { GitHubApp, InstallationDiscoveryError } from "@usine/github/github-app";
import { InstanceDirectory } from "@usine/core/instance";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { StepExecution, StepExecutor } from "@usine/engine/step-executor";
import { stepExecutorLayer } from "../../src/scheduler.ts";
import { TestClock } from "effect/testing";
import { RunEngine, Submission } from "@usine/engine/engine";
import { TranscriptAllQuery, TranscriptTailQuery } from "@usine/engine/transcript";
import {
  Cause,
  Exit,
  DateTime,
  Deferred,
  Fiber,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Redacted,
  References,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { type HarnessProbe, layer as localExecutorLayer } from "@usine/executor/local";
import { AttemptReport } from "@usine/durable/attempt-runtime";
import { layer as localLayer } from "../../src/local.ts";
import {
  completes,
  type StubParent,
  stubAttemptRuntime,
  StubStorage,
  worksFor,
} from "@usine/durable/testing";
import { fixedConfigLayer } from "../support/current-instance.ts";
import { testAppLayer } from "../support/github-app.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";
import { runView } from "../../src/operator/projection.ts";
import {
  aloneOnItem,
  LIVE_TEST_TIMEOUT,
  STATE_POLL_ATTEMPTS,
  TOKEN,
  config,
  credentialLayer,
  harnessReady,
  makeRemote,
  output,
  run,
  submission,
  testAgent,
  waitFor,
  waitForStarted,
  withLocalEngine,
  workerCredential,
} from "./support.ts";

const GITHUB_GH = fileURLToPath(new URL("../fixtures/github.mjs", import.meta.url));
const REVIEW_URL = "https://github.com/acme/demo/pull/71#pullrequestreview-81";

const harnessUnavailable: HarnessProbe = (brain) =>
  Effect.succeed(
    new HarnessUnavailableError({
      harness: brain.harness,
      capability: "login",
      message: "Worker login expired",
    }),
  );

/** Fails every mint for the Attempt's repository with `reason` and `message`. */
const failingCredentials = (reason: CredentialUnavailableReason, message: string) =>
  Layer.succeed(CredentialProvider)({
    issue: (repository) =>
      Effect.fail(
        new CredentialUnavailableError({ repository, reason, message, cause: new Error(message) }),
      ),
  });

/** Returns the tag and message of each Attempt's failure, in Attempt order. */
const attemptFailures = (attempts: ReadonlyArray<Attempt>) =>
  attempts.map((attempt) =>
    Option.match(attempt.outcome, {
      onNone: () => ["open"],
      onSome: (outcome) =>
        outcome._tag === "Failed"
          ? [outcome.failure._tag, "message" in outcome.failure ? outcome.failure.message : ""]
          : [outcome._tag],
    }),
  );

/** A parent that commits and pushes (unless it only updates its PR) and records the PR the fake `gh` reports. */
const pullRequestParent =
  (operation: "create" | "update"): StubParent =>
  ({ request }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      if (operation === "create") {
        yield* run(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Implement the issue",
          ],
          request.cwd,
        );
        yield* run(
          "git",
          ["push", "origin", "HEAD:refs/heads/usine/implement-the-issue"],
          request.cwd,
        );
      }
      const head = (yield* output("git", ["rev-parse", "HEAD"], request.cwd)).trim();
      yield* fileSystem.writeFileString(
        `${request.cwd}/.test-pull-request.json`,
        JSON.stringify({
          number: 71,
          html_url: "https://github.com/acme/demo/pull/71",
          head: { sha: head },
        }),
      );
      return `Completed: ${request.spec.task}`;
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/** A parent whose last turn answered the operator, after it posted the review on pull request 71 that the fake `gh` reports. */
const reviewedParent: StubParent = ({ request }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      `${request.cwd}/.test-review.json`,
      JSON.stringify({
        id: 81,
        html_url: REVIEW_URL,
        body: `No findings.\n\n${githubSignature(request.spec.agent.name)}`,
        user: { login: "usine-test[bot]" },
        state: "COMMENTED",
        submitted_at: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    return new AttemptReport({
      message: "Posted the review on pull request 71.",
      answeredOperator: true,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

/**
 * Runs `use` on the local composition, built as in `../../src/local.ts`, with `gh` answered by the
 * GitHub fixture.
 */
const withGitHubEngine = <A, E, R>(
  parent: StubParent,
  lookup: "answers" | "fails",
  use: (options: {
    readonly engine: RunEngine["Service"];
    readonly remote: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-pr-" });
    const instance = InstanceDirectory.make(root);
    const remote = yield* makeRemote(root);
    const github = ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand" && command.command === "gh"
        ? spawner.spawn(
            ChildProcess.make(
              process.execPath,
              [GITHUB_GH, ...command.args, ...(lookup === "fails" ? ["--lookup-fails"] : [])],
              command.options,
            ),
          )
        : spawner.spawn(command),
    );
    const executor = localExecutorLayer({
      instanceDirectory: instance,
      repositoryUrl: () => remote,
      harnessReadiness: harnessReady,
    }).pipe(
      Layer.provide(credentialLayer),
      Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
      Layer.provide(claudeLoginLockLayer),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, github)),
      Layer.provide(NodeServices.layer),
    );
    const engine = localEngineLayer(instance).pipe(
      Layer.provide(
        stepExecutorLayer(config, []).pipe(
          Layer.provide(executor),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(testAppLayer),
        ),
      ),
      Layer.provide(alwaysHoldsLayer),
    );
    return yield* Effect.gen(function* () {
      return yield* use({ engine: yield* RunEngine, remote });
    }).pipe(Effect.provide(engine));
  }).pipe(Effect.provide(NodeServices.layer));

describe("local worker", () => {
  it.live(
    "checks every supplied roster brain before starting the local scheduler",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const instance = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "usine-preflight-" }),
        );
        const runtime = localLayer(instance, config, [testAgent.brain], {
          harnessReadiness: harnessUnavailable,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(claudeLoginLockLayer),
          Layer.provide(alwaysHoldsLayer),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(testAppLayer),
        );
        const error = yield* Effect.void.pipe(Effect.provide(runtime), Effect.flip);
        assert.strictEqual(error._tag, "WorkerCapabilityError");
        assert(!(yield* fs.exists(`${instance}/.usine/workers`)));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "does not spend infrastructure retries or prepare a checkout on a harness gap",
    () =>
      withLocalEngine(
        { executor: { harnessReadiness: harnessUnavailable } },
        ({ engine, instance }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            assert.strictEqual(snapshot.attempts.length, 1);
            const attempt = snapshot.attempts[0];
            assert(attempt !== undefined && Option.isSome(attempt.outcome));
            const outcome = attempt.outcome.value;
            assert.strictEqual(outcome._tag, "Failed");
            if (outcome._tag === "Failed") assert.strictEqual(outcome.failure._tag, "AgentFailure");
            const fs = yield* FileSystem.FileSystem;
            assert(!(yield* fs.exists(`${instance}/.usine/workers`)));
          }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "fails once, without an automatic retry, when GitHub refuses the Attempt's token",
    () => {
      const refusal =
        'Could not create a worker token for "acme/demo": GitHub returned HTTP status 422: The permissions requested are not granted to this installation.';
      return withLocalEngine(
        { credentials: failingCredentials("refused", refusal) },
        ({ engine, instance }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert(accepted._tag === "Claimed");
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            assert.deepStrictEqual(attemptFailures(snapshot.attempts), [["AgentFailure", refusal]]);
            const fs = yield* FileSystem.FileSystem;
            assert(!(yield* fs.exists(`${instance}/.usine/workers/local/attempts`)));
          }),
      );
    },
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "retries as an infrastructure failure when GitHub cannot be reached for the token",
    () => {
      const outage =
        'Could not create a worker token for "acme/demo": Could not send the request to GitHub';
      return withLocalEngine(
        { credentials: failingCredentials("unreachable", outage) },
        ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert(accepted._tag === "Claimed");
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            assert.deepStrictEqual(attemptFailures(snapshot.attempts), [
              ["InfraFailure", outage],
              ["InfraFailure", outage],
              ["InfraFailure", outage],
            ]);
          }),
      );
    },
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "preserves successful agent work when PR discovery fails",
    () =>
      withGitHubEngine(pullRequestParent("create"), "fails", ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(1));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert.strictEqual(snapshot.attempts.length, 1);
          assert(Option.isSome(snapshot.step.result));
          assert.deepStrictEqual(
            snapshot.step.result.value.facts.map((fact) => fact._tag),
            ["Commit"],
          );
          assert.strictEqual(runView(snapshot, new Set(), new Map()).pullRequestUrl, null);
        }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live.each(["create", "update"] as const)(
    "persists a PR fact and operator link after an agent %s",
    (operation) =>
      withGitHubEngine(pullRequestParent(operation), "answers", ({ engine, remote }) =>
        Effect.gen(function* () {
          const initial = submission(1);
          const request =
            operation === "update"
              ? new Submission({
                  ...initial,
                  revision: RepositoryRevision.make(
                    (yield* output("git", ["--git-dir", remote, "rev-parse", "main"])).trim(),
                  ),
                })
              : initial;
          const accepted = yield* engine.submit(request);
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert.strictEqual(snapshot.attempts.length, 1);
          assert(Option.isSome(snapshot.step.result));
          const facts = snapshot.step.result.value.facts;
          assert.strictEqual(
            facts.filter((fact) => fact._tag === "Commit").length,
            operation === "create" ? 1 : 0,
          );
          assert.deepStrictEqual(
            facts.filter((fact) => fact._tag === "PullRequest").map((fact) => fact.number),
            [71],
          );
          assert.strictEqual(
            runView(snapshot, new Set(), new Map()).pullRequestUrl,
            "https://github.com/acme/demo/pull/71",
          );
        }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.effect(
    "keeps completed agent work successful when checkout cleanup passes the Attempt deadline",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-cleanup-budget-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const cleanupStarted = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        const delayedCleanup = ChildProcessSpawner.make(
          Effect.fn("test.delayCleanup")(function* (command) {
            if (
              command._tag === "StandardCommand" &&
              command.command === "git" &&
              command.args.includes("worktree") &&
              command.args.includes("remove")
            ) {
              yield* Deferred.succeed(cleanupStarted, undefined);
              yield* Deferred.await(finishCleanup);
            }
            return yield* spawner.spawn(command);
          }),
        );
        const credential = Redacted.make(TOKEN);
        const executor = localExecutorLayer({
          instanceDirectory: instance,
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(
            Layer.succeed(CredentialProvider)({
              issue: () => Effect.succeed(workerCredential(credential)),
            }),
          ),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(claudeLoginLockLayer),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, delayedCleanup)),
        );
        const budgetConfig = new UsineConfig({
          ...config,
          settings: new Settings({ ...config.settings, maxAttemptMinutes: Option.some(1) }),
        });
        const runtime = stepExecutorLayer(budgetConfig, []).pipe(
          Layer.provide(executor),
          Layer.provide(fixedConfigLayer(budgetConfig)),
          Layer.provide(testAppLayer),
        );
        yield* Effect.gen(function* () {
          const scheduler = yield* StepExecutor;
          const selected = submission(7);
          const runId = RunId.make("cleanup-budget-run");
          const execution = new StepExecution({
            attempt: new Attempt({
              task: selected.task,
              agent: selected.agent.name,
              operatorIntervened: false,
              id: AttemptId.make("cleanup-budget-run/execute/1"),
              runId,
              stepName: selected.step,
              worker: WorkerName.make("local"),
              number: AttemptNumber.make(1),
              brain: testAgent.brain,
              parentModel: Option.none(),
              startedAt: selected.event.receivedAt,
              outcome: Option.none(),
              endedAt: Option.none(),
              salvage: Option.none(),
            }),
            event: selected.event,
            run: new Run({
              id: runId,
              eventId: selected.event.id,
              loop: selected.loop,
              state: RunState.start(new RunState.Pending()),
              openedAt: selected.event.receivedAt,
            }),
            step: new Step({ runId, name: selected.step, result: Option.none() }),
            repository: selected.repository,
            revision: selected.revision,
            task: selected.task,
            agent: selected.agent,
            parentModel: selected.parentModel,
            permissions: selected.permissions,
            resume: Option.none(),
          });
          const running = yield* scheduler
            .execute(execution, {
              append: () => Effect.void,
              salvage: () => Effect.void,
              comments: () => Effect.void,
              transcript: Effect.succeed([]),
              windows: aloneOnItem(AttemptId.make("cleanup-budget-run/execute/1")),
              checkoutAcquired: Effect.void,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(cleanupStarted);
          // Agent work is complete; only resource release crosses the one-minute budget.
          yield* TestClock.adjust("2 minutes");
          yield* Deferred.succeed(finishCleanup, undefined);
          const result = yield* Fiber.join(running);
          assert.strictEqual(result.message, "Completed: Complete local task 7");
          assert.throws(() => Redacted.value(credential));
          assert.deepStrictEqual(
            yield* fileSystem.readDirectory(`${root}/.usine/workers/local/attempts`),
            [],
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "cancels local preparation and redacts Git diagnostics before releasing tokens",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-prepare-" });
        const remote = yield* makeRemote(root);
        const staging = `${root}/.usine/workers/local/repos/acme_demo.git.cloning`;
        for (const phase of ["preflight", "credential", "clone", "fetch", "diagnostic"] as const) {
          const started = yield* Deferred.make<void>();
          const credential = Redacted.make(TOKEN);
          const controlledSpawner = ChildProcessSpawner.make(
            Effect.fn("test.controlGit")(function* (command) {
              if (
                command._tag === "StandardCommand" &&
                command.command === "git" &&
                command.args.includes(phase === "diagnostic" ? "fetch" : phase)
              ) {
                if (phase === "clone")
                  yield* fileSystem.makeDirectory(staging, { recursive: true });
                const handle = yield* spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [
                      "-e",
                      phase === "diagnostic"
                        ? 'process.stderr.write(require("node:fs").readFileSync(process.env.USINE_GITHUB_TOKEN_FILE)); process.exit(1)'
                        : "setInterval(() => {}, 1000)",
                    ],
                    command.options,
                  ),
                );
                yield* Deferred.succeed(started, undefined);
                return handle;
              }
              return yield* spawner.spawn(command);
            }),
          );
          const runtime = localExecutorLayer({
            instanceDirectory: InstanceDirectory.make(root),
            repositoryUrl: () => remote,
            harnessReadiness: (brain) =>
              phase === "preflight"
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : harnessReady(brain),
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CredentialProvider)({
                  issue: () =>
                    phase === "credential"
                      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.succeed(workerCredential(credential)),
                }),
                stubAttemptRuntime(new StubStorage()),
                claudeLoginLockLayer,
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, controlledSpawner),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const executor = yield* Executor;
            const preparing = executor.prepare(
              new CheckoutRequest({
                attemptId: AttemptId.make(`prepare-${phase}/run/1`),
                worker: WorkerName.make("local"),
                repository: RepositoryName.make("acme/demo"),
                loop: LoopName.make("local-worker"),
                permissions: "write",
                revision: RepositoryRevision.make("main"),
                payload: {},
                task: AttemptTask.make("Exercise interrupted preparation"),
                agent: testAgent,
                parentModel: Option.none(),
                maxChildren: ChildSessionBudget.make(4),
                maxAttemptMinutes: Option.none(),
                maxAttemptTokens: Option.none(),
                parentEffort: "high",
                salvageRef: SalvageRef.make(`usine/salvage/prepare-${phase}/1`),
                resume: Option.none(),
              }),
            );
            if (phase === "diagnostic") {
              const error = yield* preparing.pipe(Effect.flip);
              const encoded = Schema.encodeSync(Schema.fromJsonString(ExecutorError))(error);
              assert(!encoded.includes(TOKEN));
              assert(encoded.includes("[REDACTED]"));
            } else {
              const fiber = yield* preparing.pipe(Effect.forkChild);
              yield* Deferred.await(started);
              yield* executor.cancel(AttemptId.make(`prepare-${phase}/run/1`));
              const exit = yield* Fiber.await(fiber);
              assert(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
            }
            if (phase === "preflight" || phase === "credential") {
              assert(!(yield* fileSystem.exists(`${root}/.usine/workers/local/attempts`)));
              return;
            }
            assert.throws(() => Redacted.value(credential));
            assert(!(yield* fileSystem.exists(staging)));
            assert.deepStrictEqual(
              yield* fileSystem.readDirectory(`${root}/.usine/workers/local/attempts`),
              [],
            );
          }).pipe(Effect.provide(runtime));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "prepares an exact PR-only commit and releases checkout credentials after success or failure",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-resource-" });
        const remote = yield* makeRemote(root);
        const seed = `${root}/seed`;
        yield* run("git", ["commit", "--allow-empty", "-m", "PR-only change"], seed);
        const prHead = (yield* output("git", ["rev-parse", "HEAD"], seed)).trim();
        yield* run("git", ["push", "origin", "HEAD:refs/pull/63/head"], seed);
        const issued: Array<Redacted.Redacted<string>> = [];
        const credentials = Layer.succeed(CredentialProvider)({
          issue: () =>
            Effect.sync(() => {
              const token = Redacted.make(TOKEN);
              issued.push(token);
              return workerCredential(token);
            }),
        });
        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentials),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(claudeLoginLockLayer),
        );
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const request = new CheckoutRequest({
            attemptId: AttemptId.make("unlaunched/run/1"),
            worker: WorkerName.make("local"),
            repository: RepositoryName.make("acme/demo"),
            loop: LoopName.make("local-worker"),
            permissions: "write",
            revision: RepositoryRevision.make(prHead),
            payload: {},
            task: AttemptTask.make("Prepare without launching"),
            agent: testAgent,
            parentModel: Option.none(),
            maxChildren: ChildSessionBudget.make(4),
            maxAttemptMinutes: Option.none(),
            maxAttemptTokens: Option.none(),
            parentEffort: "high",
            salvageRef: SalvageRef.make("usine/salvage/unlaunched/1"),
            resume: Option.none(),
          });
          const prepared = yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(request);
              assert.strictEqual(prepared.workspace.spec.baseCommit, prHead);
              assert.strictEqual(
                (yield* output("git", ["rev-parse", "HEAD"], prepared.workspace.worktree)).trim(),
                prHead,
              );
              return prepared;
            }),
          );
          assert(!(yield* fileSystem.exists(prepared.workspace.worktree)));
          const registration = yield* output("git", [
            "--git-dir",
            `${root}/.usine/workers/local/repos/acme_demo.git`,
            "worktree",
            "list",
            "--porcelain",
          ]);
          assert(!registration.includes(prepared.workspace.worktree));
          const error = yield* executor
            .prepare(
              new CheckoutRequest({
                ...request,
                attemptId: AttemptId.make("unlaunched/run/2"),
                revision: RepositoryRevision.make("missing-revision"),
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "ExecutorOperationError");
          // The surrounding scope is still open: failure must release immediately.
          assert.strictEqual(issued.length, 2);
          for (const token of issued) assert.throws(() => Redacted.value(token));
          const reused = yield* prepared
            .launch({
              append: () => Effect.void,
              salvage: () => Effect.void,
              comments: () => Effect.void,
              transcript: Effect.succeed([]),
              windows: aloneOnItem(AttemptId.make("unlaunched/run/2")),
            })
            .pipe(Effect.flip);
          assert.strictEqual(reused._tag, "InfraFailure");
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "prunes bare caches while ignoring stray files and directories under repos/",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-sweep-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const workerRoot = path.join(instance, ".usine", "workers", "local");
        const reposRoot = path.join(workerRoot, "repos");
        const cache = path.join(reposRoot, "acme_demo.git");
        const abandoned = path.join(workerRoot, "attempts", "abandoned");
        const turbo = path.join(reposRoot, ".turbo");
        const turboMarker = path.join(turbo, "marker");
        // A plain file must not abort the sweep: probing `<entry>/HEAD` on it
        // fails with ENOTDIR before any cache gets pruned.
        const strayFile = path.join(reposRoot, ".DS_Store");
        yield* fileSystem.makeDirectory(reposRoot, { recursive: true });
        yield* run("git", ["clone", "--bare", remote, cache]);
        const commit = (yield* output("git", [
          "--git-dir",
          cache,
          "rev-parse",
          "refs/heads/main",
        ])).trim();
        yield* run("git", ["--git-dir", cache, "worktree", "add", "--detach", abandoned, commit]);
        yield* fileSystem.remove(abandoned, { recursive: true, force: true });
        yield* fileSystem.makeDirectory(turbo, { recursive: true });
        yield* fileSystem.writeFileString(turboMarker, "keep");
        yield* fileSystem.writeFileString(strayFile, "keep");
        const registrationsBefore = yield* output("git", [
          "--git-dir",
          cache,
          "worktree",
          "list",
          "--porcelain",
        ]);
        assert(registrationsBefore.includes(abandoned));

        const logs: Array<{ readonly level: string; readonly message: string }> = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          logs.push({
            level: logLevel,
            message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
          });
        });
        const runtime = localLayer(instance, config, [], {
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(claudeLoginLockLayer),
          Layer.provide(alwaysHoldsLayer),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(testAppLayer),
        );
        yield* Effect.gen(function* () {
          yield* RunEngine;
        }).pipe(
          Effect.provide(runtime),
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        );

        const registrationsAfter = yield* output("git", [
          "--git-dir",
          cache,
          "worktree",
          "list",
          "--porcelain",
        ]);
        assert(!registrationsAfter.includes(abandoned));
        assert(yield* fileSystem.exists(turboMarker));
        assert(yield* fileSystem.exists(strayFile));
        const skipped = logs.filter(({ message }) =>
          message.includes("Skipping a non-cache entry during the local cache sweep"),
        );
        assert.deepStrictEqual(
          skipped.map(({ level }) => level),
          ["Debug", "Debug"],
        );
        // A startup with stray entries logs no cleanup warning at all, whatever
        // the message says.
        const alarming = logs.filter(({ level }) => ["Warn", "Error", "Fatal"].includes(level));
        assert.deepStrictEqual(alarming, []);
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "gives the parent task only the allowlisted environment, the Attempt credential, and a Worker-scoped Turbo cache",
    () =>
      Effect.gen(function* () {
        const environments: Array<Record<string, string>> = [];
        yield* withLocalEngine(
          {
            attemptRuntime: stubAttemptRuntime(new StubStorage(), (context) =>
              Effect.sync(() => environments.push(context.request.environment)).pipe(
                Effect.andThen(completes(context)),
              ),
            ),
          },
          ({ engine, instance }) =>
            Effect.gen(function* () {
              const accepted = yield* engine.submit(submission(7));
              assert(accepted._tag === "Claimed");
              yield* waitFor(engine, accepted.runId, "Succeeded");
              const path = yield* Path.Path;
              const [environment] = environments;
              assert(environment !== undefined && environments.length === 1);
              // Nothing from the orchestrator's environment beyond the allowlist, which excludes
              // the App private key (ADR 0011).
              const allowed = new Set([
                "HOME",
                "LANG",
                "LC_ALL",
                "PATH",
                "SHELL",
                "TMPDIR",
                "USER",
                "GH_CONFIG_DIR",
                "GH_PROMPT_DISABLED",
                "USINE_GITHUB_TOKEN_FILE",
                "GIT_CONFIG_COUNT",
                "GIT_CONFIG_KEY_0",
                "GIT_CONFIG_VALUE_0",
                "GIT_CONFIG_KEY_1",
                "GIT_CONFIG_VALUE_1",
                "TURBO_CACHE_DIR",
              ]);
              assert.deepStrictEqual(
                Object.keys(environment).filter((name) => !allowed.has(name)),
                [],
              );
              assert.strictEqual(
                environment.TURBO_CACHE_DIR,
                path.join(instance, ".usine", "workers", "local", "turbo"),
              );
              assert(!JSON.stringify(environment).includes(TOKEN));
            }),
        );
      }),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "fails the Run when the parent ended on its answer to the operator and delivered nothing",
    () =>
      withLocalEngine(
        {
          attemptRuntime: stubAttemptRuntime(new StubStorage(), () =>
            Effect.succeed(
              new AttemptReport({
                message: "The delegated attempt returned no technical failure details.",
                answeredOperator: true,
              }),
            ),
          ),
        },
        ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(8));
            assert(accepted._tag === "Claimed");
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            const outcome = snapshot.attempts[0]?.outcome;
            assert(outcome !== undefined && Option.isSome(outcome));
            assert(outcome.value._tag === "Failed");
            assert.strictEqual(outcome.value.failure._tag, "AgentFailure");
            assert.include(
              outcome.value.failure._tag === "AgentFailure" ? outcome.value.failure.message : "",
              "The delegated attempt returned no technical failure details.",
            );
          }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.effect(
    "gives an exe.dev Attempt exe.dev's integration bot, and an Attempt no bot login when the App cannot be read, and acquires no checkout when preparation fails",
    () =>
      Effect.gen(function* () {
        const unreadableApp = Layer.succeed(GitHubApp)({
          installation: () =>
            Effect.fail(
              new InstallationDiscoveryError({
                reason: "missing",
                message:
                  "The GitHub App is not installed on any account. Install it on the account that owns the repositories.",
              }),
            ),
          installationToken: () => Effect.die("unused"),
          projectAccess: () => Effect.die("unused"),
          workerToken: () => Effect.die("unused"),
        });
        const cases = [
          ["exe.dev", testAppLayer, "exe-dev-github-integration[bot]"],
          ["local", unreadableApp, null],
        ] as const;
        for (const [kind, app, expected] of cases) {
          const requested: Array<CheckoutRequest> = [];
          const acquired: Array<AttemptId> = [];
          const executor = Layer.succeed(Executor)({
            kind,
            recover: () => Effect.die("unused"),
            isLive: () => Effect.die("unused"),
            outcome: () => Effect.die("unused"),
            preflight: () => Effect.void,
            prepare: (request) => {
              requested.push(request);
              return Effect.fail(
                new ExecutorOperationError({
                  operation: "prepare",
                  message: "The test stops after the request",
                  cause: new Error("stop"),
                }),
              );
            },
            cancel: () => Effect.die("unused"),
            intervene: () => Effect.die("unused"),
          });
          const single = Schema.decodeUnknownSync(UsineConfig)({
            version: 1,
            repos: [{ name: "acme/demo" }],
            workers: [{ name: "worker", kind, max_concurrent_attempts: 1 }],
          });
          yield* Effect.gen(function* () {
            const selected = submission(9);
            const runId = RunId.make(`bot-login-${kind}`);
            yield* (yield* StepExecutor)
              .execute(
                new StepExecution({
                  attempt: new Attempt({
                    task: selected.task,
                    agent: selected.agent.name,
                    operatorIntervened: false,
                    id: AttemptId.make(`bot-login-${kind}/execute/1`),
                    runId,
                    stepName: selected.step,
                    worker: WorkerName.make("worker"),
                    number: AttemptNumber.make(1),
                    brain: testAgent.brain,
                    parentModel: Option.none(),
                    startedAt: selected.event.receivedAt,
                    outcome: Option.none(),
                    endedAt: Option.none(),
                    salvage: Option.none(),
                  }),
                  event: selected.event,
                  run: new Run({
                    id: runId,
                    eventId: selected.event.id,
                    loop: selected.loop,
                    state: RunState.start(new RunState.Pending()),
                    openedAt: selected.event.receivedAt,
                  }),
                  step: new Step({ runId, name: selected.step, result: Option.none() }),
                  repository: selected.repository,
                  revision: selected.revision,
                  task: selected.task,
                  agent: selected.agent,
                  parentModel: selected.parentModel,
                  permissions: selected.permissions,
                  resume: Option.none(),
                }),
                {
                  append: () => Effect.void,
                  salvage: () => Effect.void,
                  comments: () => Effect.void,
                  transcript: Effect.succeed([]),
                  windows: aloneOnItem(AttemptId.make(`bot-login-${kind}/execute/1`)),
                  checkoutAcquired: Effect.sync(() => {
                    acquired.push(AttemptId.make(`bot-login-${kind}/execute/1`));
                  }),
                },
              )
              .pipe(Effect.flip);
          }).pipe(
            Effect.provide(
              stepExecutorLayer(single, []).pipe(
                Layer.provide(executor),
                Layer.provide(fixedConfigLayer(single)),
                Layer.provide(app),
              ),
            ),
          );
          assert.deepStrictEqual(
            requested.map(({ botLogin }) =>
              Option.getOrNull(Option.map(botLogin, (login): string => login)),
            ),
            [expected],
          );
          // The engine reconciles a checkout kept for a reattachment until preparation acquires it
          // (#180).
          assert.deepStrictEqual(acquired, []);
        }
      }),
  );

  it.live(
    "succeeds the Run when the parent ended on its answer to the operator after posting a review as the App's bot",
    () =>
      withGitHubEngine(reviewedParent, "answers", ({ engine }) =>
        Effect.gen(function* () {
          const initial = submission(1);
          const accepted = yield* engine.submit(
            new Submission({
              ...initial,
              event: new Event({
                ...initial.event,
                payload: { number: 71, url: "https://github.com/acme/demo/pull/71" },
              }),
            }),
          );
          assert(accepted._tag === "Claimed");
          const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
          assert(Option.isSome(snapshot.step.result));
          assert.deepStrictEqual(
            snapshot.step.result.value.facts.map((fact) =>
              fact._tag === "Comment" ? [fact.kind, fact.url.href] : [fact._tag],
            ),
            [["review", REVIEW_URL]],
          );
        }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "runs Event → Attempt, persists the transcript, and removes the worktree",
    () =>
      withLocalEngine({}, ({ engine, instance }) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          assert(
            !(yield* fileSystem.exists(path.join(instance, ".usine", "workers"))),
            "preflight must not create worker state",
          );
          const accepted = yield* engine.submit(submission(1));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
          const attempt = snapshot.attempts[0];
          assert(attempt !== undefined);
          assert.strictEqual(attempt.worker, "local");
          assert(Option.isSome(snapshot.step.result));
          assert.strictEqual(
            snapshot.step.result.value.message,
            "Completed: Complete local task 1",
          );

          const transcript = yield* engine.transcript(
            new TranscriptAllQuery({ attemptId: attempt.id }),
          );
          assert.deepStrictEqual(
            transcript.map(({ direction, envelope }) => [
              direction,
              envelope.sequence,
              envelope.payload._tag,
            ]),
            [
              ["outbound", 1, "Started"],
              ["outbound", 2, "SessionEvent"],
              ["outbound", 3, "SessionEvent"],
              ["outbound", 4, "SessionEvent"],
              ["outbound", 5, "Final"],
            ],
          );
          const firstTranscriptEntry = transcript[0];
          assert(firstTranscriptEntry !== undefined);
          const tail = yield* engine.transcript(
            new TranscriptTailQuery({
              attemptId: attempt.id,
              after: firstTranscriptEntry.sequence,
              limit: 100,
            }),
          );
          assert.deepStrictEqual(
            tail.map(({ envelope }) => envelope.payload._tag),
            ["SessionEvent", "SessionEvent", "SessionEvent", "Final"],
          );

          const attempts = yield* fileSystem.readDirectory(
            path.join(instance, ".usine", "workers", "local", "attempts"),
          );
          assert.deepStrictEqual(attempts, []);
          const cache = path.join(instance, ".usine", "workers", "local", "repos", "acme_demo.git");
          const storedConfig = yield* output("git", ["--git-dir", cache, "config", "--list"]);
          assert(!storedConfig.includes(TOKEN));
        }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "cancel during credential minting skips launch and releases capacity for the next Run",
    () =>
      Effect.gen(function* () {
        const minting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let first = true;
        const credentials = Layer.succeed(CredentialProvider)({
          issue: () =>
            Effect.gen(function* () {
              if (first) {
                first = false;
                yield* Deferred.succeed(minting, undefined);
                yield* Deferred.await(release);
              }
              return workerCredential(Redacted.make(TOKEN));
            }),
        });
        yield* withLocalEngine({ credentials }, ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert(accepted._tag === "Claimed");
            yield* Deferred.await(minting);
            yield* engine.cancel(accepted.runId);
            yield* Deferred.succeed(release, undefined);
            const canceled = yield* waitFor(engine, accepted.runId, "Canceled");
            const attempt = canceled.attempts[0];
            assert(attempt !== undefined);
            assert(Option.isSome(attempt.outcome) && attempt.outcome.value._tag === "Canceled");
            const next = yield* engine.submit(submission(2));
            assert(next._tag === "Claimed");
            yield* waitFor(engine, next.runId, "Succeeded");
            assert.deepStrictEqual(
              yield* engine.transcript(new TranscriptAllQuery({ attemptId: attempt.id })),
              [],
            );
          }),
        );
      }),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "delivers a steer to the parent task, then cancels it idempotently before cleanup",
    () => {
      const storage = new StubStorage();
      return withLocalEngine(
        { attemptRuntime: stubAttemptRuntime(storage, worksFor(5_000)) },
        ({ engine, instance }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(2));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const running = yield* waitFor(engine, accepted.runId, "Running");
            const attempt = running.attempts[0];
            assert(attempt !== undefined);
            yield* waitForStarted(engine, attempt.id);
            yield* engine.intervene(
              accepted.runId,
              attempt.id,
              new AttemptChannel.Intervention({
                operator: "Philippe",
                target: new AttemptChannel.ParentTarget(),
                action: new AttemptChannel.Steer({ message: "Use pnpm" }),
              }),
            );
            yield* engine.cancel(accepted.runId);
            yield* engine.cancel(accepted.runId);
            const canceled = yield* waitFor(engine, accepted.runId, "Canceled");
            assert.strictEqual(canceled.attempts.length, 1);
            assert.strictEqual(canceled.attempts[0]?.operatorIntervened, true);
            assert.strictEqual(storage.tasks.get(attempt.id)?.state._tag, "canceled");

            const transcript = yield* engine.transcript(
              new TranscriptAllQuery({ attemptId: attempt.id }),
            );
            assert(
              transcript.some(
                ({ direction, envelope }) =>
                  direction === "inbound" && envelope.payload._tag === "Steer",
              ),
            );
            const path = yield* Path.Path;
            const fileSystem = yield* FileSystem.FileSystem;
            const attemptsDirectory = path.join(instance, ".usine", "workers", "local", "attempts");
            let attempts = yield* fileSystem.readDirectory(attemptsDirectory);
            for (let poll = 0; attempts.length > 0 && poll < STATE_POLL_ATTEMPTS; poll += 1) {
              yield* Effect.sleep("10 millis");
              attempts = yield* fileSystem.readDirectory(attemptsDirectory);
            }
            assert.deepStrictEqual(attempts, []);
          }),
      );
    },
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "keeps excess Runs pending and assigns the oldest pending Event first",
    () =>
      withLocalEngine(
        { attemptRuntime: stubAttemptRuntime(new StubStorage(), worksFor(300)) },
        ({ engine }) =>
          Effect.gen(function* () {
            const first = yield* engine.submit(submission(3, "2026-08-30T12:00:03Z"));
            assert.strictEqual(first._tag, "Claimed");
            if (first._tag !== "Claimed") return;
            yield* waitFor(engine, first.runId, "Running");

            const newer = yield* engine.submit(submission(4, "2026-08-30T12:00:05Z"));
            const older = yield* engine.submit(submission(5, "2026-08-30T12:00:04Z"));
            assert.strictEqual(newer._tag, "Claimed");
            assert.strictEqual(older._tag, "Claimed");
            if (newer._tag !== "Claimed" || older._tag !== "Claimed") return;
            assert.strictEqual((yield* engine.inspect(newer.runId)).run.state._tag, "Pending");
            assert.strictEqual((yield* engine.inspect(older.runId)).run.state._tag, "Pending");

            yield* waitFor(engine, first.runId, "Succeeded");
            const olderFinished = yield* waitFor(engine, older.runId, "Succeeded");
            const newerFinished = yield* waitFor(engine, newer.runId, "Succeeded");
            const olderStarted = olderFinished.attempts[0]?.startedAt;
            const newerStarted = newerFinished.attempts[0]?.startedAt;
            assert(olderStarted !== undefined && newerStarted !== undefined);
            assert(DateTime.toEpochMillis(olderStarted) <= DateTime.toEpochMillis(newerStarted));
          }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "retries a parent task's infrastructure failure and removes every worktree",
    () =>
      withLocalEngine(
        {
          attemptRuntime: stubAttemptRuntime(new StubStorage(), () =>
            Effect.fail(
              new InfraFailure({ message: "model provider unreachable", cause: "outage" }),
            ),
          ),
        },
        ({ engine, instance }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(6));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const failed = yield* waitFor(engine, accepted.runId, "Failed");
            assert.strictEqual(failed.attempts.length, 3);
            for (const attempt of failed.attempts) {
              assert(Option.isSome(attempt.outcome));
              assert.strictEqual(attempt.outcome.value._tag, "Failed");
              if (attempt.outcome.value._tag === "Failed") {
                assert.strictEqual(attempt.outcome.value.failure._tag, "InfraFailure");
              }
            }
            const path = yield* Path.Path;
            const attempts = yield* (yield* FileSystem.FileSystem).readDirectory(
              path.join(instance, ".usine", "workers", "local", "attempts"),
            );
            assert.deepStrictEqual(attempts, []);
          }),
      ),
    LIVE_TEST_TIMEOUT,
  );
});
