import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { AttemptId } from "@usine/core/attempt";
import { InstanceDirectory } from "@usine/core/instance";
import { completes, StubStorage, type StubParent } from "@usine/durable/testing";
import type { SshWorkerAddress } from "@usine/executor/ssh";
import { CheckoutRequest, Executor } from "@usine/executor";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { sshStepExecutorLayer, sshWorkerAddressesOf } from "../src/ssh.ts";
import { workerConnectionsFor } from "../src/connections.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";
import { testAppLayer } from "./support/github-app.ts";
import {
  aloneOnItem,
  executorLayer,
  fakeMachine,
  mintingProvider,
  noGateway,
  request,
  WORKER,
} from "../../executor/test/ssh/support.ts";

const yaml = (destination: string) => `version: 1
repos: [{ name: acme/project }]
workers:
  - name: ${WORKER}
    kind: ssh
    destination: ${destination}
    root: /srv/usine
    max_concurrent_attempts: 2
`;

for (const restart of [false, true]) {
  it.live(
    `retains an open attempt's connection when a revision applies${restart ? " before restart" : " live"}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = InstanceDirectory.make(yield* fs.makeTempDirectoryScoped());
        yield* writeInstanceFiles(root, [["usine.yaml", yaml("original-host")]]);
        yield* fs.makeDirectory(`${root}/agents`);
        yield* fs.makeDirectory(`${root}/loops`);
        const machine = fakeMachine();
        const credentials = mintingProvider();
        const storage = new StubStorage();
        const started = yield* Deferred.make<void>();
        const blocks: StubParent = () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        const sink = {
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
          outOfMemory: () => Effect.void,
          transcript: Effect.succeed([]),
          windows: aloneOnItem(),
        };
        const build = (parent: StubParent) =>
          Effect.gen(function* () {
            const current = yield* CurrentInstance;
            const { config } = yield* current.get;
            const connections = yield* workerConnectionsFor<SshWorkerAddress>(
              `${root}/.usine/attempt-connections`,
              (worker) =>
                sshWorkerAddressesOf(new UsineConfig({ ...config, workers: [worker] })).pipe(
                  Effect.map((addresses) => {
                    const address = addresses[0];
                    assert(address !== undefined);
                    return address;
                  }),
                ),
              [],
            );
            const declared = config.workers[0];
            assert(declared !== undefined);
            const address = yield* connections.resolve(declared);
            const executor = executorLayer(machine, credentials, address, parent, storage, {
              attemptConnections: connections.store,
            }).pipe(Layer.provide(noGateway));
            const context = yield* Layer.build(
              sshStepExecutorLayer(config, [], { resolveAddress: connections.resolve }).pipe(
                Layer.provideMerge(executor),
                Layer.provide(testAppLayer),
                Layer.provide(MarcbachmannCelLayer),
              ),
            );
            return Context.get(context, Executor);
          });
        const verify = (executor: Executor["Service"]) =>
          Effect.gen(function* () {
            const before = machine.state.calls.length;
            yield* Effect.scoped(
              executor.prepare(new CheckoutRequest({ ...request, reattach: true })),
            );
            const retained = machine.state.calls.slice(before);
            assert(retained.some(({ command }) => command.args.includes("original-host")));
            assert(!retained.some(({ command }) => command.args.includes("replacement-host")));
            const offset = machine.state.calls.length;
            yield* Effect.scoped(
              executor.prepare(
                new CheckoutRequest({ ...request, attemptId: AttemptId.make("next/execute/1") }),
              ),
            );
            assert(
              machine.state.calls
                .slice(offset)
                .some(({ command }) => command.args.includes("replacement-host")),
            );
          });
        yield* Effect.gen(function* () {
          const executor = yield* build(blocks);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const launch = yield* (yield* executor.prepare(request))
                .launch(sink)
                .pipe(Effect.forkChild);
              yield* Deferred.await(started);
              yield* writeInstanceFiles(root, [["usine.yaml", yaml("replacement-host")]]);
              yield* (yield* CurrentInstance).reload;
              yield* Fiber.interrupt(launch);
            }),
          );
          const persisted = yield* fs.readFileString(
            `${root}/.usine/attempt-connections/remote-run_execute_1.json`,
          );
          assert.include(persisted, "original-host");
          assert(!credentials.minted.some((token) => persisted.includes(token)));
          if (!restart) yield* verify(executor);
        }).pipe(Effect.scoped, Effect.provide(reloadableInstanceLayer(root)));
        if (restart)
          yield* build(completes).pipe(
            Effect.flatMap(verify),
            Effect.scoped,
            Effect.provide(reloadableInstanceLayer(root)),
          );
        assert.deepStrictEqual(yield* fs.readDirectory(`${root}/.usine/attempt-connections`), []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
