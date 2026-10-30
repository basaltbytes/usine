import { assert, describe, it } from "@effect/vitest";
import { SshDestination, WorkerName } from "@usine/core/worker";
import { Effect } from "effect";
import { Executor } from "../../../src/executor.ts";
import { SshWorkers } from "../../../src/ssh/ssh.ts";
import {
  aloneOnItem,
  WORKER,
  capturedLogs,
  fakeMachine,
  mintingProvider,
  request,
} from "../support.ts";
import {
  attachmentsInForce,
  eventually,
  fakeGateway,
  gatewayAddress,
  gatewayRuntime,
} from "./support.ts";

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};
const SECOND = WorkerName.make("eu-two");
const THIRD = WorkerName.make("eu-three");
const OTHER_GATEWAY = SshDestination.make("usine-gateway-2");

describe("SSH Workers added and removed while the executor runs", () => {
  it.effect(
    "a Worker added behind a Gateway in use shares its forward, and one behind another Gateway opens its own",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const workers = yield* SshWorkers;
        yield* executor.preflight(WORKER, [], 1);
        const [first] = machine.state.forwards;
        assert(first !== undefined, "the startup Worker's forward is open");

        yield* workers.addWorker(gatewayAddress({ name: SECOND }));
        yield* executor.preflight(SECOND, [], 1);
        assert.strictEqual(machine.state.forwards.length, 1, "the new Worker shares the forward");
        const listing = gateway.calls.at(-1);
        assert(listing?.delivered === true && listing.port === first.port);

        yield* workers.addWorker(gatewayAddress({ name: THIRD, gateway: OTHER_GATEWAY }));
        yield* eventually(() => machine.state.forwards.length === 2);
        const second = machine.state.forwards[1];
        assert(second !== undefined);
        assert.strictEqual(second.command.args.at(-1), "usine-gateway-2");
        yield* executor.preflight(THIRD, [], 1);
        const through = gateway.calls.at(-1);
        assert(through?.delivered === true && through.port === second.port);

        const logged = logs.lines.join("\n");
        assert.include(
          logged,
          "SSH Worker added to the executor; it shares the forward to its Gateway's admin API",
        );
        assert.include(
          logged,
          "SSH Worker added to the executor; it is the first behind its Gateway, so the forward to the Gateway's admin API opens",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "keeps a Gateway's forward while a Worker behind it remains, and closes it with the last one once its Attempt has ended",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const workers = yield* SshWorkers;
        yield* workers.addWorker(gatewayAddress({ name: SECOND }));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* executor.prepare(request);
            yield* workers.removeWorker(SECOND);
            const [forward] = machine.state.forwards;
            assert(forward?.live === true, "the Attempt's Worker still uses the forward");
            yield* prepared.launch(sink);
          }),
        );
        const detach = gateway.calls.at(-1);
        assert(detach?.method === "DELETE" && detach.delivered, "the Attempt detached through it");
        assert.deepStrictEqual(yield* attachmentsInForce, []);

        yield* workers.removeWorker(WORKER);
        assert(
          machine.state.forwards.every(({ live }) => !live),
          "the forward closed with the last Worker behind the Gateway",
        );
        const gone = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
        assert(gone._tag === "WorkerCapabilityError", gone._tag);
        assert.strictEqual(gone.capability, "machine");
        assert.strictEqual(gone.message, 'No SSH worker named "eu-one" is configured');

        const logged = logs.lines.join("\n");
        assert.include(
          logged,
          "SSH Worker removed from the executor; the forward to its Gateway's admin API stays open for the other Workers behind it",
        );
        assert.include(
          logged,
          "SSH Worker removed from the executor; it was the last behind its Gateway, so the forward to the Gateway's admin API closed",
        );
        assert.include(logged, "Closed the forward to the Gateway's admin API");
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)),
        Effect.provide(logs.layer),
      );
    },
  );

  it.effect(
    "takes a Worker it has back with the same address, and refuses it with another while it is in use",
    () => {
      const machine = fakeMachine();
      const gateway = fakeGateway(machine);
      return Effect.gen(function* () {
        const workers = yield* SshWorkers;
        yield* workers.addWorker(gatewayAddress());
        const refused = yield* workers
          .addWorker({
            ...gatewayAddress(),
            machine: { _tag: "Fixed", destination: SshDestination.make("usine@203.0.113.8") },
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused.capability, "machine");
        assert.strictEqual(
          refused.message,
          'Can\'t change the settings of SSH worker "eu-one" while its attempts run. Reload again after they end.',
        );
        yield* (yield* Executor).preflight(WORKER, [], 1);
        assert.strictEqual(machine.state.forwards.length, 1);
        assert(
          machine.state.calls.every(({ command }) => !command.args.includes("usine@203.0.113.8")),
          "the executor kept the machine it had",
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway)));
    },
  );
});
