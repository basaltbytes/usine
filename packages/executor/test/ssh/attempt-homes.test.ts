import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { codexAppServerLive, codexChildLayer } from "@usine/agents/codex";
import { catalog } from "@usine/agents/harness";
import { harnessesLive } from "@usine/agents/harness/node";
import { ChildBackend, ChildRequest, WorkingDirectory } from "@usine/agents/runtime";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { Effect, FileSystem, Layer, Option, Stream } from "effect";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { hostLoginLockLayer } from "../../src/executor.ts";
import { remoteCommandsFor } from "../../src/remote/commands.ts";
import { attemptHomeIn, attemptHomesFor } from "../../src/ssh/attempt-homes.ts";
import type { SshMachine } from "../../src/ssh/model.ts";
import { ADDRESS } from "./support.ts";

it.live.skipIf(process.platform !== "linux")(
  "keeps Codex rollouts across SSH scope closure and resumes the saved thread",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-homes-restart-" });
      const bin = `${directory}/bin`;
      yield* fs.makeDirectory(bin);
      yield* fs.symlink(execPath, `${bin}/node`);
      yield* fs.copyFile(
        fileURLToPath(new URL("../fixtures/codex-session.cjs", import.meta.url)),
        `${bin}/codex`,
      );
      yield* fs.chmod(`${bin}/codex`, 0o755);
      const shell = RemoteShell.make({
        ssh: {
          command: fileURLToPath(
            new URL("../../../agents/test/fixtures/ssh-shim.sh", import.meta.url),
          ),
          args: [],
        },
        sshEnvironment: {},
        destination: "worker",
      });
      const machine: SshMachine = {
        address: ADDRESS,
        shell,
        workerDirectory: `${directory}/worker`,
        gateway: Option.none(),
        provisioned: Option.none(),
      };
      const attemptId = AttemptId.make("restart/execute/1");
      const codex = catalog.descriptors.find(({ id }) => id === "codex");
      assert(codex !== undefined);
      const checkout = `${machine.workerDirectory}/attempts/restart_execute_1`;
      yield* fs.makeDirectory(checkout, { recursive: true });
      const codexHome = attemptHomeIn(machine.workerDirectory, attemptId, codex.id);
      const request = ChildRequest.make({
        worker: ADDRESS.name,
        machine: Option.none(),
        cwd: WorkingDirectory.make(checkout),
        session: ChildSession.make({
          id: AgentSessionId.make("parent:restart:child:1"),
          parentId: AgentSessionId.make("parent:restart"),
          agent: AgentName.make("developer"),
          brain: BrainSpec.make({
            harness: Harness.make("codex"),
            model: ModelId.make("test-model"),
            effort: "off",
          }),
        }),
        prompt: "Complete the task.",
        environment: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, CODEX_HOME: codexHome },
        host: shell,
      });
      const backend = yield* ChildBackend;
      const commands = yield* remoteCommandsFor;
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const homes = yield* attemptHomesFor(commands);
          yield* homes.hold(machine, attemptId, codex);
          const child = yield* backend.launch(request);
          const started = yield* child.events.pipe(
            Stream.filter((event) => event._tag === "SessionStarted"),
            Stream.runHead,
          );
          assert(Option.isSome(started) && Option.isSome(started.value.harnessSession));
          return started.value.harnessSession.value;
        }),
      );
      const rollout = yield* fs.readFileString(`${codexHome}/sessions/rollout-thread-one.jsonl`);
      assert.strictEqual(rollout, "thread-one\n");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const homes = yield* attemptHomesFor(commands);
          yield* homes.sweep(machine);
          yield* homes.hold(machine, attemptId, codex);
          const child = yield* backend.launch(
            ChildRequest.make({ ...request, resume: Option.some(saved) }),
          );
          const result = yield* child.result;
          const resumed = yield* fs.readFileString(`${codexHome}/resumed`);
          assert.strictEqual(result.message, "Resumed original thread");
          assert.strictEqual(resumed, "thread-one");
          yield* fs.remove(`${codexHome}/sessions/rollout-thread-one.jsonl`);
          const error = yield* backend
            .launch(ChildRequest.make({ ...request, resume: Option.some(saved) }))
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "SessionOperationError");
          assert.include(error.message, "no rollout found for thread id thread-one");
          yield* fs.remove(checkout, { recursive: true });
        }),
      );
      const codexRemains = yield* fs.exists(codexHome);
      assert.isFalse(codexRemains);

      yield* fs.makeDirectory(codexHome, { recursive: true });
      const homes = yield* attemptHomesFor(commands);
      yield* homes.sweep(machine);
      const orphanRemains = yield* fs.exists(codexHome);
      assert.isFalse(orphanRemains, "startup sweep removes homes without a checkout");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          harnessesLive.pipe(Layer.provide(hostLoginLockLayer)),
          codexChildLayer.pipe(Layer.provide(codexAppServerLive)),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.timeout("20 seconds"),
    ),
);
