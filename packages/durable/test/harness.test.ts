// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { assert, it } from "@effect/vitest";
import { defineDoc, defineExtension, defineTask } from "@earendil-works/pi-durable";
import { Effect, DateTime } from "effect";
import { HoldDoc } from "../src/attempt/documents.ts";
import { DurableHarness } from "../src/harness.ts";
import { layer } from "../src/testing.ts";
import { temporaryDatabase } from "./support.ts";

it.live(
  "migrates queued parent guidance without losing its order, hold, pause, or request IDs",
  () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const legacyHold = defineDoc<{ paused: boolean; held: string[]; guidance: string[] }>({
        kind: "usine.hold",
        version: 1,
        scope: "task",
        checkpointWhen: () => false,
        initial: () => ({
          paused: false,
          held: ["parent:legacy"],
          guidance: ["First message", "Second message"],
        }),
      });
      const task = defineTask<null, { phase: "wait" }, null>({
        name: "test.legacy-hold",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
          wait: (_task, runtime, context) =>
            runtime.commit(
              () => ({
                status: "sleeping",
                checkpoint: { phase: "wait" },
                until: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000,
              }),
              context,
            ),
        },
        abort: (_task, runtime, context) =>
          runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
      });
      yield* Effect.gen(function* () {
        const durable = yield* DurableHarness;
        yield* durable.install(defineExtension({ name: "test.legacy-hold", tasks: [task] }));
        yield* durable.use("read and update migrated guidance", async (harness, context) => {
          const root = await harness.root(context);
          const taskId = await root.commit(async (tx) => {
            const taskId = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
            (await tx.doc(legacyHold, taskId)).paused = true;
            return taskId;
          }, context);
          const hold = await harness.snapshot(HoldDoc, taskId, context);
          assert.deepStrictEqual(hold, {
            paused: true,
            pausedChildren: [],
            held: ["parent:legacy"],
            guidance: [
              { message: "First message", requestId: "legacy-guidance:0" },
              { message: "Second message", requestId: "legacy-guidance:1" },
            ],
          });
          await harness.commit(async (tx) => {
            (await tx.doc(HoldDoc, taskId)).guidance.shift();
          }, context);
          const remaining = await harness.snapshot(HoldDoc, taskId, context);
          assert.deepStrictEqual(remaining?.guidance, [
            { message: "Second message", requestId: "legacy-guidance:1" },
          ]);
        });
      }).pipe(Effect.provide(layer({ database, parent: [] })));
    }).pipe(Effect.scoped),
);
