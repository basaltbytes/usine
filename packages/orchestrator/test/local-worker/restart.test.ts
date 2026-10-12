import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { RunEngine } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
import { CredentialProvider, WorkerCredential } from "@usine/executor";
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Scope,
} from "effect";
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
  TOKEN,
  waitFor,
} from "./support.ts";

/** The local composition over the durable testing runtime on `database`, with the parent model answering `steps`. */
const durableRuntime = (
  instance: InstanceDirectory,
  remote: string,
  database: string,
  steps: ReadonlyArray<ParentStep>,
  credentials: Layer.Layer<CredentialProvider> = credentialLayer,
) =>
  localLayer(instance, config, [], {
    repositoryUrl: () => remote,
    interruptGrace: "1 second",
    harnessReadiness: harnessReady,
  }).pipe(
    Layer.provide(credentials),
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

  it.live(
    "finishes an Attempt whose parent finished before the stop with the parent's result, without running it again",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "usine-durable-harvest-",
        });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const database = `${root}/durable.sqlite`;
        // Credentials close to expiry renew before every harvesting command; once the
        // child has replied, the first renewal holds the harvest until the process stops.
        const holdRenewals = yield* Ref.make(false);
        const harvesting = yield* Deferred.make<void>();
        const holdingCredentials = Layer.succeed(CredentialProvider)({
          issue: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(holdRenewals)) {
                yield* Deferred.succeed(harvesting, undefined);
                return yield* Effect.never;
              }
              return new WorkerCredential({
                value: Redacted.make(TOKEN),
                expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000),
              });
            }),
        });

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(
          Layer.build(
            durableRuntime(
              instance,
              remote,
              database,
              [delegate("Implement the task"), answer("Finished before the stop")],
              holdingCredentials,
            ),
          ),
          firstScope,
        );
        const first = Context.get(firstContext, RunEngine);
        const accepted = yield* first.submit(submission(3));
        assert(accepted._tag === "Claimed");
        const child = yield* Context.get(firstContext, StubChildren).next;
        const [attempt] = (yield* first.inspect(accepted.runId)).attempts;
        assert(attempt !== undefined);
        const worktree = `${root}/.usine/workers/local/attempts/${safeSegment(attempt.id)}`;
        yield* commitInWorktree(worktree, "Work before the stop");
        yield* Ref.set(holdRenewals, true);
        yield* child.reply("Implemented the task.");
        yield* Deferred.await(harvesting);
        const relayed = yield* first.transcript(new TranscriptAllQuery({ attemptId: attempt.id }));
        assert.strictEqual(relayed.at(-1)?.envelope.payload._tag, "Final");
        yield* Scope.close(firstScope, Exit.void);
        assert(yield* fileSystem.exists(worktree), "the unharvested checkout survives the stop");

        const secondScope = yield* Scope.make();
        const second = Context.get(
          yield* Scope.provide(
            Layer.build(durableRuntime(instance, remote, database, [])),
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
        assert.strictEqual(finished.step.result.value.message, "Finished before the stop");
        assert.deepStrictEqual(
          finished.step.result.value.facts.map((fact) =>
            fact._tag === "Commit" ? fact.summary : fact._tag,
          ),
          ["Work before the stop"],
        );
        const transcript = yield* second.transcript(
          new TranscriptAllQuery({ attemptId: attempt.id }),
        );
        assert.strictEqual(
          transcript.filter(({ envelope }) => envelope.payload._tag === "Final").length,
          1,
        );
        yield* Scope.close(secondScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );
});
