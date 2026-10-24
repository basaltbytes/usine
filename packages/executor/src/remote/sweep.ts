import type { RemoteShell } from "@usine/agents/child-host";
import { AttemptId } from "@usine/core/attempt";
import { WorkerName } from "@usine/core/worker";
import { Effect, Ref, Schema } from "effect";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { RemoteCommands } from "./commands.ts";

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
 * Lists paths directly under a Worker's `attempts` directory, creating it first so a new Worker
 * lists as empty. Verifies that each path is a direct child of `attemptsRoot`.
 */
export const attemptPathsOn = Effect.fn("RemoteExecutor.attemptPathsOn")(function* (
  commands: RemoteCommands,
  operation: ExecutorOperation,
  shell: RemoteShell,
  attemptsRoot: string,
) {
  yield* Effect.annotateCurrentSpan({ host: shell.destination, operation, attemptsRoot });
  yield* commands.run(operation, shell, "mkdir", ["-p", attemptsRoot]);
  const output = yield* commands.run(operation, shell, "find", [
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
 * Returns a sweep that prunes stale cache registrations once per Worker and keeps crash
 * leftovers. Only durable Attempt recovery removes an existing checkout.
 */
export const abandonedWorktreeSweepFor = Effect.fn("RemoteExecutor.abandonedWorktreeSweepFor")(
  function* (commands: RemoteCommands) {
    const locks = yield* keyedLockFor<WorkerName>();
    const swept = yield* Ref.make(new Set<WorkerName>());

    const sweep = Effect.fn("RemoteExecutor.sweepAbandonedWorktrees")(function* (
      attemptId: AttemptId,
      worker: WorkerName,
      shell: RemoteShell,
      workerDirectory: string,
    ) {
      const host = shell.destination;
      yield* Effect.annotateCurrentSpan({ attemptId, worker, host });
      yield* locks.withLock(worker)(
        Effect.gen(function* () {
          if ((yield* Ref.get(swept)).has(worker)) {
            yield* Effect.logDebug("Remote abandoned-worktree sweep was already complete", {
              attemptId,
              worker,
              host,
            });
            return;
          }
          // Marked done before running so a failed sweep is not retried before every prepare; the
          // next process start retries it.
          yield* Ref.update(swept, (current) => new Set(current).add(worker));

          const attemptsRoot = `${workerDirectory}/attempts`;
          const reposRoot = `${workerDirectory}/repos`;
          yield* Effect.logInfo("Sweeping abandoned Attempt worktrees on the remote Worker", {
            attemptId,
            worker,
            host,
          });
          yield* commands.run("prepare", shell, "mkdir", ["-p", reposRoot]);

          const attempts = yield* attemptPathsOn(commands, "prepare", shell, attemptsRoot);
          // An unrecognized path can contain unsalvaged work from a crash; only recovery from the
          // durable Attempt record removes it.
          yield* Effect.forEach(
            attempts,
            (worktree) =>
              Effect.logWarning("Preserving abandoned remote path for salvage reconciliation", {
                attemptId,
                worker,
                host,
                worktree,
              }),
            { discard: true },
          );

          const caches = yield* commands
            .run("prepare", shell, "find", [
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
              commands.run("prepare", shell, "git", ["--git-dir", cache, "worktree", "prune"]).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not prune a remote cache during the sweep", {
                    attemptId,
                    worker,
                    host,
                    cache,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              ),
            { concurrency: SWEEP_CONCURRENCY, discard: true },
          );

          yield* Effect.logInfo("Remote abandoned-worktree sweep completed", {
            attemptId,
            worker,
            host,
            retained: attempts.length,
            caches: caches.length,
          });
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Remote abandoned-worktree sweep failed; continuing", {
              attemptId,
              worker,
              host,
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
