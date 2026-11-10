import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { TailnetAddress } from "@usine/core/worker";
import { completes, type StubParent } from "@usine/durable/testing";
import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Executor } from "../../../src/executor.ts";
import {
  aloneOnItem,
  fakeMachine,
  mintingProvider,
  request,
  TEST_AGENT,
  WORKER,
} from "../support.ts";
import { fakeGateway, gatewayAddress, gatewayRuntime } from "./support.ts";

const address = gatewayAddress();
assert(address.machine._tag === "Fixed");
const tailnetAddress = {
  ...address,
  machine: {
    ...address.machine,
    tailnet: Option.some({ gatewayAddress: TailnetAddress.make("100.64.0.2") }),
  },
};

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

describe("Fixed SSH worker gateway over the tailnet", () => {
  it.live("keeps the HTTP proxy running until its gateway address changes", () => {
    const machine = fakeMachine();
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const configuration = yield* Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [], 1);
        const configuration = machine.state.calls.find(({ line }) =>
          line.includes("# usine-tailnet"),
        );
        assert.isDefined(configuration);
        return configuration.line;
      }).pipe(
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, { address: tailnetAddress }),
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-tailnet-" });
      const bin = path.join(directory, "bin");
      const etc = path.join(directory, "etc");
      const log = path.join(directory, "systemctl.log");
      yield* fs.makeDirectory(bin);
      yield* fs.makeDirectory(path.join(etc, "systemd/system"), { recursive: true });
      yield* fs.writeFileString(path.join(etc, "hosts"), "127.0.0.1 localhost\n");
      yield* fs.writeFileString(path.join(bin, "sudo"), '#!/bin/sh\nshift\nexec "$@"\n', {
        mode: 0o755,
      });
      yield* fs.writeFileString(
        path.join(bin, "systemctl"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CONFIGURE_LOG"\n',
        { mode: 0o755 },
      );
      const configure = Effect.fn(function* (address: string) {
        const line = configuration.replaceAll("/etc/", `${etc}/`).replaceAll("100.64.0.2", address);
        const result = yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", line], {
            env: { PATH: `${bin}:/usr/bin:/bin`, CONFIGURE_LOG: log },
          }),
        );
        assert.strictEqual(result, 0);
      });
      yield* configure("100.64.0.2");
      const first = yield* fs.readFileString(log);
      yield* configure("100.64.0.2");
      const repeated = yield* fs.readFileString(log);
      assert.notInclude(repeated.slice(first.length), "try-restart");
      const repeatedHosts = yield* fs.readFileString(path.join(etc, "hosts"));
      assert.strictEqual(
        repeatedHosts,
        "127.0.0.1 localhost\n100.64.0.2 git.gw.test llm.gw.test # usine-tailnet\n",
      );
      yield* configure("100.64.0.4");
      const changed = yield* fs.readFileString(log);
      assert.include(changed.slice(repeated.length), "try-restart usine-gateway-http.service");
      const changedHosts = yield* fs.readFileString(path.join(etc, "hosts"));
      assert.include(changedHosts, "100.64.0.4 git.gw.test");
      const service = yield* fs.readFileString(
        path.join(etc, "systemd/system/usine-gateway-http.service"),
      );
      assert.include(service, "100.64.0.4:80");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  });

  it.effect(
    "configures gateway access at each preflight and runs containers with direct egress",
    () => {
      const machine = fakeMachine();
      machine.state.docker = "running";
      machine.state.forwardProxyReachable = false;
      const gateway = fakeGateway(machine);
      let launched = false;
      const parent: StubParent = (context) => {
        launched = true;
        assert.strictEqual(context.request.environment.HTTPS_PROXY, "");
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const configurations = machine.state.calls.filter(({ line }) =>
          line.includes("# usine-tailnet"),
        );
        assert.lengthOf(configurations, 2);
        for (const { line } of configurations) {
          assert.include(line, "exec 'sudo' '-n' 'sh' '-c'");
          assert.include(line, "'100.64.0.2' 'gw.test'");
          assert.notInclude(line, "sshd");
          assert.include(line, "/etc/systemd/system/usine-gateway-http.socket");
        }
        const prepared = yield* executor.prepare(request);
        yield* prepared.launch(sink);
        assert.isTrue(launched);
        assert.isFalse(machine.state.calls.some(({ line }) => line.includes("'tailscale'")));
        const containers = machine.state.calls.filter(
          ({ line }) => line.startsWith("exec 'docker' 'run'") && line.includes("--add-host"),
        );
        assert.isAtLeast(containers.length, 3);
        for (const { line } of containers) {
          assert.include(line, "git.gw.test:100.64.0.2");
          assert.include(line, "llm.gw.test:100.64.0.2");
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          gatewayRuntime(machine, mintingProvider(), gateway, { address: tailnetAddress, parent }),
        ),
      );
    },
  );

  it.effect("reports a gateway capability error when passwordless sudo fails", () => {
    const machine = fakeMachine();
    machine.state.tailnetConfigure = "refused";
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "gateway");
      assert.include(error.message, "passwordless sudo");
      machine.state.tailnetConfigure = "ready";
      yield* executor.preflight(WORKER, [], 1);
    }).pipe(
      Effect.provide(
        gatewayRuntime(machine, mintingProvider(), gateway, { address: tailnetAddress }),
      ),
    );
  });

  it.effect("requires the gateway refusal header after configuring tailnet routing", () => {
    const machine = fakeMachine();
    machine.state.gatewayRefusal = "unknown-caller-token";
    const gateway = fakeGateway(machine);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "gateway");
      assert.include(error.message, "can't reach its gateway");
      machine.state.gatewayRefusal = "missing-caller-token";
      yield* executor.preflight(WORKER, [], 1);
    }).pipe(
      Effect.provide(
        gatewayRuntime(machine, mintingProvider(), gateway, { address: tailnetAddress }),
      ),
    );
  });
});
