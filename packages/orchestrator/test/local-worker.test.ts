import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config";
import {
  Agent,
  Attempt,
  AttemptChannel,
  Event,
  Item,
  Loop,
  Repository,
  Run,
  RunState,
  Step,
  StepResult,
  Worker,
} from "@usine/core";
import {
  CredentialProvider,
  Executor,
  ExecutorOperationError,
  PreparedAttempt,
  WorktreePath,
} from "@usine/executor";
import {
  InstanceDirectory,
  RunEngine,
  StepExecution,
  StepExecutor,
  Submission,
  TranscriptQuery,
} from "@usine/engine";
import { stepExecutorLayer } from "../src/index.ts";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { layer as localLayer } from "../src/local.ts";

const RUN_HOST = fileURLToPath(new URL("../../run-host/dist/bin.js", import.meta.url));
const CHANNEL_LOSS_HOST = fileURLToPath(new URL("./fixtures/channel-loss.mjs", import.meta.url));
const TOKEN = "one-attempt-test-token";
const STATE_POLL_ATTEMPTS = 1_000;
const LIVE_TEST_TIMEOUT = 30_000;
const testAgent = new Agent.Agent({
  name: Agent.Name.make("developer"),
  brain: new Agent.BrainSpec({
    harness: "claude",
    model: Agent.ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  persona: Agent.Persona.make("Implement the task."),
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
    event: new Event.Event({
      id: Event.EventId.make(`local-event-${number}`),
      dedupKey: Event.DedupKey.make(`local/item-${number}/main`),
      payload: { number },
      receivedAt: DateTime.makeUnsafe(receivedAt),
    }),
    itemKey: Item.ItemKey.make(`item-${number}`),
    loop: Loop.LoopName.make("local-worker"),
    step: Step.StepName.make("execute"),
    approval: "none",
    repository: Repository.Name.make("acme/demo"),
    revision: Repository.Revision.make("main"),
    task: AttemptChannel.Task.make(`Complete local task ${number}`),
    agent: testAgent,
    parentModel: Option.none(),
  });

const waitFor = Effect.fn("test.waitFor")(function* (
  engine: RunEngine["Service"],
  runId: Run.RunId,
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
            new TranscriptQuery({ attemptId: attempt.id, after: Option.none() }),
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
            new TranscriptQuery({
              attemptId: attempt.id,
              after: Option.some(firstTranscriptEntry.sequence),
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
              new TranscriptQuery({ attemptId: attempt.id, after: Option.none() }),
            );
            if (transcript.some(({ envelope }) => envelope.payload._tag === "Started")) break;
            yield* Effect.sleep("10 millis");
          }
          yield* engine.cancel(accepted.runId);
          yield* engine.cancel(accepted.runId);
          const canceled = yield* waitFor(engine, accepted.runId, "Canceled");
          assert.strictEqual(canceled.attempts.length, 1);

          const transcript = yield* engine.transcript(
            new TranscriptQuery({ attemptId: attempt.id, after: Option.none() }),
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
      attemptId: Attempt.AttemptId.make("cleanup-run/run/1"),
      repository: Repository.Name.make("acme/demo"),
      revision: Repository.Revision.make("main"),
      baseCommit: Repository.CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      payload: {},
      task: AttemptChannel.Task.make("Prove cleanup stays out of the outcome"),
      agent: testAgent,
      parentModel: Option.none(),
    });
    const prepared = new PreparedAttempt({
      worker: Worker.Name.make("local"),
      spec,
      worktree: WorktreePath.make("/tmp/usine-cleanup-test"),
    });
    const executor = Layer.succeed(Executor)({
      kind: "local",
      preflight: () => Effect.void,
      prepare: () => Effect.succeed(prepared),
      launch: () => Effect.succeed(new StepResult.StepResult({ message: "done", facts: [] })),
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
    const runId = Run.RunId.make("cleanup-run");
    const event = new Event.Event({
      id: Event.EventId.make("cleanup-event"),
      dedupKey: Event.DedupKey.make("cleanup/event"),
      payload: {},
      receivedAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
    });
    const execution = new StepExecution({
      attempt: new Attempt.Attempt({
        id: spec.attemptId,
        runId,
        stepName: Step.StepName.make("run"),
        worker: Worker.Name.make("local"),
        number: Attempt.AttemptNumber.make(1),
        brain: testAgent.brain,
        parentModel: Option.none(),
        startedAt: DateTime.makeUnsafe("2026-08-30T12:00:01Z"),
        outcome: Option.none(),
      }),
      event,
      run: new Run.Run({
        id: runId,
        eventId: event.id,
        loop: Loop.LoopName.make("review"),
        state: RunState.start(new RunState.Pending()),
        openedAt: DateTime.makeUnsafe("2026-08-30T12:00:00Z"),
      }),
      step: new Step.Step({
        runId,
        name: Step.StepName.make("run"),
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
