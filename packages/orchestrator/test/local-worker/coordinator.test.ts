import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Agent } from "@usine/core/agent";
import { layer as durableTestingLayer, StubChildren } from "@usine/durable/testing";
import { Submission } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { Context, Effect, FileSystem, Layer, Option } from "effect";
import {
  LIVE_TEST_TIMEOUT,
  type SettingsInput,
  submission,
  testAgent,
  waitFor,
  withLocalEngine,
} from "./support.ts";

const runsWithoutParent = (options: { readonly agent: Agent; readonly settings?: SettingsInput }) =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "usine-coordinator-",
    });
    // No scripted parent answers: an Attempt routed to the Pi parent would fail.
    const attempts = yield* Layer.build(
      durableTestingLayer({ database: `${directory}/durable.sqlite`, parent: [] }),
    );
    const children = Context.get(attempts, StubChildren);
    yield* withLocalEngine(
      { attemptRuntime: Layer.succeedContext(attempts), settings: options.settings },
      ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(
            Submission.make({ ...submission(1), agent: options.agent }),
          );
          assert(accepted._tag === "Claimed");
          const child = yield* children.next;
          assert.include(child.request.prompt, "Complete local task 1");
          yield* child.reply("Done by the child.");
          const snapshot = yield* waitFor(engine, accepted.runId, "Succeeded");
          const attempt = snapshot.attempts[0];
          assert(attempt !== undefined);
          const started = (yield* engine.transcript(
            TranscriptAllQuery.make({ attemptId: attempt.id }),
          )).flatMap(({ envelope }) =>
            envelope.payload._tag === "Started" ? [envelope.payload] : [],
          );
          assert.lengthOf(started, 1);
          assert(Option.isNone(started[0]?.parentModel ?? Option.some("missing")));
        }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  "runs an Attempt on the event-driven coordinator when its Agent selects it",
  () =>
    runsWithoutParent({
      agent: Agent.make({ ...testAgent, coordinator: Option.some("events") }),
    }),
  LIVE_TEST_TIMEOUT,
);

it.live(
  "runs an Attempt on the event-driven coordinator when the instance selects it",
  () =>
    runsWithoutParent({
      agent: testAgent,
      settings: { coordinator: "events" },
    }),
  LIVE_TEST_TIMEOUT,
);
