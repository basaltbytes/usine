import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Settings, UsineConfig } from "@usine/config/factory";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { Attempt, AttemptNumber, AttemptTask, AttemptId } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import * as RunState from "@usine/core/run/state";
import { Run, RunId } from "@usine/core/run";
import { Step, StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { CheckoutRequest, CredentialProvider, Executor, ExecutorError } from "@usine/executor";
import { InstanceDirectory } from "@usine/core/instance";
import { StepExecution, StepExecutor } from "@usine/engine/step-executor";
import { stepExecutorLayer } from "../src/scheduler.ts";
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
import { layer as localExecutorLayer } from "@usine/executor/local";
import { layer as localLayer } from "../src/local.ts";
import { runView } from "../src/operator/projection.ts";

const RUN_HOST = fileURLToPath(new URL("../../run-host/dist/bin.js", import.meta.url));
const CHANNEL_LOSS_HOST = fileURLToPath(new URL("./fixtures/channel-loss.mjs", import.meta.url));
const TURBO_CACHE_HOST = fileURLToPath(new URL("./fixtures/turbo-cache.mjs", import.meta.url));
const STDOUT_NOISE_HOST = fileURLToPath(new URL("./fixtures/stdout-noise.mjs", import.meta.url));
const PULL_REQUEST_HOST = fileURLToPath(new URL("./fixtures/pull-request.mjs", import.meta.url));
const TOKEN = "one-attempt-test-token";
// Each live transition crosses real git worktree and child-process boundaries.
// The 10-second poll horizon absorbs slow CI hosts, and the 10 ms cadence still
// reports the last durable state when a transition stalls.
const STATE_POLL_ATTEMPTS = 1_000;
// The capacity test completes three sequential run-host lifecycles, so its
// per-test ceiling must cover more than one state-poll horizon plus cleanup.
const LIVE_TEST_TIMEOUT = 30_000;
const testAgent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "acme/demo" }],
  workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
});

const credentialLayer = Layer.succeed(CredentialProvider)({
  issue: () => Effect.succeed(Redacted.make(TOKEN)),
});

const run = Effect.fn("test.git")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make(command, args, { cwd }));
  if (Number(exitCode) !== 0) {
    return yield* Effect.die(`${command} ${args.join(" ")} exited with ${String(exitCode)}`);
  }
});

const output = Effect.fn("test.gitOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args, { cwd }), {
    includeStderr: true,
  });
});

const makeRemote = Effect.fn("test.makeRemote")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remote = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  yield* fileSystem.makeDirectory(seed, { recursive: true });
  yield* run("git", ["init", "--bare", remote]);
  yield* run("git", ["init"], seed);
  yield* run("git", ["config", "user.name", "Usine Test"], seed);
  yield* run("git", ["config", "user.email", "usine@example.invalid"], seed);
  yield* fileSystem.writeFileString(path.join(seed, "README.md"), "# fixture\n");
  yield* run("git", ["add", "README.md"], seed);
  yield* run("git", ["commit", "-m", "fixture"], seed);
  yield* run("git", ["branch", "-M", "main"], seed);
  yield* run("git", ["remote", "add", "origin", remote], seed);
  yield* run("git", ["push", "origin", "main"], seed);
  return remote;
});

const submission = (number: number, receivedAt = `2026-08-30T12:00:0${number}Z`) =>
  new Submission({
    event: new Event({
      id: EventId.make(`local-event-${number}`),
      dedupKey: DedupKey.make(`local/item-${number}/main`),
      payload: { number },
      receivedAt: DateTime.makeUnsafe(receivedAt),
    }),
    itemKey: ItemKey.make(`item-${number}`),
    loop: LoopName.make("local-worker"),
    step: StepName.make("execute"),
    approval: "none",
    repository: RepositoryName.make("acme/demo"),
    revision: RepositoryRevision.make("main"),
    task: AttemptTask.make(`Complete local task ${number}`),
    agent: testAgent,
    parentModel: Option.none(),
  });

const waitFor = Effect.fn("test.waitFor")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
  state: "Running" | "Succeeded" | "Failed" | "Canceled",
) {
  let snapshot = yield* engine.inspect(runId);
  for (let poll = 0; poll < STATE_POLL_ATTEMPTS; poll += 1) {
    if (snapshot.run.state._tag === state) return snapshot;
    if (state === "Succeeded" && snapshot.run.state._tag === "Failed") {
      return yield* Effect.die(JSON.stringify(snapshot.attempts.map((attempt) => attempt.outcome)));
    }
    yield* Effect.sleep("10 millis");
    snapshot = yield* engine.inspect(runId);
  }
  return yield* Effect.die(
    `Run ${runId} did not become ${state}; state=${snapshot.run.state._tag}; attempts=${snapshot.attempts.map((attempt) => Option.match(attempt.outcome, { onNone: () => "open", onSome: (outcome) => outcome._tag })).join(",")}`,
  );
});

const withLocalEngine = <A, E, R>(
  runHostArgs: ReadonlyArray<string>,
  use: (options: {
    readonly engine: RunEngine["Service"];
    readonly instance: InstanceDirectory;
    readonly remote: string;
  }) => Effect.Effect<A, E, R>,
  runHost?: string,
  credentials = credentialLayer,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-worker-" });
    const instance = InstanceDirectory.make(root);
    const remote = yield* makeRemote(root);
    const runHostOption =
      runHost === undefined && runHostArgs.length === 0
        ? {}
        : {
            runHost: {
              command: process.execPath,
              args: [runHost ?? RUN_HOST, ...runHostArgs],
            },
          };
    const runtime = localLayer(instance, config, [], {
      repositoryUrl: () => remote,
      ...runHostOption,
      interruptGrace: "100 millis",
    }).pipe(Layer.provide(credentials));
    return yield* Effect.gen(function* () {
      const engine = yield* RunEngine;
      return yield* use({ engine, instance, remote });
    }).pipe(Effect.provide(runtime));
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
          runHost: {
            command: process.execPath,
            args: [fileURLToPath(new URL("./fixtures/harness-unavailable.mjs", import.meta.url))],
          },
        }).pipe(Layer.provide(credentialLayer));
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
        [],
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
        fileURLToPath(new URL("./fixtures/harness-unavailable.mjs", import.meta.url)),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "preserves successful agent work when PR discovery fails",
    () =>
      withLocalEngine(
        ["--lookup-fails"],
        ({ engine }) =>
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
            assert.strictEqual(runView(snapshot, new Set()).pullRequestUrl, null);
          }),
        PULL_REQUEST_HOST,
      ),
    LIVE_TEST_TIMEOUT,
  );
  it.live.each(["create", "update"])(
    "persists a PR fact and operator link after an agent %s",
    (operation) =>
      withLocalEngine(
        operation === "update" ? ["--update-pr"] : [],
        ({ engine, remote }) =>
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
              runView(snapshot, new Set()).pullRequestUrl,
              "https://github.com/acme/demo/pull/71",
            );
          }),
        PULL_REQUEST_HOST,
      ),
    LIVE_TEST_TIMEOUT,
  );
  it.live(
    "completes one Attempt despite stray Effect and console logs",
    () =>
      withLocalEngine(
        ["--stub"],
        ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
            assert.strictEqual(snapshot.attempts.length, 1);
            const attempt = snapshot.attempts[0] ?? assert.fail("missing Attempt");
            const transcript = yield* engine.transcript(
              new TranscriptAllQuery({ attemptId: attempt.id }),
            );
            assert.strictEqual(transcript.at(-1)?.envelope.payload._tag, "Final");
            assert(!JSON.stringify(transcript).includes("library diagnostic"));
          }),
        STDOUT_NOISE_HOST,
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "still fails schema-invalid protocol frames",
    () =>
      withLocalEngine(
        ["--stub", "--malformed-frame"],
        ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            const outcome = Option.getOrUndefined(snapshot.attempts[0]?.outcome ?? Option.none());
            assert.strictEqual(outcome?._tag, "Failed");
            if (outcome?._tag !== "Failed") return;
            assert.match(outcome.failure.message, /schema-invalid frame/u);
          }),
        STDOUT_NOISE_HOST,
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
          runHost: { command: process.execPath, args: [RUN_HOST, "--stub"] },
        }).pipe(
          Layer.provide(
            Layer.succeed(CredentialProvider)({ issue: () => Effect.succeed(credential) }),
          ),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, delayedCleanup)),
        );
        const budgetConfig = new UsineConfig({
          ...config,
          settings: new Settings({ ...config.settings, maxAttemptMinutes: 1 }),
        });
        const runtime = stepExecutorLayer(budgetConfig, []).pipe(Layer.provide(executor));
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
          });
          const running = yield* scheduler
            .execute(execution, { append: () => Effect.void })
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
                phase === "preflight" &&
                command._tag === "StandardCommand" &&
                command.args.includes("--preflight")
              ) {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }
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
                        ? "process.stderr.write(process.env.GITHUB_TOKEN); process.exit(1)"
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
            runHost: { command: process.execPath, args: [RUN_HOST, "--stub"] },
          }).pipe(
            Layer.provide(
              Layer.merge(
                Layer.succeed(CredentialProvider)({
                  issue: () =>
                    phase === "credential"
                      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.succeed(credential),
                }),
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
                revision: RepositoryRevision.make("main"),
                payload: {},
                task: AttemptTask.make("Exercise interrupted preparation"),
                agent: testAgent,
                parentModel: Option.none(),
                maxChildren: ChildSessionBudget.make(4),
                maxAttemptMinutes: 60,
                maxAttemptTokens: 10_000_000,
                parentEffort: "high",
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
              return token;
            }),
        });
        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          runHost: { command: process.execPath, args: [RUN_HOST, "--stub"] },
        }).pipe(Layer.provide(credentials));
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const request = new CheckoutRequest({
            attemptId: AttemptId.make("unlaunched/run/1"),
            worker: WorkerName.make("local"),
            repository: RepositoryName.make("acme/demo"),
            revision: RepositoryRevision.make(prHead),
            payload: {},
            task: AttemptTask.make("Prepare without launching"),
            agent: testAgent,
            parentModel: Option.none(),
            maxChildren: ChildSessionBudget.make(4),
            maxAttemptMinutes: 60,
            maxAttemptTokens: 10_000_000,
            parentEffort: "high",
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
          const reused = yield* prepared.launch({ append: () => Effect.void }).pipe(Effect.flip);
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
        const runtime = localLayer(instance, config, [], { repositoryUrl: () => remote }).pipe(
          Layer.provide(credentialLayer),
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
    "points the run host's TURBO_CACHE_DIR at a worker-scoped directory outside repos/",
    () =>
      withLocalEngine(
        ["--stub"],
        ({ engine, instance }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(7));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            yield* waitFor(engine, accepted.runId, "Succeeded");
            const path = yield* Path.Path;
            const fileSystem = yield* FileSystem.FileSystem;
            const workerRoot = path.join(instance, ".usine", "workers", "local");
            assert(yield* fileSystem.exists(path.join(workerRoot, "turbo", "test-marker")));
          }),
        TURBO_CACHE_HOST,
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "runs Event → Attempt, persists the transcript, and removes the worktree",
    () =>
      withLocalEngine(["--stub"], ({ engine, instance }) =>
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
            transcript.map(({ direction, envelope }) => [direction, envelope.payload._tag]),
            [
              ["outbound", "Started"],
              ["outbound", "SessionEvent"],
              ["outbound", "SessionEvent"],
              ["outbound", "SessionEvent"],
              ["outbound", "Final"],
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
              return Redacted.make(TOKEN);
            }),
        });
        yield* withLocalEngine(
          ["--stub"],
          ({ engine }) =>
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
          undefined,
          credentials,
        );
      }),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "cancels idempotently with an interrupt envelope before cleanup",
    () =>
      withLocalEngine(["--stub-delay-ms", "5000"], ({ engine, instance }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(submission(2));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const running = yield* waitFor(engine, accepted.runId, "Running");
          const attempt = running.attempts[0];
          assert(attempt !== undefined);
          for (let poll = 0; poll < STATE_POLL_ATTEMPTS; poll += 1) {
            const transcript = yield* engine.transcript(
              new TranscriptAllQuery({ attemptId: attempt.id }),
            );
            if (transcript.some(({ envelope }) => envelope.payload._tag === "Started")) break;
            yield* Effect.sleep("10 millis");
          }
          yield* engine.cancel(accepted.runId);
          yield* engine.cancel(accepted.runId);
          const canceled = yield* waitFor(engine, accepted.runId, "Canceled");
          assert.strictEqual(canceled.attempts.length, 1);

          const transcript = yield* engine.transcript(
            new TranscriptAllQuery({ attemptId: attempt.id }),
          );
          assert(
            transcript.some(
              ({ direction, envelope }) =>
                direction === "inbound" && envelope.payload._tag === "Cancel",
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
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "keeps excess Runs pending and assigns the oldest pending Event first",
    () =>
      withLocalEngine(["--stub-delay-ms", "300"], ({ engine }) =>
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
    "classifies channel loss as retryable infrastructure failure",
    () =>
      withLocalEngine(
        [],
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
        CHANNEL_LOSS_HOST,
      ),
    LIVE_TEST_TIMEOUT,
  );
});
