import { assert, it } from "@effect/vitest";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { DurableHarness } from "../src/harness.ts";
import { layer } from "../src/testing.ts";
import { temporaryDatabase } from "./support.ts";

it.live("disables task parking after repeated restarts in the opened harness", () =>
  Effect.gen(function* () {
    const database = yield* temporaryDatabase;
    const task = defineTask<null, { phase: "read" }, boolean>({
      name: "test.restart-limit",
      version: 1,
      initial: () => ({ phase: "read" }),
      phases: {
        read: (_task, runtime, context) =>
          runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: runtime.settings.restartLimit === Infinity },
            }),
            context,
          ),
      },
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    yield* Effect.gen(function* () {
      const harness = yield* DurableHarness;
      yield* harness.install(defineExtension({ name: "test", tasks: [task] }));
      const settled = yield* harness.use(
        "read the task restart policy",
        async (opened, context) => {
          const root = await opened.root(context);
          const taskId = await root.commit(
            (tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }),
            context,
          );
          return opened.waitForTask(taskId, context);
        },
      );
      assert.deepStrictEqual(settled.state.outcome, { status: "completed", result: true });
    }).pipe(Effect.provide(layer({ database, parent: [] })));
  }).pipe(Effect.scoped),
);
