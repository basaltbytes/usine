import { NodeServices } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { AttemptTask } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { RunEngine, Submission } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { CredentialProvider, WorkerCredential } from "@usine/executor";
import { DateTime, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { layer as localLayer } from "../../src/local.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";

export const RUN_HOST = fileURLToPath(new URL("../../../run-host/dist/bin.js", import.meta.url));
export const TOKEN = "one-attempt-test-token";
// Each live transition crosses real git worktree and child-process boundaries.
// The 10-second poll horizon absorbs slow CI hosts, and the 10 ms cadence still
// reports the last durable state when a transition stalls.
export const STATE_POLL_ATTEMPTS = 1_000;
// The capacity test completes three sequential run-host lifecycles, so its
// per-test ceiling must cover more than one state-poll horizon plus cleanup.
export const LIVE_TEST_TIMEOUT = 30_000;

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

/** Waits until the run host has acknowledged the Attempt, so its worktree is checked out and in use. */
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

/** Waits for the first Attempt's salvage record; the executor writes it after the Run's state has settled. */
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

/** The orchestrator layer for one local Worker over `remote`; every call builds a fresh runtime. */
export const localRuntime = (
  instance: InstanceDirectory,
  remote: string,
  runHostArgs: ReadonlyArray<string>,
  runHost?: string,
  credentials = credentialLayer,
) => {
  const runHostOption =
    runHost === undefined && runHostArgs.length === 0
      ? {}
      : {
          runHost: {
            command: process.execPath,
            args: [runHost ?? RUN_HOST, ...runHostArgs],
          },
        };
  return localLayer(instance, config, [], {
    repositoryUrl: () => remote,
    ...runHostOption,
    interruptGrace: "100 millis",
  }).pipe(Layer.provide(credentials), Layer.provide(alwaysHoldsLayer));
};

export const withLocalEngine = <A, E, R>(
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
    return yield* Effect.gen(function* () {
      const engine = yield* RunEngine;
      return yield* use({ engine, instance, remote });
    }).pipe(Effect.provide(localRuntime(instance, remote, runHostArgs, runHost, credentials)));
  }).pipe(Effect.provide(NodeServices.layer));
