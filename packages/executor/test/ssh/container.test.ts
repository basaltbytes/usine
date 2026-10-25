import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { AttemptId } from "@usine/core/attempt";
import { type AttemptSalvage, SalvageRef } from "@usine/core/attempt/salvage";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRequest } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { Deferred, Effect, Fiber, Option } from "effect";
import { readFileSync } from "node:fs";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import { ATTEMPT_IMAGE, SshWorkers } from "../../src/ssh/ssh.ts";
import { fakeGateway, gatewayRuntime } from "./gateway/support.ts";
import {
  ADDRESS,
  aloneOnItem,
  capturedLogs,
  CREDENTIALS,
  fails,
  fakeMachine,
  INSTANCE,
  mintingProvider,
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

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
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
          `dev.usine.worker=${WORKER}`,
          `dev.usine.attempt=${request.attemptId}`,
        ]);
        assert.strictEqual(words.at(-1), ATTEMPT_IMAGE);
        assert.deepStrictEqual(mountsOf(words), [
          `type=tmpfs,"destination=${WORKER_ROOT}/attempts",tmpfs-mode=1777`,
          `type=bind,"source=${WORKTREE}","destination=${WORKTREE}"`,
          `type=bind,"source=${CACHE}","destination=${CACHE}",readonly`,
          `type=bind,"source=${CREDENTIALS}","destination=${CREDENTIALS}",readonly`,
          `type=bind,"source=/home/usine/.claude/.credentials.json","destination=/home/usine/.claude/.credentials.json",readonly`,
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
        const checkoutGone = lines.indexOf(`exec 'rm' '-rf' '${WORKTREE}'`);
        const containerGone = lines.indexOf(`exec 'docker' 'rm' '--force' '${CONTAINER}'`);
        const credentialGone = lines.indexOf(`exec 'rm' '-rf' '${CREDENTIALS}'`);
        assert(
          checkoutGone >= 0 && containerGone > checkoutGone,
          "the container outlives the checkout",
        );
        assert(credentialGone > containerGone, "the credential outlives the container");
        assert.strictEqual(machine.state.containers.size, 0);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
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
    "salvages an unsuccessful Attempt in its container before removing the container",
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
        const push = machine.state.calls.findIndex(({ line }) => line.includes("'push' '--force'"));
        assert.strictEqual(machine.state.calls[push]?.container, CONTAINER);
        const lines = linesOf(machine);
        assert(lines.indexOf(`exec 'docker' 'rm' '--force' '${CONTAINER}'`) > push);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), fails)));
    },
  );

  it.effect(
    "removes the containers an earlier process left before a Worker's first Attempt, and keeps a running Attempt's on a shared machine",
    () => {
      const machine = dockerMachine();
      const leftover = (worker: string, instance = INSTANCE) => ({
        args: [],
        labels: new Map([
          ["dev.usine.instance", instance],
          ["dev.usine.worker", worker],
        ]),
        environment: "",
      });
      machine.state.containers.set("usine-crashed", leftover(WORKER));
      machine.state.containers.set("usine-of-a-removed-worker", leftover("eu-gone"));
      machine.state.containers.set("usine-of-another-instance", leftover(WORKER, "github-app-7"));
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
          "usine-of-another-instance",
          CONTAINER,
        ]);

        yield* workers.addWorker({ ...ADDRESS, name: second });
        yield* Effect.scoped(executor.prepare(secondRequest));
        assert(machine.state.containers.has(CONTAINER), "the running Attempt keeps its container");
        yield* Deferred.succeed(done, undefined);
        yield* Fiber.join(first);
        assert.deepStrictEqual([...machine.state.containers.keys()], ["usine-of-another-instance"]);
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
    },
  );

  for (const checkout of ["standalone", "linked"] as const)
    it.effect(
      `reattaches after a restart ${checkout === "standalone" ? "in a new container with the new credential" : "as the SSH user to a linked worktree from before Docker"}`,
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
          const started = Deferred.makeUnsafe<void>();
          const working: StubParent = () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          yield* Effect.gen(function* () {
            const executor = yield* Executor;
            const launch = yield* (yield* executor.prepare(request))
              .launch(sink)
              .pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(launch);
          }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, working, storage)));
          assert.strictEqual(machine.state.containers.size, 0, "a stopping process removes it");
          machine.state.linkedCheckout = checkout === "linked";

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
            if (checkout === "linked") {
              assert.strictEqual(given.host.container, undefined);
              assert(!calls.some(({ line }) => line.startsWith("exec 'docker' 'run' ")));
              return;
            }
            assert.deepStrictEqual(given.host.container, { runtime: "docker", name: CONTAINER });
            const restarted = calls.findIndex(({ line }) =>
              line.startsWith("exec 'docker' 'run' "),
            );
            const written = calls.findIndex(({ line }) => writesCredential(line));
            assert(restarted >= 0, "a new container starts");
            assert(written >= 0 && written < restarted, "after the new credential is written");
            assert.strictEqual(credentials.minted.length, 2);
          }).pipe(Effect.scoped, Effect.provide(runtime(machine, credentials, parent, storage)));
          assert.strictEqual(machine.state.containers.size, 0);
        });
      },
    );
});
