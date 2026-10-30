import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision, safeSegment } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { InstanceDirectory } from "@usine/core/instance";
import { layer as durableAttemptRuntimeLayer } from "@usine/durable/live";
import { GitHubIntegration, IntegrationName } from "@usine/executor/exe-dev";
import { RunEngine, Submission } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { Config, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layer as exeDevLayer } from "../../src/exe-dev.ts";
import { fixedConfigLayer } from "../support/current-instance.ts";
import { testAppLayer } from "../support/github-app.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";
import { claudeLoginLockLayer } from "@usine/executor";

const VmList = Schema.Struct({
  vms: Schema.Array(
    Schema.Struct({
      vm_name: Schema.NonEmptyString,
      ssh_dest: Schema.NonEmptyString,
    }),
  ),
});

const output = Effect.fn("ExeDevIntegration.output")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make(command, args), { includeStderr: true });
});

const exitCode = Effect.fn("ExeDevIntegration.exitCode")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Number(yield* spawner.exitCode(ChildProcess.make(command, args)));
});

const waitForSuccess = Effect.fn("ExeDevIntegration.waitForSuccess")(function* (
  engine: RunEngine["Service"],
  runId: Parameters<RunEngine["Service"]["inspect"]>[0],
) {
  let snapshot = yield* engine.inspect(runId);
  for (let poll = 0; poll < 1_800; poll += 1) {
    if (snapshot.run.state._tag === "Succeeded") return snapshot;
    if (snapshot.run.state._tag === "Failed" || snapshot.run.state._tag === "Canceled") {
      return yield* Effect.die(`exe.dev integration Run ended as ${snapshot.run.state._tag}`);
    }
    yield* Effect.sleep("100 millis");
    snapshot = yield* engine.inspect(runId);
  }
  return yield* Effect.die(`exe.dev integration Run remained ${snapshot.run.state._tag}`);
});

describe("live exe.dev Worker", () => {
  it.live("runs one Attempt with its children on the VM and persists its transcript", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.all({
        worker: Config.String("USINE_EXE_DEV_INTEGRATION_WORKER"),
        repository: Config.String("USINE_EXE_DEV_INTEGRATION_REPO"),
        revision: Config.String("USINE_EXE_DEV_INTEGRATION_REVISION"),
        integration: Config.String("USINE_EXE_DEV_INTEGRATION_GITHUB_INTEGRATION"),
      });
      const worker = WorkerName.make(settings.worker);
      const repository = RepositoryName.make(settings.repository);
      const revision = RepositoryRevision.make(settings.revision);
      const agent = new Agent({
        name: AgentName.make("developer"),
        brain: new BrainSpec({
          harness: "codex",
          model: ModelId.make("gpt-5.6-sol"),
          effort: "high",
        }),
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: AgentPersona.make("Verify the remote Worker transport."),
      });
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
        workers: [{ name: worker, kind: "exe.dev", max_concurrent_attempts: 1 }],
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceDirectory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-exe-dev-integration-" }),
      );
      const runtime = exeDevLayer(instanceDirectory, config, [agent.brain], {
        githubIntegrations: [
          new GitHubIntegration({
            repository,
            name: IntegrationName.make(settings.integration),
          }),
        ],
      }).pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(alwaysHoldsLayer),
        Layer.provide(durableAttemptRuntimeLayer(instanceDirectory)),
        Layer.provide(claudeLoginLockLayer),
        Layer.provide(fixedConfigLayer(config)),
        Layer.provide(testAppLayer),
      );

      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(
          new Submission({
            event: new Event({
              id: EventId.make(`exe-dev-${globalThis.crypto.randomUUID()}`),
              dedupKey: DedupKey.make(`exe-dev/${repository}/${globalThis.crypto.randomUUID()}`),
              payload: { integration: "exe.dev" },
              receivedAt: yield* DateTime.now,
            }),
            itemKey: ItemKey.make("exe-dev-integration"),
            loop: LoopName.make("exe-dev-integration"),
            step: StepName.make("execute"),
            approval: "none",
            repository,
            revision,
            task: AttemptTask.make("Verify the exe.dev Worker transport"),
            agent,
            parentModel: Option.none(),
          }),
        );
        assert.strictEqual(accepted._tag, "Claimed");
        if (accepted._tag !== "Claimed") return;
        const finished = yield* waitForSuccess(engine, accepted.runId);
        const attempt = finished.attempts[0];
        assert(attempt !== undefined);
        assert.strictEqual(attempt.worker, worker);
        assert(Option.isSome(finished.step.result));

        const transcript = yield* engine.transcript(
          new TranscriptAllQuery({ attemptId: attempt.id }),
        );
        const tags = transcript.map(({ direction, envelope }) => [
          direction,
          envelope.payload._tag,
        ]);
        assert.deepStrictEqual(tags.at(0), ["outbound", "Started"]);
        assert.deepStrictEqual(tags.at(-1), ["outbound", "Final"]);
        assert(
          transcript.some(
            ({ envelope }) =>
              envelope.payload._tag === "SessionEvent" &&
              envelope.payload.event._tag === "SessionStarted" &&
              envelope.payload.event.session._tag === "ChildSession",
          ),
          "the parent must have delegated to a child on the VM",
        );

        const machines = yield* output("ssh", ["exe.dev", "ls", worker, "--json"]).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(VmList))),
        );
        const vm = machines.vms.find(({ vm_name: name }) => name === worker);
        assert(vm !== undefined);
        const home = (yield* output("ssh", [vm.ssh_dest, "--", "printenv", "HOME"])).trim();
        const root = `${home}/.usine/workers/${safeSegment(worker)}`;
        const cache = `${root}/repos/${safeSegment(repository)}.git`;
        const worktree = `${root}/attempts/${safeSegment(attempt.id)}`;
        assert.strictEqual(yield* exitCode("ssh", [vm.ssh_dest, "--", "test", "-d", cache]), 0);
        assert.strictEqual(
          yield* exitCode("ssh", [vm.ssh_dest, "--", "test", "!", "-e", worktree]),
          0,
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
