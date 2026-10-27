import { assert, describe, it } from "@effect/vitest";
import { CHILD_KILL_SCRIPT, RemoteShell } from "@usine/agents/child-host";
import { Agent } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, type OutOfMemoryKills } from "@usine/core/attempt";
import { type AttemptSalvage, SalvageRef } from "@usine/core/attempt/salvage";
import { ContainerMemoryMib, WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { ChatGptLogin, HostFilePath, OpenAiProvider, UpstreamBase } from "@usine/gateway";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { readFileSync } from "node:fs";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import { ATTEMPT_IMAGE, type SshWorkerAddress, SshWorkers } from "../../src/ssh/ssh.ts";
import { fakeGateway, gatewayAddress, gatewayRuntime } from "./gateway/support.ts";
import {
  ADDRESS,
  aloneOnItem,
  capturedLogs,
  CREDENTIALS,
  executorLayer,
  fails,
  fakeMachine,
  INSTANCE,
  INSTANCE_ID,
  mintingProvider,
  noGateway,
  request,
  runtime,
  TEST_AGENT,
  TOKEN_PREFIX,
  WORKER,
  WORKER_ROOT,
  WORKTREE,
  writesCredential,
} from "./support.ts";

const CONTAINER = "usine-remote-run_execute_1";
const CACHE = `${WORKER_ROOT}/repos/acme_demo.git`;
const MARKER = `${WORKER_ROOT}/container-checkouts/remote-run_execute_1`;

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

/** Returns a fake machine with Docker. */
const dockerMachine = () => {
  const machine = fakeMachine();
  machine.state.docker = "running";
  return machine;
};

/** Returns the unquoted words of a remote command line. */
const wordsOf = (line: string): Array<string> =>
  [...line.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word]) =>
    (word ?? "").replaceAll(`'"'"'`, "'"),
  );

/** Returns the arguments and standard input of the `docker run` that started `name`. */
const runOf = (machine: ReturnType<typeof fakeMachine>, name: string) => {
  const call = machine.state.calls.find(
    ({ line }) => line.startsWith("exec 'docker' 'run' ") && line.includes(`'--name' '${name}'`),
  );
  assert(call !== undefined, `no docker run started ${name}`);
  return { words: wordsOf(call.line), input: call.input };
};

const optionOf = (words: ReadonlyArray<string>, option: string) => words[words.indexOf(option) + 1];

const mountsOf = (words: ReadonlyArray<string>) =>
  words.flatMap((word, index) => (words[index - 1] === "--mount" ? [word] : []));

const linesOf = (machine: ReturnType<typeof fakeMachine>) =>
  machine.state.calls.map(({ line }) => line);

/** Returns the index of each step that releases the Attempt's resources, or -1 if it didn't run. */
const releaseSteps = (machine: ReturnType<typeof fakeMachine>) => {
  const lines = linesOf(machine);
  return {
    childrenStopped: lines.findIndex((line) => wordsOf(line).includes(CHILD_KILL_SCRIPT)),
    checkoutGone: lines.findIndex(
      (line) => line.includes('rm -f "$2"') && line.includes(`'${WORKTREE}' '${MARKER}'`),
    ),
    containerGone: lines.indexOf(`exec 'docker' 'rm' '--force' '${CONTAINER}'`),
    credentialGone: lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`),
  };
};

/** Returns the index of the call that read the container's out-of-memory kills, or -1. */
const killsRead = (machine: ReturnType<typeof fakeMachine>) =>
  linesOf(machine).findIndex((line) => line.includes("memory.events"));

/** Asserts that each named call index exists and comes after the one before it. */
const assertInOrder = (steps: ReadonlyArray<readonly [string, number]>) =>
  steps.forEach(([name, index], position) => {
    assert(index >= 0, `${name} didn't run`);
    const previous = steps[position - 1];
    if (previous !== undefined) assert(index > previous[1], `${name} ran before ${previous[0]}`);
  });

describe("SSH Worker with Docker", () => {
  // turbo.json lists the Dockerfile as an input of this package's tests.
  it("defaults to the image that CI tags with the Dockerfile's harness versions", () => {
    const dockerfile = readFileSync(
      new URL("../../../../infra/worker-image/Dockerfile", import.meta.url),
      "utf8",
    );
    const argument = (name: string) =>
      new RegExp(`^ARG ${name}=(\\S+)$`, "mu").exec(dockerfile)?.[1];
    assert.strictEqual(
      ATTEMPT_IMAGE,
      `ghcr.io/basaltbytes/usine-worker:claude-${argument("CLAUDE_CODE_VERSION")}-codex-${argument("CODEX_VERSION")}`,
    );
  });

  it.effect(
    "runs the Attempt's children and checkout commands in its own container, which mounts only the Attempt's paths",
    () => {
      const machine = dockerMachine();
      let given: AttemptRequest | undefined;
      let running: ReadonlyArray<string> = [];
      const parent: StubParent = (context) => {
        given = context.request;
        running = [...machine.state.containers.keys()];
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        assert.isTrue(Option.isNone(report.degraded));
        assert.include(linesOf(machine), `exec 'docker' 'pull' '--quiet' '${ATTEMPT_IMAGE}'`);
        const probes = machine.state.calls.filter(({ line }) => line.includes("'claude'"));
        assert.isNotEmpty(probes);
        for (const { container } of probes)
          assert.match(container ?? "", /^usine-preflight-eu-one-\d+$/u);
        assert.strictEqual(machine.state.containers.size, 0, "the preflight's container is gone");

        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);

        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.deepStrictEqual(given.host.container, { runtime: "docker", name: CONTAINER });
        assert.deepStrictEqual(running, [CONTAINER]);
        const { words, input } = runOf(machine, CONTAINER);
        assert.strictEqual(optionOf(words, "--network"), "host");
        assert.deepStrictEqual(
          [optionOf(words, "--cpus"), optionOf(words, "--memory"), optionOf(words, "--pids-limit")],
          ["2", "4096m", "4096"],
        );
        assert.includeMembers(words, [
          `dev.usine.instance=${INSTANCE}`,
          `dev.usine.instance-id=${INSTANCE_ID}`,
          `dev.usine.worker=${WORKER}`,
          `dev.usine.attempt=${request.attemptId}`,
        ]);
        assert.strictEqual(words.at(-1), ATTEMPT_IMAGE);
        assert.deepStrictEqual(mountsOf(words), [
          `type=tmpfs,"destination=${WORKER_ROOT}/attempts",tmpfs-mode=1777`,
          `type=bind,"source=${WORKTREE}","destination=${WORKTREE}"`,
          `type=bind,"source=${CACHE}","destination=${CACHE}",readonly`,
          `type=bind,"source=${CREDENTIALS}","destination=${CREDENTIALS}",readonly`,
          `type=bind,"source=/home/usine/.claude/.credentials.json","destination=/home/usine/.claude/.credentials.json"`,
          `type=bind,"source=/home/usine/.claude.json","destination=/usr/local/share/usine/seed/.claude.json",readonly`,
        ]);
        assert.include(input, `GH_CONFIG_DIR=${CREDENTIALS}\n`);
        assert.notInclude(input, TOKEN_PREFIX, "the token stays in its file");

        const inContainer = machine.state.calls.filter(({ container }) => container === CONTAINER);
        const created = inContainer.find(({ line }) => line.includes("partialClone"));
        assert(created !== undefined, "the checkout is created in the container");
        assert.include(created.line, `'${WORKTREE}' '${CACHE}' 'https://github.com/acme/demo.git'`);
        assert(inContainer.some(({ line }) => line.includes("'claude' 'auth' 'status'")));
        assert(
          inContainer.some(({ line }) => line.includes("'git' 'log'")),
          "the harvest",
        );
        const onMachine = machine.state.calls.filter(({ container }) => container === undefined);
        assert(onMachine.some(({ line }) => line.includes(`'--git-dir' '${CACHE}' 'fetch'`)));
        assert(!onMachine.some(({ line }) => line.includes("'worktree' 'add'")));
        assert(!onMachine.some(({ line }) => line.includes(`'-C' '${WORKTREE}'`)));

        const lines = linesOf(machine);
        const marked = lines.findIndex((line) => line.includes(`'${MARKER}'`));
        const started = lines.findIndex(
          (line) => line.startsWith("exec 'docker' 'run' ") && line.includes(`'${CONTAINER}'`),
        );
        assert(marked >= 0 && marked < started, "the marker exists before the container");
        assert.deepStrictEqual([...machine.state.markers], [], "the marker goes with the checkout");
        const { checkoutGone, containerGone, credentialGone } = releaseSteps(machine);
        assert(
          checkoutGone >= 0 && containerGone > checkoutGone,
          "the container outlives the checkout",
        );
        assert(credentialGone > containerGone, "the credential outlives the container");
        assert.strictEqual(machine.state.containers.size, 0);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
    },
  );

  it.effect.each([
    {
      case: "one slot",
      slots: 1,
      memoryMib: Option.none(),
      limits: ["3.5", "7168m", "60976"],
      derived: "cpus,memoryMib,pids",
    },
    {
      case: "three slots",
      slots: 3,
      memoryMib: Option.none(),
      limits: ["1.16", "2389m", "20325"],
      derived: "cpus,memoryMib,pids",
    },
    {
      case: "three slots and memory_mib in usine.yaml",
      slots: 3,
      memoryMib: Option.some(ContainerMemoryMib.make(3072)),
      limits: ["1.16", "3072m", "20325"],
      derived: "cpus,pids",
    },
  ])(
    "derives the limits that usine.yaml leaves unset from a 4 CPU, 8 GiB machine with $case",
    ({ slots, memoryMib, limits, derived }) => {
      const machine = dockerMachine();
      const logs = capturedLogs();
      machine.state.memoryGib = 8;
      const address: SshWorkerAddress = {
        ...ADDRESS,
        container: { image: Option.none(), cpus: Option.none(), memoryMib, pids: Option.none() },
      };
      const limitsIn = (words: ReadonlyArray<string>) => [
        optionOf(words, "--cpus"),
        optionOf(words, "--memory"),
        optionOf(words, "--pids-limit"),
      ];
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], slots);
        assert(Option.isSome(report.containerLimits));
        const { cpus, memoryMib, pids } = report.containerLimits.value;
        assert.deepStrictEqual([String(cpus), `${memoryMib}m`, String(pids)], limits);
        const verified = logs.lines.find((line) => line.includes("SSH Worker preflight verified"));
        assert(verified !== undefined, "the preflight logged its outcome");
        assert.deepInclude(JSON.parse(verified)[1], {
          cpus,
          memoryMib,
          pids,
          derivedLimits: derived,
          slots,
          machineCpus: 4,
          machineMemoryMib: 8192,
          machineTasks: 62_000,
        });
        const probe = machine.state.calls.find(
          ({ line }) =>
            line.startsWith("exec 'docker' 'run' ") && line.includes("'usine-preflight-"),
        );
        assert(probe !== undefined, "the preflight's container started");
        assert.deepStrictEqual(limitsIn(wordsOf(probe.line)), limits);

        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert.deepStrictEqual(limitsIn(runOf(machine, CONTAINER).words), limits);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          executorLayer(machine, mintingProvider(), address).pipe(Layer.provide(noGateway)),
        ),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "mounts the Attempt's Codex home read-write when the Gateway holds the OpenAI credential, and removes it after the container",
    () => {
      const machine = dockerMachine();
      const gateway = fakeGateway(machine, {
        anthropic: Option.none(),
        openai: Option.some(
          new OpenAiProvider({
            upstream: UpstreamBase.make("https://chatgpt.com/backend-api/codex"),
            credential: new ChatGptLogin({
              authFile: HostFilePath.make("/var/lib/usine-gateway/codex-auth.json"),
              tokenUrl: UpstreamBase.make("https://auth.openai.com/oauth/token"),
            }),
          }),
        ),
      });
      const codexRequest = new CheckoutRequest({
        ...request,
        agent: new Agent({
          ...TEST_AGENT,
          brain: new BrainSpec({
            harness: "codex",
            model: ModelId.make("gpt-5.6-sol"),
            effort: "low",
          }),
        }),
      });
      const codexHome = `${WORKER_ROOT}/codex/remote-run_execute_1`;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(codexRequest);
        yield* prepared.launch(sink);

        const { words, input } = runOf(machine, CONTAINER);
        assert.include(input, `CODEX_HOME=${codexHome}\n`);
        assert.match(input, /^USINE_GATEWAY_TOKEN=ugw1\./mu);
        assert.include(
          mountsOf(words),
          `type=bind,"source=${codexHome}","destination=${codexHome}"`,
        );
        assert.include(machine.state.files.get(`${codexHome}/config.toml`) ?? "", "usine-gateway");
        const lines = linesOf(machine);
        const containerGone = lines.findIndex((line) =>
          line.startsWith(`exec 'docker' 'rm' '--force' '${CONTAINER}'`),
        );
        const homeGone = lines.findIndex((line) => line === `exec 'rm' '-rf' '${codexHome}'`);
        assert(
          homeGone > containerGone && containerGone >= 0,
          "the Codex home outlives the container",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["openai"] }),
          }),
        ),
      );
    },
  );

  it.effect(
    "gives the container the Gateway's caller token on docker run's standard input, and the SSH user's shell none",
    () => {
      const machine = dockerMachine();
      const gateway = fakeGateway(machine);
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);

        const { words, input } = runOf(machine, CONTAINER);
        const tokens = /^GH_TOKEN=(.+)$/mu.exec(input);
        assert(tokens?.[1] !== undefined, "the container gets the caller token");
        const callerToken = tokens[1];
        assert.include(input, `GIT_CONFIG_VALUE_0=x-usine-gateway-token: ${callerToken}\n`);
        assert.include(input, `ANTHROPIC_AUTH_TOKEN=${callerToken}\n`);
        assert.include(input, "HTTPS_PROXY=http://gw.test:3128\n");
        assert.includeMembers(mountsOf(words), [
          `type=bind,"source=${WORKER_ROOT}/gh","destination=${WORKER_ROOT}/gh",readonly`,
          `type=bind,"source=/run/usine-gateway","destination=/run/usine-gateway",readonly`,
        ]);
        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.strictEqual(given.host.sshEnvironment.GH_TOKEN, undefined);
        assert(!given.host.ssh.args.some((arg) => arg.startsWith("SendEnv=")));
        for (const { command, line } of machine.state.calls) {
          assert.notInclude(command.args.join(" "), callerToken);
          if (line.startsWith("exec 'docker' 'exec' ") || command.args.includes("-N")) continue;
          // Only the cached clone's fetch, as the SSH user, sends the caller token.
          if (command.options.env?.GH_TOKEN !== undefined)
            assert.notInclude(line, `'-C' '${WORKTREE}'`);
        }
        const children = machine.state.calls.filter(({ container }) => container === CONTAINER);
        for (const { command } of children)
          assert.strictEqual(command.options.env?.GH_TOKEN, undefined);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway, { parent })),
      );
    },
  );

  it.effect(
    "reports a machine without Docker as degraded and runs its Attempts as the SSH user",
    () => {
      const machine = fakeMachine();
      const logs = capturedLogs();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        assert.include(
          Option.getOrElse(report.degraded, () => ""),
          "Docker isn't installed",
        );
        assert.include(logs.lines.join("\n"), "SSH Worker has no Docker");
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.strictEqual(given.host.container, undefined);
        assert(linesOf(machine).some((line) => line.includes("'worktree' 'add'")));
        assert(!linesOf(machine).some((line) => line.startsWith("exec 'docker' 'run' ")));
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider(), parent)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "fails preflight when Docker doesn't answer, the image can't be pulled, or its user ID differs",
    () =>
      Effect.gen(function* () {
        const failureOf = (setup: (machine: ReturnType<typeof fakeMachine>) => void) => {
          const machine = dockerMachine();
          setup(machine);
          return Effect.gen(function* () {
            const executor = yield* Executor;
            return yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          }).pipe(Effect.flip, Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
        };
        const unusable = yield* failureOf((machine) => (machine.state.docker = "unusable"));
        const unpulled = yield* failureOf((machine) => {
          machine.state.pullFails = true;
          machine.state.imageOnMachine = false;
        });
        const otherUser = yield* failureOf((machine) => (machine.state.imageUserId = "1001"));
        for (const failure of [unusable, unpulled, otherUser]) {
          assert.strictEqual(failure._tag, "WorkerCapabilityError");
          if (failure._tag === "WorkerCapabilityError")
            assert.strictEqual(failure.capability, "container");
        }
        assert.include(unusable.message, "add the user to the docker group");
        assert.include(unpulled.message, `can't pull the attempt image ${ATTEMPT_IMAGE}`);
        assert.include(otherUser.message, "--build-arg USINE_UID=1000");

        const cached = dockerMachine();
        cached.state.pullFails = true;
        const report = yield* Effect.gen(function* () {
          const executor = yield* Executor;
          return yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        }).pipe(Effect.scoped, Effect.provide(runtime(cached, mintingProvider())));
        assert.isTrue(Option.isNone(report.degraded), "the image on the machine still runs");
      }),
  );

  it.effect(
    "ends an unsuccessful Attempt by stopping its children and salvaging in its container, then removes the checkout, the container, and the credential",
    () => {
      const machine = dockerMachine();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.salvage = "dirty";
        const prepared = yield* executor.prepare(request);
        const recorded: Array<AttemptSalvage> = [];
        yield* prepared
          .launch({ ...sink, salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)) })
          .pipe(Effect.flip);
        assert.strictEqual(recorded[0]?._tag, "Pushed");
        const salvage = machine.state.calls.flatMap(({ line, container }, index) =>
          line.includes(`'-C' '${WORKTREE}'`) ? [{ line, container, index }] : [],
        );
        for (const { line, container } of salvage)
          assert.strictEqual(container, CONTAINER, `${line} runs in the container`);
        const push = salvage.find(({ line }) => line.includes("'push' '--force'"));
        const { childrenStopped, checkoutGone, containerGone, credentialGone } =
          releaseSteps(machine);
        assertInOrder([
          ["the children's stop", childrenStopped],
          ["the salvage's first git command", salvage[0]?.index ?? -1],
          ["the salvage push", push?.index ?? -1],
          ["the checkout's removal", checkoutGone],
          ["the container's removal", containerGone],
          ["the credential's removal", credentialGone],
        ]);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), fails)));
    },
  );

  it.effect(
    "removes the containers an earlier process left before a Worker's first Attempt, and keeps a running Attempt's on a shared machine and another instance's",
    () => {
      const machine = dockerMachine();
      const leftover = (worker: string, instance = INSTANCE, instanceId: string = INSTANCE_ID) => ({
        args: [],
        labels: new Map([
          ["dev.usine.instance", instance],
          ["dev.usine.instance-id", instanceId],
          ["dev.usine.worker", worker],
        ]),
        environment: "",
        running: true,
        oomKills: 0,
      });
      machine.state.containers.set("usine-crashed", leftover(WORKER));
      machine.state.containers.set("usine-of-a-removed-worker", leftover("eu-gone"));
      machine.state.containers.set("usine-of-another-instance", leftover(WORKER, "github-app-7"));
      // Another instance folder with the same GitHub App, running on the same machine.
      machine.state.containers.set(
        "usine-of-an-instance-sharing-the-app",
        leftover(WORKER, INSTANCE, "5d0c9a1e-2f4b-4e8a-b7c6-3a9d1e0f2b8c"),
      );
      const second = WorkerName.make("eu-two");
      const secondRequest = new CheckoutRequest({
        ...request,
        attemptId: AttemptId.make("remote-run/execute/2"),
        worker: second,
        salvageRef: SalvageRef.make("usine/salvage/remote-run/2"),
      });
      const working = Deferred.makeUnsafe<void>();
      const done = Deferred.makeUnsafe<void>();
      const parent: StubParent = (context) =>
        Deferred.succeed(working, undefined).pipe(
          Effect.andThen(Deferred.await(done)),
          Effect.andThen(completes(context)),
        );
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const workers = yield* SshWorkers;
        const first = yield* executor.prepare(request).pipe(
          Effect.flatMap((prepared) => prepared.launch(sink)),
          Effect.scoped,
          Effect.forkChild,
        );
        yield* Deferred.await(working);
        assert.deepStrictEqual([...machine.state.containers.keys()].sort(), [
          "usine-of-an-instance-sharing-the-app",
          "usine-of-another-instance",
          CONTAINER,
        ]);

        yield* workers.addWorker({ ...ADDRESS, name: second });
        yield* Effect.scoped(executor.prepare(secondRequest));
        assert(machine.state.containers.has(CONTAINER), "the running Attempt keeps its container");
        yield* Deferred.succeed(done, undefined);
        yield* Fiber.join(first);
        assert.deepStrictEqual([...machine.state.containers.keys()].sort(), [
          "usine-of-an-instance-sharing-the-app",
          "usine-of-another-instance",
        ]);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
    },
  );

  /** Starts `request`'s Attempt in a process that stops while its parent runs, which keeps the checkout. */
  const stopWhileRunning = (
    machine: ReturnType<typeof fakeMachine>,
    credentials: ReturnType<typeof mintingProvider>,
    storage: StubStorage,
  ) => {
    const started = Deferred.makeUnsafe<void>();
    const working: StubParent = () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const launch = yield* (yield* executor.prepare(request)).launch(sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(launch);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, working, storage)));
  };

  /** Returns the calls since `before` that ran git in the checkout as the SSH user. */
  const hostGitInCheckout = (machine: ReturnType<typeof fakeMachine>, before: number) =>
    machine.state.calls
      .slice(before)
      .filter(
        ({ line, container }) =>
          container === undefined &&
          (line.includes(`'-C' '${WORKTREE}'`) ||
            (line.startsWith(`cd '${WORKTREE}'`) && line.includes("'git'"))),
      );

  it.effect(
    "reattaches in a new container with the new credential, even if the Attempt made its .git a file",
    () => {
      const machine = dockerMachine();
      const credentials = mintingProvider();
      const storage = new StubStorage();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        yield* stopWhileRunning(machine, credentials, storage);
        assert.strictEqual(machine.state.containers.size, 0, "a stopping process removes it");
        assert.deepStrictEqual([...machine.state.markers], [MARKER]);
        // A linked worktree's .git is a file; the Attempt could have written one.
        machine.state.linkedCheckout = true;

        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const before = machine.state.calls.length;
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          yield* prepared.launch(sink);
          const calls = machine.state.calls.slice(before);
          assert(!calls.some(({ line }) => line.includes("partialClone")), "the checkout stays");
          assert(given !== undefined && given.host instanceof RemoteShell);
          assert.deepStrictEqual(given.host.container, { runtime: "docker", name: CONTAINER });
          const restarted = calls.findIndex(({ line }) => line.startsWith("exec 'docker' 'run' "));
          const written = calls.findIndex(({ line }) => writesCredential(line));
          assert(restarted >= 0, "a new container starts");
          assert(written >= 0 && written < restarted, "after the new credential is written");
          assert.strictEqual(credentials.minted.length, 2);
          assert.deepStrictEqual(hostGitInCheckout(machine, before), []);
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, parent, storage)));
        assert.strictEqual(machine.state.containers.size, 0);
      });
    },
  );

  it.effect(
    "salvages a crashed Attempt's checkout in a container, even if the Attempt made its .git a file",
    () => {
      const machine = dockerMachine();
      const credentials = mintingProvider();
      return Effect.gen(function* () {
        yield* stopWhileRunning(machine, credentials, new StubStorage());
        machine.state.linkedCheckout = true;
        machine.state.salvage = "dirty";
        const before = machine.state.calls.length;
        const recorded: Array<AttemptSalvage> = [];
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.recover(
            {
              attemptId: request.attemptId,
              repository: request.repository,
              worker: WORKER,
              ref: request.salvageRef,
              permissions: "write",
              succeeded: false,
              open: false,
              rejected: Option.none(),
            },
            {
              salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
              comments: () => Effect.void,
              windows: aloneOnItem(),
            },
            Effect.succeed(request.commitAuthor),
          );
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials)));
        assert.strictEqual(recorded[0]?._tag, "Pushed");
        const push = machine.state.calls.find(({ line }) => line.includes("'push' '--force'"));
        assert.strictEqual(push?.container, CONTAINER);
        assert.deepStrictEqual(hostGitInCheckout(machine, before), []);
        assert.deepStrictEqual([...machine.state.markers], []);
      });
    },
  );

  it.effect(
    "derives the limits for one Attempt, and logs them, when a container starts before any preflight on the Worker",
    () => {
      const machine = dockerMachine();
      const credentials = mintingProvider();
      const logs = capturedLogs();
      machine.state.memoryGib = 8;
      const address: SshWorkerAddress = {
        ...ADDRESS,
        container: {
          image: Option.none(),
          cpus: Option.none(),
          memoryMib: Option.none(),
          pids: Option.none(),
        },
      };
      return Effect.gen(function* () {
        yield* stopWhileRunning(machine, credentials, new StubStorage());
        const before = machine.state.calls.length;
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.recover(
            {
              attemptId: request.attemptId,
              repository: request.repository,
              worker: WORKER,
              ref: request.salvageRef,
              permissions: "write",
              succeeded: false,
              open: false,
              rejected: Option.none(),
            },
            { salvage: () => Effect.void, comments: () => Effect.void, windows: aloneOnItem() },
            Effect.succeed(request.commitAuthor),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            executorLayer(machine, credentials, address).pipe(Layer.provide(noGateway)),
          ),
          Effect.provide(logs.layer),
        );
        assert.lengthOf(
          linesOf(machine)
            .slice(before)
            .filter((line) => line.includes("nproc")),
          1,
          "the recovery read the machine once",
        );
        const contained = logs.lines.find((line) =>
          line.includes("SSH Worker runs each Attempt in its own container"),
        );
        assert(contained !== undefined, "the recovery logged the limits it applied");
        assert.deepInclude(JSON.parse(contained)[1], {
          worker: WORKER,
          cpus: 3.5,
          memoryMib: 7168,
          pids: 60_976,
          derivedLimits: "cpus,memoryMib,pids",
          slots: 1,
          machineCpus: 4,
          machineMemoryMib: 8192,
          machineTasks: 62_000,
        });
        assert.notInclude(logs.lines.join("\n"), "SSH Worker preflight verified");
      });
    },
  );

  it.effect(
    "records the processes the kernel killed in the Attempt's container for memory before it removes the container",
    () => {
      const machine = dockerMachine();
      // The kernel kills the largest processes, such as a test runner, and the container runs on.
      const exceedsMemory: StubParent = (context) =>
        Effect.sync(() => {
          const container = machine.state.containers.get(CONTAINER);
          if (container !== undefined) container.oomKills = 2;
        }).pipe(Effect.andThen(completes(context)));
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const kills: Array<OutOfMemoryKills> = [];
        yield* prepared.launch({
          ...sink,
          outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
        });
        assert.deepStrictEqual(
          kills.map(({ kills, memoryMib }) => ({ kills, memoryMib })),
          [{ kills: 2, memoryMib: 4096 }],
        );
        const { childrenStopped, containerGone } = releaseSteps(machine);
        assertInOrder([
          ["the children's stop", childrenStopped],
          ["the kills' read", killsRead(machine)],
          ["the container's removal", containerGone],
        ]);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), exceedsMemory)));
    },
  );

  it.effect(
    "salvages an Attempt whose container stopped, such as after an out-of-memory kill, in the container started again",
    () => {
      const machine = dockerMachine();
      const logs = capturedLogs();
      // The children die with the container: the kernel killed it for memory, or a test signaled
      // its init (#575).
      const stopsItsContainer: StubParent = (context) =>
        Effect.sync(() => {
          const container = machine.state.containers.get(CONTAINER);
          if (container !== undefined) container.running = false;
        }).pipe(Effect.andThen(fails(context)));
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.salvage = "dirty";
        const prepared = yield* executor.prepare(request);
        const recorded: Array<AttemptSalvage> = [];
        const kills: Array<OutOfMemoryKills> = [];
        yield* prepared
          .launch({
            ...sink,
            salvage: (salvage) => Effect.sync(() => void recorded.push(salvage)),
            outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
          })
          .pipe(Effect.flip);
        assert.strictEqual(recorded[0]?._tag, "Pushed");
        assert.deepStrictEqual(
          kills.map(({ kills, memoryMib }) => ({ kills, memoryMib })),
          [{ kills: 1, memoryMib: 4096 }],
          "the start for the salvage doesn't lose the killed init",
        );
        const lines = linesOf(machine);
        const push = lines.findIndex((line) => line.includes("'push' '--force'"));
        assert.strictEqual(machine.state.calls[push]?.container, CONTAINER);
        const { childrenStopped, containerGone } = releaseSteps(machine);
        assertInOrder([
          ["the children's stop", childrenStopped],
          ["the container's start", lines.indexOf(`exec 'docker' 'start' '${CONTAINER}'`)],
          ["the salvage push", push],
          ["the container's removal", containerGone],
        ]);
        assert.deepStrictEqual(hostGitInCheckout(machine, 0), []);
        assert(
          logs.lines.some(
            (line) => line.includes("starting it again") && line.includes('"oomKilled":"true"'),
          ),
          "the log says why the container stopped",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider(), stopsItsContainer)),
        Effect.provide(logs.layer),
      );
    },
  );

  for (const change of ["docker-installed", "docker-removed"] as const)
    it.effect(
      change === "docker-installed"
        ? "refuses to reattach a checkout from before Docker, since the SSH user can now use Docker"
        : "refuses to reattach a container's checkout as the SSH user once the machine has no Docker",
      () => {
        const machine = change === "docker-installed" ? fakeMachine() : dockerMachine();
        const credentials = mintingProvider();
        const storage = new StubStorage();
        return Effect.gen(function* () {
          yield* stopWhileRunning(machine, credentials, storage);
          machine.state.docker = change === "docker-installed" ? "running" : "absent";
          const before = machine.state.calls.length;
          const failure = yield* Effect.gen(function* () {
            const executor = yield* Executor;
            return yield* executor.prepare(new CheckoutRequest({ ...request, reattach: true }));
          }).pipe(
            Effect.flip,
            Effect.scoped,
            Effect.provide(runtime(machine, credentials, completes, storage)),
          );
          assert.include(
            failure.message,
            change === "docker-installed"
              ? "is from before the machine had Docker"
              : "no longer has Docker",
          );
          const calls = machine.state.calls.slice(before);
          assert(!calls.some(({ line }) => line.startsWith("exec 'docker' 'run' ")));
          assert.deepStrictEqual(hostGitInCheckout(machine, before), []);
        });
      },
    );

  it.effect(
    "fails preflight when the SSH user is in the docker group but has no docker CLI",
    () => {
      const machine = dockerMachine();
      machine.state.docker = "socket-only";
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const failure = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1).pipe(Effect.flip);
        assert(failure._tag === "WorkerCapabilityError");
        assert.strictEqual(failure.capability, "container");
        assert.include(failure.message, "can use Docker's socket");
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
    },
  );
});
