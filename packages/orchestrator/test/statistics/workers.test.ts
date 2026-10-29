import { assert, describe, it } from "@effect/vitest";
import {
  ConfigurationStore,
  ConfigurationRevisionNumber,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { DateTime, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { readWorkerCapacity, workerSlotMillis } from "../../src/operator/statistics/workers.ts";
import { configurationLayer } from "../support/configuration.ts";

const HOUR = 3_600_000;
const at = (hour: number) => DateTime.makeUnsafe(hour * HOUR);
const instance = (slots: number) =>
  new LoadedInstance({
    config: Schema.decodeUnknownSync(UsineConfig)({
      version: 2,
      repos: [],
      projects: [],
      workers: [
        { name: "local", kind: "local", max_concurrent_attempts: 1 },
        ...(slots === 0 ? [] : [{ name: "worker", kind: "local", max_concurrent_attempts: slots }]),
      ],
    }),
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });

const commit = (hour: number, slots: number) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(hour * HOUR);
    const store = yield* ConfigurationStore;
    const previous = yield* store.read;
    yield* store.commit({
      expected: previous.number,
      actor: Option.none(),
      message: Option.none(),
      changes: configurationDiff(
        Option.match(previous.instance, { onNone: () => [], onSome: configurationEntities }),
        configurationEntities(instance(slots)),
      ),
    });
  });

const capacity = Effect.gen(function* () {
  const store = yield* ConfigurationStore;
  const current = yield* store.read;
  assert(Option.isSome(current.instance));
  const worker = current.instance.value.config.workers.find(({ name }) => name === "worker");
  assert(worker !== undefined);
  return yield* readWorkerCapacity(store, worker);
});

describe("Worker slot history", () => {
  it.effect("integrates resizes and uses revision 1 before recorded history", () =>
    Effect.gen(function* () {
      yield* commit(2, 2);
      yield* commit(4, 4);
      yield* commit(8, 1);
      const worker = yield* capacity;
      assert.strictEqual(worker.slots, 1);
      assert.strictEqual(workerSlotMillis(worker, 0, 10 * HOUR), 26 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, HOUR, 3 * HOUR), 4 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, 5 * HOUR, 7 * HOUR), 8 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, 4 * HOUR, 8 * HOUR), 16 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, 8 * HOUR, 10 * HOUR), 2 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, 8 * HOUR, 8 * HOUR), 0);
    }).pipe(Effect.provide(configurationLayer)),
  );

  it.effect("leaves capacity at zero before a later worker is added and while removed", () =>
    Effect.gen(function* () {
      yield* commit(1, 0);
      yield* commit(3, 2);
      yield* commit(5, 0);
      yield* commit(7, 4);
      const worker = yield* capacity;
      assert.strictEqual(workerSlotMillis(worker, 0, 10 * HOUR), 16 * HOUR);
      assert.strictEqual(workerSlotMillis(worker, 0, 3 * HOUR), 0);
      assert.strictEqual(workerSlotMillis(worker, 5 * HOUR, 7 * HOUR), 0);
    }).pipe(Effect.provide(configurationLayer)),
  );

  it.effect("uses declared slots when an embedded instance has no configuration revisions", () =>
    Effect.gen(function* () {
      const store = yield* ConfigurationStore;
      assert.strictEqual((yield* store.read).number, ConfigurationRevisionNumber.make(0));
      const worker = instance(2).config.workers[1];
      assert(worker !== undefined);
      const history = yield* readWorkerCapacity(store, worker);
      assert.strictEqual(
        workerSlotMillis(history, DateTime.toEpochMillis(at(0)), DateTime.toEpochMillis(at(10))),
        20 * HOUR,
      );
    }).pipe(Effect.provide(configurationLayer)),
  );
});
