import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { layer as durableTestingLayer, StubChildren } from "@usine/durable/testing";
import { Submission } from "@usine/engine/engine";
import { Context, Effect, FileSystem, Layer } from "effect";
import { LIVE_TEST_TIMEOUT, submission, waitFor, withLocalEngine } from "./support.ts";

it.live(
  "runs a new Attempt on the event-driven coordinator",
  () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "usine-coordinator-",
      });
      // No scripted parent answers: an Attempt routed to the Pi parent would fail.
      const attempts = yield* Layer.build(
        durableTestingLayer({ database: `${directory}/durable.sqlite`, parent: [] }),
      );
      const children = Context.get(attempts, StubChildren);
      yield* withLocalEngine({ attemptRuntime: Layer.succeedContext(attempts) }, ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(Submission.make(submission(1)));
          assert(accepted._tag === "Claimed");
          const child = yield* children.next;
          assert.include(child.request.prompt, "Complete local task 1");
          yield* child.reply("Done by the child.");
          yield* waitFor(engine, accepted.runId, "Succeeded");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  LIVE_TEST_TIMEOUT,
);
