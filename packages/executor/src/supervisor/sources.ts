import { SupervisorSource, SupervisorUnavailable } from "@usine/agents/supervisor";
import { CommitSha, type RepositoryName, safeSegment } from "@usine/core/repository";
import { Clock, Duration, Effect, FileSystem, Option, Redacted, Schema } from "effect";
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

/** How long an exported tree that is no longer the head stays, for a turn that still reads it. */
const STALE_TREE_AGE = Duration.days(1);

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

/**
 * Returns the source of `repositories` that supervisor sessions read: the head of each
 * repository's default branch when the turn starts. Each repository has a shallow bare cache in
 * `<root>/repos`, which this fetches; each head's tree is exported once, without git history,
 * to `<root>/trees/<repository>/<commit>`. Trees that are no longer a head are removed after a
 * day. Fails with `SupervisorUnavailable` if a repository can't be fetched or exported.
 */
export const prepareSupervisorSources = Effect.fn("SupervisorSources.prepare")(function* (
  root: string,
  repositories: ReadonlyArray<RepositoryName>,
  origin: SourceOrigin,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
  const prepare = Effect.fn("SupervisorSources.repository")(function* (repository: RepositoryName) {
    yield* Effect.annotateCurrentSpan({ repository });
    const segment = safeSegment(repository);
    const cache = `${root}/repos/${segment}.git`;
    const trees = `${root}/trees/${segment}`;
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
      yield* Effect.logDebug("The supervisor source is current", { repository, revision });
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
    yield* removeStaleTrees(trees, revision).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not remove stale supervisor source trees", {
          repository,
          message: error.message,
        }),
      ),
      Effect.ignore,
    );
    return SupervisorSource.make({ repository, revision, directory: tree });
  });
  const removeStaleTrees = Effect.fn("SupervisorSources.removeStale")(function* (
    trees: string,
    current: CommitSha,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of yield* fs.readDirectory(trees)) {
      if (entry === current) continue;
      const { mtime } = yield* fs.stat(`${trees}/${entry}`);
      if (Option.isNone(mtime) || now - mtime.value.getTime() < Duration.toMillis(STALE_TREE_AGE))
        continue;
      yield* fs.remove(`${trees}/${entry}`, { recursive: true });
      yield* Effect.logInfo("Removed a stale supervisor source tree", { tree: entry });
    }
  });
  return yield* Effect.forEach(repositories, prepare);
});
