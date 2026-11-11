import { assert, describe, it } from "@effect/vitest";
import { CHILD_KILL_SCRIPT, HostUnreachable, RemoteShell } from "@usine/agents/child-host";
import { Agent } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AttemptId,
  MAX_KILLED_PROCESSES,
  MemoryKilledProcess,
  type ContainerOutOfMemoryKills,
} from "@usine/core/attempt";
import { type AttemptSalvage, SalvageRef } from "@usine/core/attempt/salvage";
import { ContainerId, ContainerMemoryMib, SshDestination, WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { ChatGptLogin, HostFilePath, OpenAiProvider, UpstreamBase } from "@usine/gateway";
import { Deferred, Effect, Fiber, Layer, Option, References, Schema } from "effect";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import { ATTEMPT_IMAGE, type SshWorkerAddress, SshWorkers } from "../../src/ssh/ssh.ts";
import { fakeGateway, gatewayAddress, gatewayRuntime } from "./gateway/support.ts";
import {
  ADDRESS,
  aloneOnItem,
  capturedLogs,
  CapturedLog,
  CREDENTIALS,
  DESTINATION,
  executorLayer,
  fails,
  fakeContainerId,
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
    containerGone: lines.indexOf(`exec 'docker' 'rm' '--force' '--volumes' '${CONTAINER}'`),
    credentialGone: lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`),
  };
};

/** Returns the index of the call that read the container's out-of-memory kills, or -1. */
const killsRead = (machine: ReturnType<typeof fakeMachine>) =>
  linesOf(machine).findIndex((line) => line.includes("memory.events"));

/**
 * Makes the kernel kill `kills` processes for memory in the Attempt's running container, and
 * returns the container's ID.
 */
const killsInContainer = (machine: ReturnType<typeof fakeMachine>, kills: number) =>
  Effect.sync(() => {
    const container = machine.state.containers.get(CONTAINER);
    assert(container !== undefined, "the Attempt's container runs");
    container.oomKills = kills;
    return container.id;
  });

/** Asserts that each named call index exists and comes after the one before it. */
const assertInOrder = (steps: ReadonlyArray<readonly [string, number]>) =>
  steps.forEach(([name, index], position) => {
    assert(index >= 0, `${name} didn't run`);
    const previous = steps[position - 1];
    if (previous !== undefined) assert(index > previous[1], `${name} ran before ${previous[0]}`);
  });

describe("SSH Worker with Docker", () => {
  it("defaults to the generated image tag that CI publishes", () => {
    const tag = readFileSync(
      new URL("../../../../infra/worker-image/tag.txt", import.meta.url),
      "utf8",
    ).trim();
    assert.strictEqual(ATTEMPT_IMAGE, `ghcr.io/basaltbytes/usine-worker:${tag}`);
  });

  it.effect.each([
    { present: true, changed: false },
    { present: false, changed: false },
    { present: true, changed: true },
  ])(
    "reports image presence and whether preflight downloaded it: $present, $changed",
    ({ present, changed }) => {
      const machine = dockerMachine();
      machine.state.imageOnMachine = present;
      if (changed) machine.state.pulledImageId = "sha256:4567";
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        const inspections = logs.lines.filter((line) =>
          line.includes("Inspected the attempt image"),
        );
        assert.include(inspections[0] ?? "", `"status":"${present ? "present" : "absent"}"`);
        assert.include(inspections[0] ?? "", '"durationMillis":');
        const pulls = logs.lines.filter((line) => line.includes("Pulled the attempt image"));
        assert.lengthOf(pulls, 1);
        const json1 = yield* Schema.decodeEffect(CapturedLog)(pulls[0] ?? "").pipe(Effect.orDie);
        assert.deepInclude(json1[1], {
          image: ATTEMPT_IMAGE,
          downloaded: !present || changed,
          durationMillis: 0,
        });
        assert.lengthOf(
          linesOf(machine).filter((line) => line.startsWith("exec 'docker' 'pull' ")),
          1,
        );
        assert.lengthOf(
          logs.warnings.filter((line) => line.includes("image is absent")),
          present ? 0 : 1,
        );
        const cache = logs.lines.find((line) => line.includes("Prepared shared cache volume"));
        const json2 = yield* Schema.decodeEffect(CapturedLog)(cache ?? "").pipe(Effect.orDie);
        assert.deepInclude(json2[1], {
          runDurationMillis: 17,
          durationMillis: 0,
        });
        assert.include(logs.lines.join("\n"), "Ran the attempt image user probe");
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect.each(["1793637391N\n", "17936373913N\n", "\n", "-1\n", "1.5\n"])(
    "prepares shared caches without a run duration when the shell prints %j",
    (stdout) => {
      const machine = dockerMachine();
      machine.state.cachePreparationDuration = stdout;
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        const prepared = logs.lines.filter((line) => line.includes("Prepared shared cache volume"));
        assert.lengthOf(prepared, 2);
        for (const line of prepared) {
          const json3 = yield* Schema.decodeEffect(CapturedLog)(line).pipe(Effect.orDie);
          const fields = json3[1];
          assert.notProperty(fields, "runDurationMillis");
          assert.property(fields, "durationMillis");
        }
        const unreadable = logs.lines.filter((line) =>
          line.includes("Could not read the shared cache container run duration"),
        );
        assert.lengthOf(unreadable, 2);
        for (const line of unreadable) {
          const json4 = yield* Schema.decodeEffect(CapturedLog)(line).pipe(Effect.orDie);
          assert.strictEqual(json4[1].stdout, stdout);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    },
  );

  it.effect.each([true, false])(
    "checks the image before cache initialization without preflight: present=%s",
    (present) => {
      const machine = dockerMachine();
      machine.state.imageOnMachine = present;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.prepare(request);
        const lines = linesOf(machine);
        const inspect = lines.findIndex((line) =>
          line.startsWith("exec 'docker' 'image' 'inspect'"),
        );
        const cache = lines.findIndex((line) => line.includes("volume create"));
        assert.isAtLeast(inspect, 0);
        assert.isAbove(cache, inspect);
        const pulls = lines.filter((line) => line.startsWith("exec 'docker' 'pull'"));
        assert.lengthOf(pulls, present ? 0 : 1);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
    },
  );

  it.effect(
    "runs the Attempt's commands in its own container with its paths and shared cache volumes",
    () => {
      const machine = dockerMachine();
      machine.state.hostUserId = "2345";
      machine.state.imageUserId = "2345";
      const logs = capturedLogs();
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
        assert.include(logs.lines.join("\n"), '"sizeKiB":4096');
        assert.include(linesOf(machine), `exec 'docker' 'pull' '--quiet' '${ATTEMPT_IMAGE}'`);
        const probes = machine.state.calls.filter(({ line }) => line.includes("'claude'"));
        assert.isNotEmpty(probes);
        for (const { container } of probes)
          assert.match(container ?? "", /^usine-preflight-eu-one-\d+$/u);
        assert.strictEqual(machine.state.containers.size, 0, "the preflight's container is gone");

        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);

        assert(given !== undefined && Schema.is(RemoteShell)(given.host));
        assert.deepStrictEqual(given.host.container, { runtime: "docker", name: CONTAINER });
        assert.deepStrictEqual(running, [CONTAINER]);
        const { words, input } = runOf(machine, CONTAINER);
        assert.strictEqual(optionOf(words, "--network"), "host");
        assert.strictEqual(optionOf(words, "--memory-swap"), optionOf(words, "--memory"));
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
        assert.deepStrictEqual(
          words.flatMap((word, index) => (words[index - 1] === "--volume" ? [word] : [])),
          [
            "usine-pnpm-store:/home/usine/.local/share/pnpm/store:nocopy",
            "usine-turbo-cache:/home/usine/.cache/turbo:nocopy",
          ],
        );
        assert.deepStrictEqual(mountsOf(words), [
          `type=tmpfs,"destination=${WORKER_ROOT}/attempts",tmpfs-mode=1777`,
          `type=bind,"source=${WORKTREE}","destination=${WORKTREE}"`,
          `type=bind,"source=${CACHE}","destination=${CACHE}",readonly`,
          `type=bind,"source=${CREDENTIALS}","destination=${CREDENTIALS}",readonly`,
          `type=bind,"source=${WORKER_ROOT}/claude/remote-run_execute_1","destination=/home/usine/.claude/projects"`,
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
        assert.lengthOf(
          linesOf(machine).filter((line) => line.includes("volume create")),
          2,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtime(machine, mintingProvider(), parent).pipe(Layer.provideMerge(logs.layer)),
        ),
      );
    },
  );

  it.effect.each([
    { slots: 3, memoryMib: 7168, warns: true },
    { slots: 2, memoryMib: 3584, warns: false },
    { slots: 1, memoryMib: 7169, warns: true },
  ])(
    "checks fully configured container memory against the host reserve: $slots × $memoryMib",
    ({ slots, memoryMib, warns }) => {
      const machine = dockerMachine();
      machine.state.memoryGib = 8;
      const logs = capturedLogs();
      const address: SshWorkerAddress = {
        ...ADDRESS,
        container: {
          ...ADDRESS.container,
          memoryMib: Option.some(ContainerMemoryMib.make(memoryMib)),
        },
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], slots);
        const warnings = logs.lines.filter((line) =>
          line.includes("Concurrent container memory exceeds"),
        );
        assert.lengthOf(warnings, warns ? 1 : 0);
        for (const warning of warnings) {
          const json5 = yield* Schema.decodeEffect(CapturedLog)(warning).pipe(Effect.orDie);
          assert.deepInclude(json5[1], {
            worker: WORKER,
            maxConcurrentAttempts: slots,
            memoryMib,
            allocatedMemoryMib: slots * memoryMib,
            availableMemoryMib: 7168,
            hostReserveMib: 1024,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          executorLayer(machine, mintingProvider(), address).pipe(
            Layer.provide(noGateway),
            Layer.provideMerge(logs.layer),
          ),
        ),
      );
    },
  );

  it.effect.each([
    {
      case: "one slot",
      slots: 1,
      memoryMib: Option.none(),
      limits: ["4", "7168m", "60976"],
      derived: "cpus,memoryMib,pids",
    },
    {
      case: "three slots",
      slots: 3,
      memoryMib: Option.none(),
      limits: ["1.33", "2389m", "20325"],
      derived: "cpus,memoryMib,pids",
    },
    {
      case: "three slots and memory_mib in usine.yaml",
      slots: 3,
      memoryMib: Option.some(ContainerMemoryMib.make(3072)),
      limits: ["1.33", "3072m", "20325"],
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
        container: {
          ...ADDRESS.container,
          image: Option.none(),
          cpus: Option.none(),
          memoryMib,
          pids: Option.none(),
        },
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
        const json6 = yield* Schema.decodeEffect(CapturedLog)(verified).pipe(Effect.orDie);
        assert.deepInclude(json6[1], {
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
          executorLayer(machine, mintingProvider(), address).pipe(
            Layer.provide(noGateway),
            Layer.provideMerge(logs.layer),
          ),
        ),
      );
    },
  );

  it.effect.each(["readable", "unreadable", "disconnects"] as const)(
    "reports a kernel log that the SSH user can't read as a preflight finding: %s",
    (kernelMemory) => {
      const machine = dockerMachine();
      machine.state.kernelMemory = kernelMemory;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        assert.isTrue(Option.isNone(report.degraded));
        if (kernelMemory === "readable") assert.deepStrictEqual(report.findings, []);
        else if (kernelMemory === "unreadable") {
          assert.strictEqual(report.findings.length, 1);
          assert.include(report.findings[0], "can't read the kernel journal or ring buffer");
          assert.include(report.findings[0], "systemd-journal");
        } else {
          assert.strictEqual(report.findings.length, 1);
          assert.include(
            report.findings[0],
            `Could not check whether the SSH user can read the kernel log on ${DESTINATION}`,
          );
          assert.include(report.findings[0], "closed by remote host");
        }
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
    },
  );

  it.effect("reports a machine that SSH can't reach while reading its resources", () => {
    const machine = dockerMachine();
    machine.state.resourcesDisconnect = true;
    const address: SshWorkerAddress = {
      ...ADDRESS,
      container: { ...ADDRESS.container, cpus: Option.none(), pids: Option.none() },
    };
    return Effect.gen(function* () {
      const error = yield* (yield* Executor)
        .preflight(WORKER, [TEST_AGENT.brain], 1)
        .pipe(Effect.flip);
      assert(error._tag === "WorkerCapabilityError", error._tag);
      assert.strictEqual(error.capability, "container");
      assert.strictEqual(
        error.message,
        `Can't reach SSH worker "${WORKER}" at ${DESTINATION} to read its CPUs and memory`,
      );
      assert(Schema.is(HostUnreachable)(error.cause));
      assert.strictEqual(error.cause.message, "Connection to 203.0.113.7 closed by remote host.");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        executorLayer(machine, mintingProvider(), address).pipe(Layer.provide(noGateway)),
      ),
    );
  });

  it.effect(
    "mounts the Attempt's Codex home read-write when the Gateway holds the OpenAI credential, and removes it after the container",
    () => {
      const machine = dockerMachine();
      const gateway = fakeGateway(machine, {
        "anthropic-messages": Option.none(),
        "openai-responses": Option.some(
          OpenAiProvider.make({
            upstream: UpstreamBase.make("https://chatgpt.com/backend-api/codex"),
            credential: ChatGptLogin.make({
              authFile: HostFilePath.make("/var/lib/usine-gateway/codex-auth.json"),
              tokenUrl: UpstreamBase.make("https://auth.openai.com/oauth/token"),
            }),
          }),
        ),
      });
      const codexRequest = CheckoutRequest.make({
        ...request,
        agent: Agent.make({
          ...TEST_AGENT,
          brain: BrainSpec.make({
            harness: Harness.make("codex"),
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
          line.startsWith(`exec 'docker' 'rm' '--force' '--volumes' '${CONTAINER}'`),
        );
        const homeGone = lines.findIndex(
          (line) => line.includes('rm -rf "$1"') && line.includes(codexHome),
        );
        assert(
          homeGone > containerGone && containerGone >= 0,
          "the Codex home outlives the container",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, {
            address: gatewayAddress({ llmProviders: ["openai-responses"] }),
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
        assert(given !== undefined && Schema.is(RemoteShell)(given.host));
        assert.strictEqual(given.host.sshEnvironment.GH_TOKEN, undefined);
        assert.isUndefined(given.host.stdinEnvironment);
        for (const { command, line, stdinEnvironment } of machine.state.calls) {
          assert.notInclude(command.args.join(" "), callerToken);
          assert.strictEqual(command.options.env?.GH_TOKEN, undefined);
          if (line.startsWith("exec 'docker' 'exec' ") || command.args.includes("-N")) continue;
          // Only the cached clone's fetch, as the SSH user, sends the caller token.
          if (stdinEnvironment.GH_TOKEN !== undefined)
            assert.notInclude(line, `'-C' '${WORKTREE}'`);
        }
        assert(
          machine.state.calls.some(
            ({ stdinEnvironment }) => stdinEnvironment.GH_TOKEN !== undefined,
          ),
          "the cached clone's fetch sends the caller token",
        );
        const children = machine.state.calls.filter(({ container }) => container === CONTAINER);
        for (const { stdinEnvironment } of children)
          assert.strictEqual(stdinEnvironment.GH_TOKEN, undefined);
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
          "Neither Podman nor Docker is installed",
        );
        assert.include(logs.lines.join("\n"), "SSH Worker has no Docker or Podman");
        assert.deepStrictEqual(report.findings, [], "no container records OOM kills");
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert(given !== undefined && Schema.is(RemoteShell)(given.host));
        assert.strictEqual(given.host.container, undefined);
        assert(linesOf(machine).some((line) => line.includes("'worktree' 'add'")));
        assert(!linesOf(machine).some((line) => line.startsWith("exec 'docker' 'run' ")));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtime(machine, mintingProvider(), parent).pipe(Layer.provideMerge(logs.layer)),
        ),
      );
    },
  );

  it.effect.each(["usine-pnpm-store", "usine-turbo-cache"])(
    "refuses container startup when %s initialization fails without a preceding preflight",
    (volume) => {
      const machine = dockerMachine();
      machine.state.cachePreparationFailure = volume;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const failure = yield* executor.prepare(request).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ExecutorOperationError");
        assert.include(failure.message, "permission denied");
        assert.include(failure.message, volume);
        assert.strictEqual(machine.state.containers.size, 0);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
    },
  );

  it.effect(
    "fails preflight when Docker doesn't answer, the image user ID differs, or cache preparation fails",
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
        const otherUser = yield* failureOf((machine) => (machine.state.hostUserId = "2345"));
        const storeFailed = yield* failureOf(
          (machine) => (machine.state.cachePreparationFailure = "usine-pnpm-store"),
        );
        const turboFailed = yield* failureOf(
          (machine) => (machine.state.cachePreparationFailure = "usine-turbo-cache"),
        );
        const invalidSize = yield* failureOf((machine) => (machine.state.storeSizeKiB = "invalid"));
        for (const failure of [unusable, otherUser, storeFailed, turboFailed, invalidSize]) {
          assert.strictEqual(failure._tag, "WorkerCapabilityError");
          if (failure._tag === "WorkerCapabilityError")
            assert.strictEqual(failure.capability, "container");
        }
        assert.include(unusable.message, "add the user to the docker group");
        assert.include(otherUser.message, "--build-arg USINE_UID=2345");
        assert.include(storeFailed.message, "usine-pnpm-store");
        assert.include(turboFailed.message, "usine-turbo-cache");
        assert.include(invalidSize.message, "Can't measure the shared pnpm store");

        const cached = dockerMachine();
        cached.state.pullError = "Error response from daemon: Get https://ghcr.io/v2/: timeout";
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
          line.includes(`'-C' '${WORKTREE}'`) && !line.includes("'update-ref'")
            ? [{ line, container, index }]
            : [],
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
    "removes the containers an earlier process left before a Worker's first Attempt, and keeps active resources across SSH login aliases and other workers",
    () => {
      const machine = dockerMachine();
      const leftover = (worker: string, instance = INSTANCE, instanceId: string = INSTANCE_ID) => ({
        id: fakeContainerId((machine.state.containersCreated += 1)),
        args: [],
        labels: new Map([
          ["dev.usine.instance", instance],
          ["dev.usine.instance-id", instanceId],
          ["dev.usine.worker", worker],
        ]),
        environment: "",
        running: true,
        initKilledForMemory: true,
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
      const secondRequest = CheckoutRequest.make({
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

        yield* workers.addWorker({
          ...ADDRESS,
          machine: {
            _tag: "Fixed",
            tailnet: Option.none(),
            destination: SshDestination.make("other@203.0.113.7"),
          },
        });
        yield* Effect.scoped(
          executor.prepare(CheckoutRequest.make({ ...secondRequest, worker: WORKER })),
        );
        assert(
          machine.state.containers.has(CONTAINER),
          "an SSH login alias keeps the active container",
        );
        assert(
          machine.state.credentials.has(CREDENTIALS),
          "an SSH login alias keeps the active credential",
        );
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
            CheckoutRequest.make({ ...request, reattach: true }),
          );
          yield* prepared.launch(sink);
          const calls = machine.state.calls.slice(before);
          assert(!calls.some(({ line }) => line.includes("partialClone")), "the checkout stays");
          assert(given !== undefined && Schema.is(RemoteShell)(given.host));
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
    "records the processes the kernel killed in the container of a stopping process apart from those in the container that reattaches the Attempt",
    () => {
      const machine = dockerMachine();
      machine.state.kernelMemory = "readable";
      const credentials = mintingProvider();
      const storage = new StubStorage();
      const kills: Array<ContainerOutOfMemoryKills> = [];
      const recording = {
        ...sink,
        outOfMemory: (killed: ContainerOutOfMemoryKills) =>
          Effect.sync(() => void kills.push(killed)),
      };
      const ran: Array<string> = [];
      const killed = (count: number) =>
        killsInContainer(machine, count).pipe(Effect.tap((id) => Effect.sync(() => ran.push(id))));
      const started = Deferred.makeUnsafe<void>();
      const stops: StubParent = () =>
        killed(2).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
        );
      const reattached: StubParent = (context) =>
        killed(1).pipe(Effect.andThen(completes(context)));
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const launch = yield* (yield* executor.prepare(request))
            .launch(recording)
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(launch);
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, stops, storage)));
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const prepared = yield* executor.prepare(
            CheckoutRequest.make({ ...request, reattach: true }),
          );
          yield* prepared.launch(recording);
        }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, reattached, storage)));

        assert.strictEqual(
          new Set(ran).size,
          2,
          "reattachment runs the Attempt in a new container",
        );
        assert.deepStrictEqual(
          kills.map(({ processes }) => processes),
          [
            [MemoryKilledProcess.make({ command: "vitest worker", pid: 1234 })],
            [MemoryKilledProcess.make({ command: "vitest worker", pid: 1234 })],
          ],
        );
        assert.deepStrictEqual(
          kills.map(({ container, kills }) => ({ container, kills })),
          [
            { container: ran[0], kills: 2 },
            { container: ran[1], kills: 1 },
          ],
        );
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
          shmSizeMib: Option.none(),
          tmpfsSizeMib: Option.none(),
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
            executorLayer(machine, credentials, address).pipe(
              Layer.provide(noGateway),
              Layer.provideMerge(logs.layer),
            ),
          ),
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
        const json7 = yield* Schema.decodeEffect(CapturedLog)(contained).pipe(Effect.orDie);
        assert.deepInclude(json7[1], {
          worker: WORKER,
          cpus: 4,
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
      let ran: string | undefined;
      // The kernel kills the largest processes, such as a test runner, and the container runs on.
      const exceedsMemory: StubParent = (context) =>
        killsInContainer(machine, 2).pipe(
          Effect.tap((id) => Effect.sync(() => void (ran = id))),
          Effect.andThen(completes(context)),
        );
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared.launch({
          ...sink,
          outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
        });
        assert.deepStrictEqual(
          kills.map(({ container, kills, memoryMib }) => ({ container, kills, memoryMib })),
          [{ container: ran, kills: 2, memoryMib: 4096 }],
        );
        assert.deepStrictEqual(
          kills[0]?.processes,
          [],
          "unreadable host logs preserve the counter",
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
        const kills: Array<ContainerOutOfMemoryKills> = [];
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
        Effect.provide(
          runtime(machine, mintingProvider(), stopsItsContainer).pipe(
            Layer.provideMerge(logs.layer),
          ),
        ),
      );
    },
  );

  it.effect(
    "records a process the kernel killed for memory before a start for another reason reset the container's counter",
    () => {
      const machine = dockerMachine();
      machine.state.kernelMemory = "readable";
      // The kernel kills a test runner, then a test signals the container's init.
      const killsThenStops: StubParent = (context) =>
        killsInContainer(machine, 1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const container = machine.state.containers.get(CONTAINER);
              assert(container !== undefined, "the Attempt's container runs");
              container.running = false;
              container.initKilledForMemory = false;
            }),
          ),
          Effect.andThen(fails(context)),
        );
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.salvage = "dirty";
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared
          .launch({
            ...sink,
            outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          kills.map(({ kills, processes }) => ({ kills, processes })),
          [
            {
              kills: 1,
              processes: [MemoryKilledProcess.make({ command: "vitest worker", pid: 1234 })],
            },
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), killsThenStops)));
    },
  );

  it.effect.each([MAX_KILLED_PROCESSES, MAX_KILLED_PROCESSES + 1])(
    "records at most the cap of killed processes and the whole count when the kernel logs name %i",
    (victims) => {
      const machine = dockerMachine();
      machine.state.kernelMemory = "readable";
      machine.state.kernelVictims = victims;
      const exceedsMemory: StubParent = (context) =>
        killsInContainer(machine, victims).pipe(Effect.andThen(completes(context)));
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared.launch({
          ...sink,
          outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
        });
        assert.strictEqual(kills.length, 1);
        assert.strictEqual(kills[0]?.kills, victims);
        assert.deepStrictEqual(
          kills[0]?.processes,
          Array.from({ length: MAX_KILLED_PROCESSES }, (_, index) =>
            MemoryKilledProcess.make({ command: "vitest worker", pid: 1234 + index }),
          ),
        );
        const capped = logs.warnings.filter((line) =>
          line.includes("Recording only the first killed processes"),
        );
        if (victims <= MAX_KILLED_PROCESSES) assert.lengthOf(capped, 0);
        else {
          assert.lengthOf(capped, 1);
          const [, fields] = yield* Schema.decodeEffect(CapturedLog)(capped[0] ?? "").pipe(
            Effect.orDie,
          );
          assert.deepInclude(fields, { identified: victims, kept: MAX_KILLED_PROCESSES });
        }
        const read = logs.infos.filter((line) =>
          line.includes("Read the kernel OOM process details on the worker"),
        );
        assert.lengthOf(read, 1);
        const [, readFields] = yield* Schema.decodeEffect(CapturedLog)(read[0] ?? "").pipe(
          Effect.orDie,
        );
        assert.deepInclude(readFields, { source: "journal", identified: victims });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtime(machine, mintingProvider(), exceedsMemory).pipe(Layer.provideMerge(logs.layer)),
        ),
      );
    },
  );

  it.effect(
    "keeps the counted kills and names the container and host when SSH drops the kernel log read",
    () => {
      const machine = dockerMachine();
      machine.state.kernelMemory = "disconnects";
      let ran: string | undefined;
      const exceedsMemory: StubParent = (context) =>
        killsInContainer(machine, 2).pipe(
          Effect.tap((id) => Effect.sync(() => void (ran = id))),
          Effect.andThen(completes(context)),
        );
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared.launch({
          ...sink,
          outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
        });
        assert.deepStrictEqual(
          kills.map(({ container, kills, processes }) => ({ container, kills, processes })),
          [{ container: ContainerId.make(ran ?? ""), kills: 2, processes: [] }],
        );
        const dropped = logs.warnings.filter((line) =>
          line.includes("Could not collect kernel OOM process details"),
        );
        assert.lengthOf(dropped, 1);
        const [, fields] = yield* Schema.decodeEffect(CapturedLog)(dropped[0] ?? "").pipe(
          Effect.orDie,
        );
        assert.deepInclude(fields, { container: ran, host: DESTINATION });
        assert.include(String(fields["message"]), "closed by remote host");
        const { containerGone } = releaseSteps(machine);
        assertInOrder([
          ["the kills' read", killsRead(machine)],
          ["the container's removal", containerGone],
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtime(machine, mintingProvider(), exceedsMemory).pipe(Layer.provideMerge(logs.layer)),
        ),
      );
    },
  );

  it.effect.each(["no-kills", "unreadable"] as const)(
    "records nothing and says why when the kernel logs name no kill before a start: %s",
    (kernelMemory) => {
      const machine = dockerMachine();
      machine.state.kernelMemory = kernelMemory;
      // A test signals the container's init; the kernel killed nothing.
      const stops: StubParent = (context) =>
        Effect.sync(() => {
          const container = machine.state.containers.get(CONTAINER);
          assert(container !== undefined, "the Attempt's container runs");
          container.running = false;
          container.initKilledForMemory = false;
        }).pipe(Effect.andThen(fails(context)));
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        machine.state.salvage = "dirty";
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared
          .launch({
            ...sink,
            outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
          })
          .pipe(Effect.flip);
        assert.deepStrictEqual(kills, []);
        assert(linesOf(machine).some((line) => line.includes("journalctl -k")));
        const skip =
          kernelMemory === "unreadable"
            ? "The kernel logs are unreadable, so no process killed in the container before its starts is recorded"
            : "The kernel logs name no process killed in the container before its starts";
        assert.lengthOf(
          logs.infos.filter((line) => line.includes(skip)),
          1,
        );
        const read = logs.infos.filter((line) =>
          line.includes("Read the kernel OOM process details on the worker"),
        );
        if (kernelMemory === "unreadable") assert.lengthOf(read, 0);
        else {
          assert.lengthOf(read, 1);
          const [, fields] = yield* Schema.decodeEffect(CapturedLog)(read[0] ?? "").pipe(
            Effect.orDie,
          );
          assert.deepInclude(fields, { source: "dmesg", identified: 0 });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtime(machine, mintingProvider(), stops).pipe(Layer.provideMerge(logs.layer)),
        ),
      );
    },
  );

  // The release of a failed Attempt starts the container again only if it stopped.
  it.effect.each([
    { outcome: "completes", parent: completes },
    { outcome: "fails", parent: fails },
  ])(
    "reads no kernel log when the container ran on and the kernel killed nothing: $outcome",
    ({ parent }) => {
      const machine = dockerMachine();
      machine.state.kernelMemory = "readable";
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* prepared
          .launch({
            ...sink,
            outOfMemory: (killed) => Effect.sync(() => void kills.push(killed)),
          })
          .pipe(Effect.exit);
        assert.deepStrictEqual(kills, []);
        assert(killsRead(machine) >= 0, "the counter was read");
        assert(!linesOf(machine).some((line) => line.includes("journalctl -k")));
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
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
            return yield* executor.prepare(CheckoutRequest.make({ ...request, reattach: true }));
          }).pipe(
            Effect.flip,
            Effect.scoped,
            Effect.provide(runtime(machine, credentials, completes, storage)),
          );
          assert.include(
            failure.message,
            change === "docker-installed"
              ? "is from before the machine used containers"
              : "no longer has a container runtime",
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
