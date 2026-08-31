import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config";
import {
  Agent,
  AttemptChannel,
  Event,
  Instance,
  Item,
  Loop,
  Repository,
  Step,
  Worker,
} from "@usine/core";
import { GitHubIntegration, HarnessLoginCheck, IntegrationName } from "@usine/executor/exe-dev";
import { RunEngine, Submission, TranscriptQuery } from "@usine/engine";
import { Config, DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { layer as exeDevLayer } from "../../src/exe-dev.ts";

const VmList = Schema.Struct({
  vms: Schema.Array(
    Schema.Struct({
      vm_name: Schema.NonEmptyString,
      ssh_dest: Schema.NonEmptyString,
    }),
  ),
});

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

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
  it.live("runs one Attempt through the remote run host and persists its transcript", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.all({
        worker: Config.string("USINE_EXE_DEV_INTEGRATION_WORKER"),
        repository: Config.string("USINE_EXE_DEV_INTEGRATION_REPO"),
        revision: Config.string("USINE_EXE_DEV_INTEGRATION_REVISION"),
        integration: Config.string("USINE_EXE_DEV_INTEGRATION_GITHUB_INTEGRATION"),
      });
      const worker = Worker.Name.make(settings.worker);
      const repository = Repository.Name.make(settings.repository);
      const revision = Repository.Revision.make(settings.revision);
      const agent = new Agent.Agent({
        name: Agent.Name.make("developer"),
        brain: new Agent.BrainSpec({
          harness: "codex",
          model: Agent.ModelId.make("gpt-5.6-sol"),
          effort: "high",
        }),
        parentModel: Option.none(),
        persona: Agent.Persona.make("Verify the remote Worker transport."),
      });
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: repository }],
        workers: [{ name: worker, kind: "exe.dev", max_concurrent_attempts: 1 }],
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceDirectory = Instance.Directory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-exe-dev-integration-" }),
      );
      const runtime = exeDevLayer(instanceDirectory, config, {
        githubIntegrations: [
          new GitHubIntegration({
            repository,
            name: IntegrationName.make(settings.integration),
          }),
        ],
        harnessLoginChecks: [
          new HarnessLoginCheck({
            harness: "codex",
            command: "codex",
            args: ["login", "status"],
          }),
        ],
      });

      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(
          new Submission({
            event: new Event.Event({
              id: Event.EventId.make(`exe-dev-${globalThis.crypto.randomUUID()}`),
              dedupKey: Event.DedupKey.make(
                `exe-dev/${repository}/${globalThis.crypto.randomUUID()}`,
              ),
              payload: { integration: "exe.dev" },
              receivedAt: yield* DateTime.now,
            }),
            itemKey: Item.ItemKey.make("exe-dev-integration"),
            loop: Loop.LoopName.make("exe-dev-integration"),
            step: Step.StepName.make("execute"),
            approval: "none",
            repository,
            revision,
            task: AttemptChannel.Task.make("Verify the exe.dev Worker transport"),
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
          new TranscriptQuery({ attemptId: attempt.id, after: Option.none() }),
        );
        assert.deepStrictEqual(
          transcript.map(({ direction, envelope }) => [direction, envelope.payload._tag]),
          [
            ["outbound", "Started"],
            ["outbound", "SessionEvent"],
            ["outbound", "Final"],
          ],
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
