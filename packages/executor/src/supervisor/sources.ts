import { SupervisorSource, SupervisorUnavailable } from "@usine/agents/supervisor";
import { CommitSha, type RepositoryName, safeSegment } from "@usine/core/repository";
import { Effect, FileSystem, Option, Redacted, Schema, type Scope, Semaphore } from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";

/** Where the orchestrator fetches each repository's source from. */
export interface SourceOrigin {
  /** The fetch URL of `repository`. */
  readonly url: (repository: RepositoryName) => string;
  /** A token that can read `repository`, or `None` for a remote that needs no credential. */
  readonly token: (
    repository: RepositoryName,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, SupervisorUnavailable>;
}

const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

/** Git's environment for a fetch: the token as an HTTP authorization header, and no prompt. */
const fetchEnvironment = (url: string, token: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(token, {
    onNone: () => ({ GIT_TERMINAL_PROMPT: "0" }),
    onSome: (secret) => ({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Base64.encode(`x-access-token:${Redacted.value(secret)}`)}`,
    }),
  });

/** The source that supervisor turns read, prepared on the orchestrator. */
export interface SupervisorSources {
  /**
   * Returns the source of `repositories`: the head of each repository's default branch now. The
   * turn holds each tree until the scope closes, so no other turn's preparation removes it.
   * Fails with `SupervisorUnavailable` if a repository can't be fetched or exported.
   */
  readonly prepare: (
    repositories: ReadonlyArray<RepositoryName>,
  ) => Effect.Effect<ReadonlyArray<SupervisorSource>, SupervisorUnavailable, Scope.Scope>;
}

/**
 * Makes the supervisor's source under `root`, fetched from `origin`. Each repository has a shallow
 * bare cache in `<root>/repos`, and each head's tree is exported once, without git history, to
 * `<root>/trees/<repository>/<commit>`. A tree is removed once it is no longer the head and no
 * turn holds it. Preparations of one repository run one at a time; make one per `root`.
 */
export const makeSupervisorSources = Effect.fn("SupervisorSources.make")(function* (
  root: string,
  origin: SourceOrigin,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  /** The number of turns that hold each tree, by its directory. */
  const holds = new Map<string, number>();
  /** The head that each repository's latest preparation exported. */
  const heads = new Map<RepositoryName, CommitSha>();
  /** One preparation of each repository at a time, since they share its cache and trees. */
  const locks = new Map<RepositoryName, Semaphore.Semaphore>();
  const lockOf = (repository: RepositoryName) => {
    const existing = locks.get(repository);
    if (existing !== undefined) return existing;
    const lock = Semaphore.makeUnsafe(1);
    locks.set(repository, lock);
    return lock;
  };
  const run = (
    repository: RepositoryName,
    command: string,
    args: ReadonlyArray<string>,
    env: Record<string, string> = {},
  ) =>
    collectCommand(spawner, "prepare", command, args, { env, extendEnv: true }).pipe(
      Effect.filterOrFail(
        ({ exitCode }) => exitCode === 0,
        ({ stderr, exitCode }) =>
          SupervisorUnavailable.make({
            message: `Can't prepare the source of ${repository}: ${command} exited with code ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n")[0]}`}`,
          }),
      ),
      Effect.catchTag("ExecutorOperationError", (error) =>
        Effect.fail(
          SupervisorUnavailable.make({
            message: `Can't prepare the source of ${repository}: ${error.message}`,
          }),
        ),
      ),
    );
  const unavailable =
    (repository: RepositoryName, action: string) => (error: { readonly message: string }) =>
      SupervisorUnavailable.make({
        message: `Can't ${action} for the source of ${repository}: ${error.message}`,
      });
  const treesOf = (repository: RepositoryName) => `${root}/trees/${safeSegment(repository)}`;

  /** Removes the trees of `repository` that are neither its head nor held by a turn. */
  const removeUnused = Effect.fn("SupervisorSources.removeUnused")(function* (
    repository: RepositoryName,
  ) {
    const trees = treesOf(repository);
    const head = heads.get(repository);
    for (const entry of yield* fs.readDirectory(trees)) {
      const tree = `${trees}/${entry}`;
      if (entry === head) continue;
      if ((holds.get(tree) ?? 0) > 0) {
        yield* Effect.logInfo("Kept a supervisor source tree that a turn reads", {
          repository,
          tree: entry,
          turns: holds.get(tree),
        });
        continue;
      }
      yield* fs.remove(tree, { recursive: true });
      yield* Effect.logInfo("Removed a supervisor source tree that is no longer the head", {
        repository,
        tree: entry,
      });
    }
  });
  const removeUnusedLogged = (repository: RepositoryName) =>
    removeUnused(repository).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove unused supervisor source trees", {
          repository,
          message: error.message,
        }),
      ),
    );

  /** Fetches `repository` and exports its head if it is new. */
  const exportHead = Effect.fn("SupervisorSources.repository")(function* (
    repository: RepositoryName,
  ) {
    yield* Effect.annotateCurrentSpan({ repository });
    const cache = `${root}/repos/${safeSegment(repository)}.git`;
    const trees = treesOf(repository);
    if (!(yield* fs.exists(`${cache}/HEAD`).pipe(Effect.orElseSucceed(() => false)))) {
      yield* fs
        .makeDirectory(cache, { recursive: true })
        .pipe(Effect.mapError(unavailable(repository, "create the cache")));
      yield* run(repository, "git", ["init", "--bare", "--quiet", cache]);
    }
    const url = origin.url(repository);
    const token = yield* origin.token(repository);
    yield* run(
      repository,
      "git",
      ["--git-dir", cache, "fetch", "--quiet", "--depth=1", "--no-tags", url, "HEAD"],
      fetchEnvironment(url, token),
    );
    const head = yield* run(repository, "git", ["--git-dir", cache, "rev-parse", "FETCH_HEAD"]);
    const revision = yield* decodeCommit(head.stdout.trim()).pipe(
      Effect.mapError(unavailable(repository, "read the fetched head")),
    );
    const tree = `${trees}/${revision}`;
    if (yield* fs.exists(tree).pipe(Effect.orElseSucceed(() => false))) {
      yield* Effect.logInfo("Skipped exporting the supervisor source: the head's tree exists", {
        repository,
        revision,
      });
    } else {
      yield* fs
        .makeDirectory(trees, { recursive: true })
        .pipe(Effect.mapError(unavailable(repository, "create the tree directory")));
      const staging = yield* fs
        .makeTempDirectory({ directory: trees, prefix: `${revision}.exporting-` })
        .pipe(Effect.mapError(unavailable(repository, "create a staging directory")));
      yield* run(repository, "sh", [
        "-c",
        'git --git-dir "$1" archive --format=tar "$2" | tar -x -C "$3"',
        "export-tree",
        cache,
        revision,
        staging,
      ]);
      yield* fs
        .rename(staging, tree)
        .pipe(Effect.mapError(unavailable(repository, "publish the tree")));
      yield* Effect.logInfo("Exported the supervisor source of a repository", {
        repository,
        revision,
      });
    }
    heads.set(repository, revision);
    return SupervisorSource.make({ repository, revision, directory: tree });
  });

  /** Releases a turn's hold on `source`, and removes its tree if it is now unused. */
  const release = Effect.fn("SupervisorSources.release")(function* (source: SupervisorSource) {
    const remaining = (holds.get(source.directory) ?? 1) - 1;
    if (remaining > 0) holds.set(source.directory, remaining);
    else holds.delete(source.directory);
    yield* removeUnusedLogged(source.repository);
  });

  /** Prepares `repository` and holds its head's tree for the scope. */
  const prepareOne = (repository: RepositoryName) => {
    const lock = lockOf(repository);
    return lock.withPermit(
      Effect.gen(function* () {
        const source = yield* exportHead(repository);
        yield* Effect.acquireRelease(
          Effect.sync(() => holds.set(source.directory, (holds.get(source.directory) ?? 0) + 1)),
          () => lock.withPermit(release(source)),
        );
        yield* removeUnusedLogged(repository);
        return source;
      }),
    );
  };

  return {
    prepare: Effect.fn("SupervisorSources.prepare")(function* (
      repositories: ReadonlyArray<RepositoryName>,
    ) {
      return yield* Effect.forEach(repositories, prepareOne);
    }),
  } satisfies SupervisorSources;
});
