import { assert, describe, it } from "@effect/vitest";
import type { AttemptId } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import type { SalvagePushed } from "@usine/core/attempt/salvage";
import type { InstanceDirectory } from "@usine/core/instance";
import { safeSegment } from "@usine/core/repository";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  completes,
  type StubParent,
  stubAttemptRuntime,
  StubStorage,
  worksFor,
} from "@usine/durable/testing";
import { ReconcileInterval, UnconfirmedStops } from "@usine/engine/engine";
import { Effect, FileSystem, Layer, Option, Path, Ref, Schedule } from "effect";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIVE_TEST_TIMEOUT,
  output,
  submission,
  waitFor,
  waitForSalvage,
  waitForStarted,
  withLocalEngine,
} from "./support.ts";

/**
 * Returns the stub Attempt runtime over `parent`, whose `cancel` fails while `unstoppable` is
 * true, as when durable storage can't confirm the parent task's stop. Counts `cancel` calls in
 * `cancels`.
 */
const unstoppableRuntime = (
  parent: StubParent,
  unstoppable: Ref.Ref<boolean>,
  cancels: Ref.Ref<number>,
) =>
  Layer.effect(
    AttemptRuntime,
    Effect.gen(function* () {
      const runtime = yield* AttemptRuntime;
      return AttemptRuntime.of({
        ...runtime,
        cancel: (attemptId: AttemptId) =>
          Effect.gen(function* () {
            yield* Ref.update(cancels, (count) => count + 1);
            if (yield* Ref.get(unstoppable))
              return yield* new InfraFailure({
                message: "Could not cancel the parent task",
                cause: "storage unavailable",
              });
            yield* runtime.cancel(attemptId);
          }),
      });
    }),
  ).pipe(Layer.provide(stubAttemptRuntime(new StubStorage(), parent)));

/** Returns the checkout path of `attemptId` on the local Worker. */
const checkoutOf = (instance: InstanceDirectory, attemptId: AttemptId) =>
  Effect.map(Path.Path, (path) =>
    path.join(instance, ".usine", "workers", "local", "attempts", safeSegment(attemptId)),
  );

/** Waits until `cancels` counts at least `count` calls, so reconciles retried the stop. */
const retriedStops = (cancels: Ref.Ref<number>, count: number) =>
  Effect.repeat(Ref.get(cancels), {
    until: (calls) => calls >= count,
    schedule: Schedule.spaced("10 millis"),
  });

/** Returns the files of the commit that `salvage` pushed to `remote`. */
const pushedFiles = (remote: string, salvage: SalvagePushed) =>
  output("git", ["--git-dir", remote, "ls-tree", "--name-only", salvage.commit]).pipe(
    Effect.map((files) => files.trim().split("\n")),
  );

/** Waits until the checkout at `worktree` is removed. */
const removed = (worktree: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    Effect.repeat(fileSystem.exists(worktree), {
      until: (exists) => !exists,
      schedule: Schedule.spaced("10 millis"),
    }).pipe(Effect.timeout("10 seconds")),
  );

/** Returns how many Attempts the engine lists with an unconfirmed stop. */
const unconfirmedCount = Effect.flatMap(UnconfirmedStops, ({ list }) => list).pipe(
  Effect.map((stops) => stops.length),
);

describe("local worker checkout after an unconfirmed stop", () => {
  it.live(
    "keeps a failed Attempt's checkout while its parent task can't be stopped, then salvages it and retries from the salvage",
    () =>
      Effect.gen(function* () {
        const unstoppable = yield* Ref.make(true);
        const cancels = yield* Ref.make(0);
        const resumed = yield* Ref.make<ReadonlyArray<Option.Option<SalvagePushed>>>([]);
        // The first parent task writes to its checkout, then fails and stays live.
        const parent: StubParent = (context) =>
          Effect.gen(function* () {
            const seen = yield* Ref.getAndUpdate(resumed, (all) => [
              ...all,
              context.request.spec.resume,
            ]);
            if (seen.length > 0) return yield* completes(context);
            yield* Effect.sync(() =>
              writeFileSync(join(context.request.cwd, "progress.md"), "half done\n"),
            );
            return yield* new InfraFailure({ message: "Lost the parent task", cause: "offline" });
          });
        yield* withLocalEngine(
          { attemptRuntime: unstoppableRuntime(parent, unstoppable, cancels) },
          ({ engine, instance, remote }) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const accepted = yield* engine.submit(submission(1));
              assert(accepted._tag === "Claimed");

              // The checkout stays with its work, and the Run starts no retry, across the
              // reconciles that retry the stop.
              yield* retriedStops(cancels, 4);
              const waiting = yield* engine.inspect(accepted.runId);
              const [failed] = waiting.attempts;
              assert(failed !== undefined);
              assert.lengthOf(waiting.attempts, 1);
              assert.deepStrictEqual(
                Option.map(failed.outcome, ({ _tag }) => _tag),
                Option.some("Failed"),
              );
              assert.isTrue(Option.isNone(failed.salvage));
              const worktree = yield* checkoutOf(instance, failed.id);
              assert.strictEqual(
                yield* fileSystem.readFileString(join(worktree, "progress.md")),
                "half done\n",
              );
              assert.strictEqual(yield* unconfirmedCount, 1);

              // Once a retried stop succeeds, the checkout is salvaged and removed, and the retry
              // resumes from the salvage.
              yield* Ref.set(unstoppable, false);
              const delivered = yield* waitFor(engine, accepted.runId, "Succeeded");
              assert.lengthOf(delivered.attempts, 2);
              const salvage = yield* waitForSalvage(engine, accepted.runId);
              assert(salvage._tag === "Pushed");
              assert.include(yield* pushedFiles(remote, salvage), "progress.md");
              yield* removed(worktree);
              assert.deepStrictEqual((yield* Ref.get(resumed)).map(Option.map(({ ref }) => ref)), [
                Option.none(),
                Option.some(salvage.ref),
              ]);
              assert.strictEqual(yield* unconfirmedCount, 0);
            }),
        ).pipe(Effect.provideService(ReconcileInterval, "50 millis"));
      }),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "keeps a canceled Attempt's checkout while its parent task can't be stopped, then salvages it",
    () =>
      Effect.gen(function* () {
        const unstoppable = yield* Ref.make(false);
        const cancels = yield* Ref.make(0);
        yield* withLocalEngine(
          { attemptRuntime: unstoppableRuntime(worksFor(30_000), unstoppable, cancels) },
          ({ engine, instance, remote }) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const accepted = yield* engine.submit(submission(2));
              assert(accepted._tag === "Claimed");
              const running = yield* waitFor(engine, accepted.runId, "Running");
              const [attempt] = running.attempts;
              assert(attempt !== undefined);
              yield* waitForStarted(engine, attempt.id);
              const worktree = yield* checkoutOf(instance, attempt.id);
              yield* fileSystem.writeFileString(join(worktree, "progress.md"), "half done\n");

              yield* Ref.set(unstoppable, true);
              const refusal = yield* Effect.flip(engine.cancel(accepted.runId));
              assert.strictEqual(refusal._tag, "AttemptCancellationError");
              const before = yield* Ref.get(cancels);
              yield* retriedStops(cancels, before + 3);
              const canceled = yield* engine.inspect(accepted.runId);
              assert.strictEqual(canceled.run.state._tag, "Canceled");
              assert.isTrue(canceled.attempts.every(({ salvage }) => Option.isNone(salvage)));
              assert.strictEqual(
                yield* fileSystem.readFileString(join(worktree, "progress.md")),
                "half done\n",
              );

              yield* Ref.set(unstoppable, false);
              const salvage = yield* waitForSalvage(engine, accepted.runId);
              assert(salvage._tag === "Pushed");
              assert.include(yield* pushedFiles(remote, salvage), "progress.md");
              yield* removed(worktree);
            }),
        ).pipe(Effect.provideService(ReconcileInterval, "50 millis"));
      }),
    LIVE_TEST_TIMEOUT,
  );
});
