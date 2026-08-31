import { Attempt, Worker } from "@usine/core";
import { Effect, PartitionedSemaphore, Ref, Schema } from "effect";
import { ExecutorOperationError } from "../index.ts";
import type { ExeDevCommands } from "./commands.ts";
import type { VmState } from "./model.ts";

const directChildren = (
  parent: string,
  output: string,
): Effect.Effect<ReadonlyArray<string>, ExecutorOperationError> => {
  const prefix = `${parent}/`;
  const DirectChild = Schema.String.check(
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
  return Schema.decodeUnknownEffect(Schema.Array(DirectChild))(
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
};

/** Reclaims crash leftovers once, before this process starts work on a VM. */
export const abandonedWorktreeSweepFor = Effect.fn("ExeDevExecutor.abandonedWorktreeSweepFor")(
  function* (commands: ExeDevCommands) {
    const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
    const swept = yield* Ref.make(new Set<Worker.Name>());

    const sweep = Effect.fn("ExeDevExecutor.sweepAbandonedWorktrees")(function* (
      attemptId: Attempt.AttemptId,
      worker: Worker.Name,
      vm: VmState,
      root: string,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId, worker, host: vm.sshDest });
      yield* locks.withPermit(worker)(
        Effect.gen(function* () {
          if ((yield* Ref.get(swept)).has(worker)) {
            yield* Effect.logDebug("exe.dev abandoned-worktree sweep was already complete", {
              attemptId,
              worker,
              host: vm.sshDest,
            });
            return;
          }

          const attemptsRoot = `${root}/attempts`;
          const reposRoot = `${root}/repos`;
          yield* Effect.logInfo("Sweeping abandoned exe.dev Attempt worktrees", {
            attemptId,
            worker,
            host: vm.sshDest,
          });
          yield* commands.remote("prepare", vm, "mkdir", ["-p", attemptsRoot, reposRoot]);

          const attempts = yield* commands
            .remote("prepare", vm, "find", [
              attemptsRoot,
              "-mindepth",
              "1",
              "-maxdepth",
              "1",
              "-print0",
            ])
            .pipe(Effect.flatMap((output) => directChildren(attemptsRoot, output)));
          for (const worktree of attempts) {
            yield* Effect.logInfo("Sweeping abandoned exe.dev Attempt worktree", {
              attemptId,
              worker,
              host: vm.sshDest,
              worktree,
            });
            yield* commands.remote("prepare", vm, "rm", ["-rf", worktree]);
          }

          const caches = yield* commands
            .remote("prepare", vm, "find", [
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
              commands.remote("prepare", vm, "git", ["--git-dir", cache, "worktree", "prune"]).pipe(
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
            { concurrency: "unbounded", discard: true },
          );

          yield* Ref.update(swept, (current) => new Set(current).add(worker));
          yield* Effect.logInfo("exe.dev abandoned-worktree sweep completed", {
            attemptId,
            worker,
            host: vm.sshDest,
            removed: attempts.length,
            caches: caches.length,
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("exe.dev abandoned-worktree sweep failed", {
              attemptId,
              worker,
              host: vm.sshDest,
              message: error.message,
            }),
          ),
        ),
      );
    });

    return sweep;
  },
);
