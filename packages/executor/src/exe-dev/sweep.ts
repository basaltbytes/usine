import { AttemptId, WorkerName } from "@usine/core/ids";
import { Effect, Ref, Schema } from "effect";
import { ExecutorOperationError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { VmState } from "./model.ts";

const SWEEP_CONCURRENCY = 4;

const directChildSchema = (parent: string): Schema.Codec<string> => {
  const prefix = `${parent}/`;
  return Schema.String.check(
    Schema.makeFilter(
      (value) => {
        const segment = value.slice(prefix.length);
        return (
          value.startsWith(prefix) &&
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !segment.includes("/")
        );
      },
      { message: `Expected a direct child of ${parent}` },
    ),
  );
};

const directChildren = (
  parent: string,
  output: string,
): Effect.Effect<ReadonlyArray<string>, ExecutorOperationError> =>
  Schema.decodeUnknownEffect(Schema.Array(directChildSchema(parent)))(
    output.split("\0").filter((value) => value.length > 0),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutorOperationError({
          operation: "prepare",
          message: `Worker returned an invalid path while sweeping ${parent}`,
          cause,
        }),
    ),
  );

/**
 * Reclaims crash leftovers once, before this process starts work on a VM.
 * Every removal is isolated: one immovable leftover must never block the
 * sweep's siblings or, worse, every future prepare on the Worker — so the
 * sweep is marked done even when parts of it failed, and each failure is
 * logged instead of propagated.
 */
export const abandonedWorktreeSweepFor = Effect.fn("ExeDevExecutor.abandonedWorktreeSweepFor")(
  function* (commands: ExeDevCommands) {
    const locks = yield* keyedLockFor<WorkerName>();
    const swept = yield* Ref.make(new Set<WorkerName>());

    const sweep = Effect.fn("ExeDevExecutor.sweepAbandonedWorktrees")(function* (
      attemptId: AttemptId,
      worker: WorkerName,
      vm: VmState,
      root: string,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId, worker, host: vm.sshDest });
      yield* locks.withLock(worker)(
        Effect.gen(function* () {
          if ((yield* Ref.get(swept)).has(worker)) {
            yield* Effect.logDebug("exe.dev abandoned-worktree sweep was already complete", {
              attemptId,
              worker,
              host: vm.sshDest,
            });
            return;
          }
          // One shot per Worker per process: a partial sweep must not retry
          // forever in front of every prepare, so mark it done up front and
          // rely on the next process start to reclaim what failed today.
          yield* Ref.update(swept, (current) => new Set(current).add(worker));

          const attemptsRoot = `${root}/attempts`;
          const reposRoot = `${root}/repos`;
          yield* Effect.logInfo("Sweeping abandoned exe.dev Attempt worktrees", {
            attemptId,
            worker,
            host: vm.sshDest,
          });
          yield* commands.remote("prepare", vm.sshDest, "mkdir", ["-p", attemptsRoot, reposRoot]);

          const attempts = yield* commands
            .remote("prepare", vm.sshDest, "find", [
              attemptsRoot,
              "-mindepth",
              "1",
              "-maxdepth",
              "1",
              "-print0",
            ])
            .pipe(Effect.flatMap((output) => directChildren(attemptsRoot, output)));
          const failures = yield* Ref.make(0);
          yield* Effect.forEach(
            attempts,
            (worktree) =>
              Effect.logInfo("Sweeping abandoned exe.dev Attempt worktree", {
                attemptId,
                worker,
                host: vm.sshDest,
                worktree,
              }).pipe(
                Effect.andThen(commands.remote("prepare", vm.sshDest, "rm", ["-rf", worktree])),
                Effect.tapError((error) =>
                  Effect.logWarning("Could not remove an abandoned exe.dev worktree", {
                    attemptId,
                    worker,
                    host: vm.sshDest,
                    worktree,
                    message: error.message,
                  }).pipe(Effect.andThen(Ref.update(failures, (count) => count + 1))),
                ),
                Effect.ignore,
              ),
            { concurrency: SWEEP_CONCURRENCY, discard: true },
          );

          const caches = yield* commands
            .remote("prepare", vm.sshDest, "find", [
              reposRoot,
              "-mindepth",
              "1",
              "-maxdepth",
              "1",
              "-type",
              "d",
              "-name",
              "*.git",
              "-print0",
            ])
            .pipe(Effect.flatMap((output) => directChildren(reposRoot, output)));
          yield* Effect.forEach(
            caches,
            (cache) =>
              commands
                .remote("prepare", vm.sshDest, "git", ["--git-dir", cache, "worktree", "prune"])
                .pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning("Could not prune an exe.dev cache during the sweep", {
                      attemptId,
                      worker,
                      host: vm.sshDest,
                      cache,
                      message: error.message,
                    }),
                  ),
                  Effect.ignore,
                ),
            { concurrency: SWEEP_CONCURRENCY, discard: true },
          );

          const failed = yield* Ref.get(failures);
          yield* Effect.logInfo("exe.dev abandoned-worktree sweep completed", {
            attemptId,
            worker,
            host: vm.sshDest,
            removed: attempts.length - failed,
            failed,
            caches: caches.length,
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("exe.dev abandoned-worktree sweep failed; continuing", {
              attemptId,
              worker,
              host: vm.sshDest,
              message: error.message,
            }),
          ),
          Effect.ignore,
        ),
      );
    });

    return sweep;
  },
);
