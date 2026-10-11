import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { RunEngine } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { Context, Effect, Exit, FileSystem, Layer, Option, Scope } from "effect";
import {
  answer,
  delegate,
  layer as durableTestingLayer,
  type ParentStep,
  StubChildren,
} from "@usine/durable/testing";
import { layer as localLayer } from "../../src/local.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";
import {
  LIVE_TEST_TIMEOUT,
  STATE_POLL_ATTEMPTS,
  config,
  credentialLayer,
  harnessReady,
  makeRemote,
  run,
  submission,
  waitFor,
} from "./support.ts";

/** The local composition over the durable testing runtime on `database`, with the parent model answering `steps`. */
const durableRuntime = (
  instance: InstanceDirectory,
  remote: string,
  database: string,
  steps: ReadonlyArray<ParentStep>,
) =>
  localLayer(instance, config, [], {
    repositoryUrl: () => remote,
    interruptGrace: "1 second",
    harnessReadiness: harnessReady,
  }).pipe(
    Layer.provide(credentialLayer),
    Layer.provideMerge(durableTestingLayer({ database, parent: steps })),
    Layer.provide(alwaysHoldsLayer),
  );

const commitInWorktree = (worktree: string, message: string) =>
  run(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ],
    worktree,
  );

describe("local worker restart", () => {
  it.live(
    "reattaches the durable parent task after a restart while its child was running",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "usine-durable-restart-",
        });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const database = `${root}/durable.sqlite`;

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(
          Layer.build(durableRuntime(instance, remote, database, [delegate("Implement the task")])),
          firstScope,
        );
        const first = Context.get(firstContext, RunEngine);
        const accepted = yield* first.submit(submission(2));
        assert(accepted._tag === "Claimed");
        // The parent delegated, and its child is running when the orchestrator stops.
        yield* Context.get(firstContext, StubChildren).next;
        const [attempt] = (yield* first.inspect(accepted.runId)).attempts;
        assert(attempt !== undefined);
        const worktree = `${root}/.usine/workers/local/attempts/${safeSegment(attempt.id)}`;
        yield* commitInWorktree(worktree, "Work before the restart");
        yield* Scope.close(firstScope, Exit.void);
        assert(yield* fileSystem.exists(worktree), "the checkout must survive the restart");

        const secondScope = yield* Scope.make();
        const second = Context.get(
          yield* Scope.provide(
            Layer.build(
              durableRuntime(instance, remote, database, [answer("Finished after the restart")]),
            ),
            secondScope,
          ),
          RunEngine,
        );
        const finished = yield* waitFor(second, accepted.runId, "Succeeded");
        assert.deepStrictEqual(
          finished.attempts.map(({ id, number }) => [id, number]),
          [[attempt.id, 1]],
        );
        assert(Option.isSome(finished.step.result));
        assert.strictEqual(finished.step.result.value.message, "Finished after the restart");
        assert.deepStrictEqual(
          finished.step.result.value.facts.map((fact) =>
            fact._tag === "Commit" ? fact.summary : fact._tag,
          ),
          ["Work before the restart"],
        );
        const transcript = yield* second.transcript(
          new TranscriptAllQuery({ attemptId: attempt.id }),
        );
        const outbound = transcript.filter(({ direction }) => direction === "outbound");
        assert.deepStrictEqual(
          outbound.map(({ envelope }) => envelope.sequence),
          outbound.map((_, index) => index + 1),
        );
        assert.strictEqual(outbound.at(-1)?.envelope.payload._tag, "Final");
        // The child that was running when the orchestrator stopped is in the same transcript.
        assert(
          outbound.some(
            ({ envelope }) =>
              envelope.payload._tag === "SessionEvent" &&
              envelope.payload.event._tag === "SessionStarted" &&
              envelope.payload.event.session._tag === "ChildSession",
          ),
        );
        let leftover = yield* fileSystem.exists(worktree);
        for (let poll = 0; leftover && poll < STATE_POLL_ATTEMPTS; poll += 1) {
          yield* Effect.sleep("10 millis");
          leftover = yield* fileSystem.exists(worktree);
        }
        assert(!leftover, "the reattached Attempt releases its checkout when it ends");
        yield* Scope.close(secondScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );
});
