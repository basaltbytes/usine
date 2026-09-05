import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { Attempt, AttemptNumber, AttemptTask, AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, CommitSha, RepositoryRevision } from "@usine/core/repository";
import { RunId, Run } from "@usine/core/run";
import { StepName, Step } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import * as RunState from "@usine/core/run/state";
import { StepResult } from "@usine/core/step/result";
import {
  CredentialProvider,
  Executor,
  ExecutorOperationError,
  PreparedAttempt,
  WorktreePath,
} from "@usine/executor";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine, Submission } from "@usine/engine/engine";
import { StepExecution, StepExecutor } from "@usine/engine/step-executor";
import { TranscriptAllQuery, TranscriptTailQuery } from "@usine/engine/transcript";
import { stepExecutorLayer } from "../src/scheduler.ts";
import {
  DateTime,
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
import { layer as localLayer } from "../src/local.ts";

const RUN_HOST = fileURLToPath(new URL("../../run-host/dist/bin.js", import.meta.url));
const CHANNEL_LOSS_HOST = fileURLToPath(new URL("./fixtures/channel-loss.mjs", import.meta.url));
const TURBO_CACHE_HOST = fileURLToPath(new URL("./fixtures/turbo-cache.mjs", import.meta.url));
const TOKEN = "one-attempt-test-token";
// Each live transition crosses real git worktree and child-process boundaries;
// the 10-second poll horizon absorbs slow shared CI hosts while the 10 ms cadence
// still reports the last durable state when a transition genuinely stalls.
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
    const runtime = localLayer(instance, config, {
      repositoryUrl: () => remote,
      ...runHostOption,
      interruptGrace: "100 millis",
    }).pipe(Layer.provide(credentialLayer));
    return yield* Effect.gen(function* () {
      const engine = yield* RunEngine;
      return yield* use({ engine, instance, remote });
    }).pipe(Effect.provide(runtime));
  }).pipe(Effect.provide(NodeServices.layer));

describe("local worker", () => {
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
        const runtime = localLayer(instance, config, { repositoryUrl: () => remote }).pipe(
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
        // Issue #84's acceptance criterion: a startup with stray entries logs
        // no cleanup warning at all, whatever the message says.
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
                direction === "inbound" && envelope.payload._tag === "Interrupt",
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

  it.effect("keeps a successful attempt successful when cleanup fails", () => {
    const spec = new AttemptChannel.RunSpec({
      attemptId: AttemptId.make("cleanup-run/run/1"),
      repository: RepositoryName.make("acme/demo"),
      revision: RepositoryRevision.make("main"),
      baseCommit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      payload: {},
      task: AttemptTask.make("Prove cleanup stays out of the outcome"),
      agent: testAgent,
      parentModel: Option.none(),
      maxChildren: ChildSessionBudget.make(4),
      parentEffort: "high",
    });
    const prepared = new PreparedAttempt({
      worker: WorkerName.make("local"),
      spec,
      worktree: WorktreePath.make("/tmp/usine-cleanup-test"),
    });
    const executor = Layer.succeed(Executor)({
      kind: "local",
      preflight: () => Effect.void,
      prepare: () => Effect.succeed(prepared),
      launch: () => Effect.succeed(new StepResult({ message: "done", facts: [] })),
      cancel: () => Effect.void,
      // ADR 0006 regression: a failed worktree removal must never convert a
      // finished agent session into a retryable infra failure.
      cleanup: () =>
        Effect.fail(
          new ExecutorOperationError({
            operation: "cleanup",
            message: "worktree removal failed",
            cause: new Error("EBUSY"),
          }),
        ),
    });
    const runId = RunId.make("cleanup-run");
    const event = new Event({
      id: EventId.make("cleanup-event"),
      dedupKey: DedupKey.make("cleanup/event"),
      payload: {},
      receivedAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
    });
    const execution = new StepExecution({
      attempt: new Attempt({
        id: spec.attemptId,
        runId,
        stepName: StepName.make("run"),
        worker: WorkerName.make("local"),
        number: AttemptNumber.make(1),
        brain: testAgent.brain,
        parentModel: Option.none(),
        startedAt: DateTime.makeUnsafe("2026-08-30T12:00:01Z"),
        outcome: Option.none(),
      }),
      event,
      run: new Run({
        id: runId,
        eventId: event.id,
        loop: LoopName.make("review"),
        state: RunState.start(new RunState.Pending()),
        openedAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
      }),
      step: new Step({
        runId,
        name: StepName.make("run"),
        result: Option.none(),
      }),
      repository: spec.repository,
      revision: spec.revision,
      task: spec.task,
      agent: testAgent,
      parentModel: Option.none(),
    });

    return Effect.gen(function* () {
      const stepExecutor = yield* StepExecutor;
      const result = yield* stepExecutor.execute(execution, { append: () => Effect.void });
      assert.strictEqual(result.message, "done");
    }).pipe(Effect.provide(stepExecutorLayer(config).pipe(Layer.provide(executor))));
  });
});
