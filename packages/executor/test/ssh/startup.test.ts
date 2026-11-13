import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { WorkerRoot } from "@usine/core/worker";
import { Effect, Layer, Option } from "effect";
import { Executor } from "../../src/executor.ts";
import { keptCheckoutRecovery } from "../../src/provision.ts";
import {
  ADDRESS,
  COMMIT_AUTHOR,
  aloneOnItem,
  executorLayer,
  fakeMachine,
  mintingProvider,
  noGateway,
  request,
} from "./support.ts";

it.effect(
  "lists a fixed connection once and writes no connection records for finished attempts without checkouts",
  () => {
    const machine = fakeMachine();
    const written: Array<AttemptId> = [];
    const executor = executorLayer(machine, mintingProvider(), ADDRESS, undefined, undefined, {
      attemptConnections: {
        read: () => Effect.succeedNone,
        write: (id) => Effect.sync(() => void written.push(id)),
        remove: () => Effect.void,
      },
    }).pipe(Layer.provide(noGateway));
    return Effect.gen(function* () {
      const service = yield* Executor;
      let commands = 0;
      for (let index = 0; index < 400; index += 1) {
        yield* service.recover(
          {
            ...keptCheckoutRecovery(request),
            attemptId: AttemptId.make(`finished/run/${index}`),
            succeeded: true,
            open: false,
          },
          {
            salvage: () => Effect.die("no checkout"),
            comments: () => Effect.void,
            windows: aloneOnItem(),
          },
          Effect.die("no salvage author needed"),
        );
        if (index === 0) commands = machine.state.calls.length;
        assert.strictEqual(
          machine.state.calls.length,
          commands,
          "finished attempts add no remote commands",
        );
      }
      assert.deepStrictEqual(written, []);
    }).pipe(Effect.scoped, Effect.provide(executor));
  },
);

it.effect(
  "caches a failed fixed-connection listing while leaving its attempt connections untouched",
  () => {
    const machine = fakeMachine();
    machine.state.reachable = false;
    const removed: Array<AttemptId> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      let commands = 0;
      for (let index = 0; index < 2; index += 1) {
        const result = yield* executor
          .recover(
            {
              ...keptCheckoutRecovery(request),
              attemptId: AttemptId.make(`finished/${index}`),
              open: false,
              succeeded: true,
            },
            {
              salvage: () => Effect.die("no checkout"),
              comments: () => Effect.void,
              windows: aloneOnItem(),
            },
            Effect.die("no salvage author needed"),
          )
          .pipe(Effect.result);
        assert(result._tag === "Failure");
        if (index === 0) commands = machine.state.calls.length;
        assert.strictEqual(machine.state.calls.length, commands);
      }
      assert.deepStrictEqual(removed, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        executorLayer(machine, mintingProvider(), ADDRESS, undefined, undefined, {
          attemptConnections: {
            read: () => Effect.succeedSome(ADDRESS),
            write: () => Effect.die("saved connections need no write"),
            remove: (id) => Effect.sync(() => void removed.push(id)),
          },
        }).pipe(Layer.provide(noGateway)),
      ),
    );
  },
);

it.effect.each(["runtime inspection", "container removal"])(
  "keeps the original connection across restart after failed %s with no checkout",
  (failure) => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    const records = new Map<AttemptId, typeof ADDRESS>();
    const layer = (address: typeof ADDRESS) =>
      executorLayer(machine, mintingProvider(), address, undefined, undefined, {
        attemptConnections: {
          read: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
          write: (id, connection) => Effect.sync(() => void records.set(id, connection)),
          remove: (id) => Effect.sync(() => void records.delete(id)),
        },
      }).pipe(Layer.provide(noGateway));
    const prepare = Effect.gen(function* () {
      const executor = yield* Executor;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* executor.prepare(request);
          machine.state.containerRemovalFails = true;
        }),
      );
      assert(
        records.has(request.attemptId),
        "the leftover container still needs its original connection",
      );
      assert.strictEqual(machine.state.containers.size, 1);
    });
    const recover = Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.recover(
        { ...keptCheckoutRecovery(request), succeeded: true, open: false },
        {
          salvage: () => Effect.die("no checkout"),
          comments: () => Effect.void,
          windows: aloneOnItem(),
        },
        Effect.die("no salvage author needed"),
      );
    });
    return Effect.gen(function* () {
      yield* prepare.pipe(Effect.scoped, Effect.provide(layer(ADDRESS)));
      machine.state.cacheExists = false;
      machine.state.containerRemovalFails = failure === "container removal";
      machine.state.docker = failure === "runtime inspection" ? "unusable" : "running";
      const replacement = { ...ADDRESS, root: WorkerRoot.make("/replacement") };
      const result = yield* recover.pipe(
        Effect.scoped,
        Effect.provide(layer(replacement)),
        Effect.result,
      );
      assert.strictEqual(machine.state.containers.size, 1);
      assert.deepStrictEqual(records.get(request.attemptId), ADDRESS);
      assert.strictEqual(result._tag, "Failure");
      machine.state.containerRemovalFails = false;
      machine.state.docker = "running";
      yield* recover.pipe(Effect.scoped, Effect.provide(layer(replacement)));
      assert.strictEqual(machine.state.containers.size, 0);
      assert.strictEqual(records.size, 0, "successful recovery removes the original connection");
    });
  },
);

it.effect("recovers a checkout created after the startup listing in the same executor", () => {
  const machine = fakeMachine();
  return Effect.gen(function* () {
    const executor = yield* Executor;
    const sink = {
      salvage: () => Effect.void,
      comments: () => Effect.void,
      windows: aloneOnItem(),
    };
    yield* executor.recover(
      {
        ...keptCheckoutRecovery(request),
        attemptId: AttemptId.make("finished/before-start"),
        succeeded: true,
        open: false,
      },
      sink,
      Effect.succeed(COMMIT_AUTHOR),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* executor.prepare(request);
        machine.state.reachable = false;
      }),
    );
    machine.state.reachable = true;
    machine.state.salvage = "dirty";
    yield* executor.recover(keptCheckoutRecovery(request), sink, Effect.succeed(COMMIT_AUTHOR));
    assert.isTrue(machine.state.salvageCommitted, "the retained checkout is salvaged");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      executorLayer(machine, mintingProvider(), ADDRESS).pipe(Layer.provide(noGateway)),
    ),
  );
});

it.effect(
  "fails the recovery of a listed checkout whose inspection loses the connection, instead of finding it gone",
  () => {
    const machine = fakeMachine();
    machine.state.cacheExists = true;
    const sink = {
      salvage: () => Effect.die("no salvage without the checkout"),
      comments: () => Effect.void,
      windows: aloneOnItem(),
    };
    return Effect.gen(function* () {
      const executor = yield* Executor;
      // Lists the machine's checkouts, including the Attempt's.
      yield* executor.recover(
        {
          ...keptCheckoutRecovery(request),
          attemptId: AttemptId.make("finished/before-the-drop"),
          succeeded: true,
          open: false,
        },
        sink,
        Effect.die("no salvage author needed"),
      );
      machine.state.reachable = false;
      const result = yield* executor
        .recover(
          { ...keptCheckoutRecovery(request), succeeded: true, open: false },
          sink,
          Effect.succeed(COMMIT_AUTHOR),
        )
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        executorLayer(machine, mintingProvider(), ADDRESS).pipe(Layer.provide(noGateway)),
      ),
    );
  },
);
