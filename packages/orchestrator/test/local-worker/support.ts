import { NodeServices } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { type AttemptId, AttemptTask, AttemptWindow, AttemptWindows } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { RunEngine, Submission } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { HarnessReady } from "@usine/core/agent/capability";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { claudeLoginLockLayer, CredentialProvider, WorkerCredential } from "@usine/executor";
import type { HarnessProbe, LocalExecutorOptions } from "@usine/executor/local";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { stepExecutorLayer } from "../../src/scheduler/scheduler.ts";
import { stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { fixedConfigLayer } from "../support/current-instance.ts";
import { testAppLayer } from "../support/github-app.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";

/**
 * Returns windows where `attemptId` is the only Attempt of its Agent on the Item, open since before
 * any test time, so the harvest keeps every signed comment.
 */
export const aloneOnItem = (attemptId: AttemptId) =>
  Effect.succeed(
    new AttemptWindows({
      own: Option.some(
        new AttemptWindow({ attemptId, startedAt: DateTime.makeUnsafe(0), endedAt: Option.none() }),
      ),
      overlapping: [],
    }),
  );

export const TOKEN = "one-attempt-test-token";
// Each live transition crosses real git worktree and child-process boundaries. The 10-second poll
// horizon allows for slow CI hosts, and the 10 ms interval still reports the last durable state
// when a transition stalls.
export const STATE_POLL_ATTEMPTS = 1_000;
// The capacity test completes three sequential Attempt lifecycles, so its
// per-test ceiling must cover more than one state-poll horizon plus cleanup.
export const LIVE_TEST_TIMEOUT = 30_000;

/** Reports every brain ready without probing the machine's harness CLIs. */
export const harnessReady: HarnessProbe = (brain) =>
  Effect.succeed(new HarnessReady({ harness: brain.harness }));

export const testAgent = new Agent({
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

export const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "acme/demo" }],
  workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
});

export const workerCredential = (value: Redacted.Redacted<string>) =>
  new WorkerCredential({
    value,
    expiresAt: DateTime.makeUnsafe(Date.now() + 3_600_000),
  });

export const credentialLayer = Layer.succeed(CredentialProvider)({
  issue: () => Effect.succeed(workerCredential(Redacted.make(TOKEN))),
});

export const run = Effect.fn("test.git")(function* (
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

export const output = Effect.fn("test.gitOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args, { cwd }), {
    includeStderr: true,
  });
});

/** Seeds `<root>/seed` with one commit on `main` pushed to the bare `<root>/origin.git`, and returns the remote path. */
export const makeRemote = Effect.fn("test.makeRemote")(function* (root: string) {
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

export const submission = (number: number, receivedAt = `2026-08-30T12:00:0${number}Z`) =>
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

export const waitFor = Effect.fn("test.waitFor")(function* (
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

/** Waits until the parent task has reported Started, so the Attempt's worktree is checked out and in use. */
export const waitForStarted = Effect.fn("test.waitForStarted")(function* (
  engine: RunEngine["Service"],
  attemptId: AttemptId,
) {
  for (let poll = 0; poll < STATE_POLL_ATTEMPTS; poll += 1) {
    const transcript = yield* engine.transcript(new TranscriptAllQuery({ attemptId }));
    if (transcript.some(({ envelope }) => envelope.payload._tag === "Started")) return;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Attempt ${attemptId} never reported Started`);
});

/**
 * Waits for the first Attempt's salvage record, which the executor writes after the Run's state is
 * final.
 */
export const waitForSalvage = Effect.fn("test.waitForSalvage")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
) {
  for (let poll = 0; poll < STATE_POLL_ATTEMPTS; poll += 1) {
    const salvage = (yield* engine.inspect(runId)).attempts[0]?.salvage;
    if (salvage !== undefined && Option.isSome(salvage)) return salvage.value;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Run ${runId} recorded no salvage`);
});

/** Overrides for a test runtime: parent tasks, credentials, or executor settings. */
export interface LocalRuntimeOptions {
  readonly attemptRuntime?: Layer.Layer<AttemptRuntime>;
  readonly platform?: Layer.Layer<NodeServices.NodeServices>;
  readonly credentials?: Layer.Layer<CredentialProvider>;
  readonly executor?: Omit<LocalExecutorOptions, "instanceDirectory">;
}

/**
 * Returns the orchestrator layer for one local Worker over `remote`, building a new runtime on each
 * call.
 */
export const localRuntime = (
  instance: InstanceDirectory,
  remote: string,
  options: LocalRuntimeOptions = {},
) =>
  localEngineLayer(instance).pipe(
    Layer.provide(
      stepExecutorLayer(config, []).pipe(
        Layer.provide(
          localExecutorLayer({
            instanceDirectory: instance,
            repositoryUrl: () => remote,
            interruptGrace: "100 millis",
            harnessReadiness: harnessReady,
            ...options.executor,
          }).pipe(Layer.provide(options.platform ?? NodeServices.layer)),
        ),
        Layer.provide(fixedConfigLayer(config)),
        Layer.provide(testAppLayer),
      ),
    ),
    Layer.provide(options.credentials ?? credentialLayer),
    Layer.provide(options.attemptRuntime ?? stubAttemptRuntime(new StubStorage())),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(alwaysHoldsLayer),
  );

export const withLocalEngine = <A, E, R>(
  options: LocalRuntimeOptions,
  use: (options: {
    readonly engine: RunEngine["Service"];
    readonly instance: InstanceDirectory;
    readonly remote: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-worker-" });
    const instance = InstanceDirectory.make(root);
    const remote = yield* makeRemote(root);
    return yield* Effect.gen(function* () {
      const engine = yield* RunEngine;
      return yield* use({ engine, instance, remote });
    }).pipe(Effect.provide(localRuntime(instance, remote, options)));
  }).pipe(Effect.provide(NodeServices.layer));
