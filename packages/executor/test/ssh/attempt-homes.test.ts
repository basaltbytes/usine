import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { claudeChildLayer, claudeSdkLive } from "@usine/agents/claude";
import { codexAppServerLive, codexChildLayer } from "@usine/agents/codex";
import { catalog } from "@usine/agents/harness";
import { harnessesLive } from "@usine/agents/harness/node";
import { ChildBackend, ChildRequest, WorkingDirectory } from "@usine/agents/runtime";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import {
  ContainerCpus,
  ContainerImage,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
  ContainerScratchMib,
} from "@usine/core/worker";
import { Effect, FileSystem, Layer, Option, Stream } from "effect";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { hostLoginLockLayer } from "../../src/executor.ts";
import { containersFor, type ContainerSettings } from "../../src/remote/container.ts";
import { remoteCommandsFor } from "../../src/remote/commands.ts";
import { attemptHomeIn, attemptHomesFor } from "../../src/ssh/attempt-homes.ts";
import type { SshMachine } from "../../src/ssh/model.ts";
import { ADDRESS, INSTANCE_ID } from "./support.ts";

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
          assert.strictEqual(error._tag, "SessionInterruptedError");
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

it.live.each(["docker", "podman"] as const)(
  "keeps Claude project sessions across %s container recreation until checkout cleanup",
  (runtime) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-claude-restart-" });
      const bin = `${directory}/bin`;
      yield* fs.makeDirectory(bin);
      yield* fs.symlink(execPath, `${bin}/node`);
      yield* fs.copyFile(
        fileURLToPath(new URL("../fixtures/container-sessions.cjs", import.meta.url)),
        `${bin}/${runtime}`,
      );
      yield* fs.chmod(`${bin}/${runtime}`, 0o755);
      yield* fs.copyFile(
        fileURLToPath(new URL("../fixtures/claude-session.cjs", import.meta.url)),
        `${bin}/claude`,
      );
      yield* fs.chmod(`${bin}/claude`, 0o755);
      const shell = RemoteShell.make({
        ssh: {
          command: fileURLToPath(
            new URL("../../../agents/test/fixtures/ssh-shim.sh", import.meta.url),
          ),
          args: [],
        },
        sshEnvironment: {
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          HOME: directory,
          USINE_TEST_CONTAINERS: `${directory}/containers`,
        },
        destination: "worker",
      });
      const machine: SshMachine = {
        address: ADDRESS,
        shell,
        workerDirectory: `${directory}/worker`,
        gateway: Option.none(),
        provisioned: Option.none(),
      };
      const attemptId = AttemptId.make("claude-restart/execute/1");
      const harness = Harness.make("claude");
      const checkout = `${machine.workerDirectory}/attempts/claude-restart_execute_1`;
      const projects = attemptHomeIn(machine.workerDirectory, attemptId, harness);
      const commands = yield* remoteCommandsFor;
      const settings: ContainerSettings = {
        process: "test",
        runtime,
        hosts: {},
        image: ContainerImage.make("test-image"),
        limits: ContainerLimits.make({
          cpus: ContainerCpus.make(1),
          memoryMib: ContainerMemoryMib.make(1024),
          pids: ContainerPids.make(128),
        }),
        shmSizeMib: ContainerScratchMib.make(256),
        tmpfsSizeMib: ContainerScratchMib.make(256),
        instance: "test",
        instanceId: INSTANCE_ID,
      };
      const name = "claude-restart";
      const start = Effect.fn("test.startClaudeContainer")(function* () {
        const homes = yield* attemptHomesFor(commands);
        const writable = yield* homes.mounts(
          machine,
          attemptId,
          Option.some(harness),
          { _tag: "Container", settings },
          "prepare",
        );
        yield* homes.sweep(machine);
        const held = yield* fs.exists(projects);
        assert.isTrue(held, "a preparing attempt retains its projects before checkout creation");
        yield* fs.makeDirectory(checkout, { recursive: true });
        return yield* containersFor(commands).start("prepare", shell, {
          name,
          settings,
          worker: ADDRESS.name,
          attemptId: Option.some(attemptId),
          checkout: Option.some({ path: checkout, parent: `${machine.workerDirectory}/attempts` }),
          readOnly: [],
          writable,
          harnesses: [harness],
          environment: {},
          secrets: {},
        });
      });
      const backend = yield* ChildBackend;
      const childRequest = (host: RemoteShell) =>
        ChildRequest.make({
          worker: ADDRESS.name,
          machine: Option.none(),
          cwd: WorkingDirectory.make(checkout),
          host,
          environment: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` },
          session: ChildSession.make({
            id: AgentSessionId.make("parent:claude-restart:child:1"),
            parentId: AgentSessionId.make("parent:claude-restart"),
            agent: AgentName.make("developer"),
            brain: BrainSpec.make({ harness, model: ModelId.make("test-model"), effort: "off" }),
          }),
          prompt: "Complete the task.",
        });
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* start();
          const child = yield* backend.launch(childRequest(host));
          const started = yield* child.events.pipe(
            Stream.filter((event) => event._tag === "SessionStarted"),
            Stream.runHead,
          );
          assert(Option.isSome(started) && Option.isSome(started.value.harnessSession));
          return started.value.harnessSession.value;
        }),
      );
      const removedContainer = yield* fs.exists(`${directory}/containers/${name}`);
      assert.isFalse(removedContainer, "orchestrator shutdown removes the container");
      const restartedHomes = yield* attemptHomesFor(commands);
      yield* restartedHomes.sweep(machine);
      const retained = yield* fs.readFileString(`${projects}/project/${saved.id}.jsonl`);
      assert.strictEqual(retained, `${saved.id}\n`);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* start();
          const child = yield* backend.launch(
            ChildRequest.make({
              ...childRequest(host),
              resume: Option.some(saved),
            }),
          );
          const result = yield* child.result;
          assert.strictEqual(result.message, "Resumed original conversation");
          yield* fs.remove(checkout, { recursive: true });
        }),
      );
      const remains = yield* fs.exists(projects);
      assert.isFalse(remains, "checkout cleanup releases Claude projects");
      yield* fs.makeDirectory(projects, { recursive: true });
      const homes = yield* attemptHomesFor(commands);
      yield* homes.sweep(machine);
      const orphan = yield* fs.exists(projects);
      assert.isFalse(orphan, "the sweep includes Claude directories without a checkout");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const mounts = yield* homes.mounts(
            machine,
            attemptId,
            Option.some(harness),
            { _tag: "SharedUser" },
            "prepare",
          );
          assert.deepStrictEqual(mounts, []);
          const created = yield* fs.exists(projects);
          assert.isFalse(created, "shared-user SSH keeps its existing session location");
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(harnessesLive, claudeChildLayer.pipe(Layer.provide(claudeSdkLive))).pipe(
          Layer.provide(hostLoginLockLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.timeout("20 seconds"),
    ),
);
