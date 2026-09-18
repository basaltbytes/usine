import { AttemptId } from "@usine/core/attempt";
import { WorkerName } from "@usine/core/worker";
import { Effect, Ref, Schema } from "effect";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
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
  operation: ExecutorOperation,
  parent: string,
  output: string,
): Effect.Effect<ReadonlyArray<string>, ExecutorOperationError> =>
  Schema.decodeUnknownEffect(Schema.Array(directChildSchema(parent)))(
    output.split("\0").filter((value) => value.length > 0),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutorOperationError({
          operation,
          message: `Worker returned an invalid path while listing ${parent}`,
          cause,
        }),
    ),
  );

/**
 * Lists the paths directly under a Worker's `attempts` directory, creating the
 * directory first so a Worker that never ran an Attempt lists as empty. Every
 * returned path is verified to be a direct child of `attemptsRoot`.
 */
export const attemptPathsOn = Effect.fn("ExeDevExecutor.attemptPathsOn")(function* (
  commands: ExeDevCommands,
  operation: ExecutorOperation,
  vm: VmState,
  attemptsRoot: string,
) {
  yield* Effect.annotateCurrentSpan({ host: vm.sshDest, operation, attemptsRoot });
  yield* commands.remote(operation, vm.sshDest, "mkdir", ["-p", attemptsRoot]);
  const output = yield* commands.remote(operation, vm.sshDest, "find", [
    attemptsRoot,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-print0",
  ]);
  return yield* directChildren(operation, attemptsRoot, output);
});

/**
 * Preserves crash leftovers and prunes stale cache registrations once per Worker.
 * Only durable Attempt recovery may authorize removing an existing checkout.
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
          // Mark the sweep done before it runs. A partial sweep must not retry in
          // front of every prepare; the next process start reclaims what failed.
          yield* Ref.update(swept, (current) => new Set(current).add(worker));

          const attemptsRoot = `${root}/attempts`;
          const reposRoot = `${root}/repos`;
          yield* Effect.logInfo("Sweeping abandoned exe.dev Attempt worktrees", {
            attemptId,
            worker,
            host: vm.sshDest,
          });
          yield* commands.remote("prepare", vm.sshDest, "mkdir", ["-p", reposRoot]);

          const attempts = yield* attemptPathsOn(commands, "prepare", vm, attemptsRoot);
          // An unrecognized path can contain unsalvaged work from a crash. Only
          // recovery from the durable Attempt record may authorize its removal.
          yield* Effect.forEach(
            attempts,
            (worktree) =>
              Effect.logWarning("Preserving abandoned exe.dev path for salvage reconciliation", {
                attemptId,
                worker,
                host: vm.sshDest,
                worktree,
              }),
            { discard: true },
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
            .pipe(Effect.flatMap((output) => directChildren("prepare", reposRoot, output)));
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

          yield* Effect.logInfo("exe.dev abandoned-worktree sweep completed", {
            attemptId,
            worker,
            host: vm.sshDest,
            retained: attempts.length,
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
