import type { AttemptId } from "@usine/core/attempt";
import { GitHubPushFailure } from "@usine/core/attempt/failure";
import { SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha, type RepositoryName } from "@usine/core/repository";
import { Effect, Option, Schema } from "effect";
import { ExecutorOperationError } from "./executor.ts";

export const PUSH_TRACE_FILE = "usine-git-trace.jsonl";

const TraceEvent = Schema.Struct({
  event: Schema.String,
  sid: Schema.String,
  argv: Schema.optional(Schema.Array(Schema.String)),
  name: Schema.optional(Schema.String),
  msg: Schema.optional(Schema.String),
});
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(TraceEvent));

const scrubDiagnostic = (text: string) =>
  text
    .replace(/(https?:\/\/)[^/\s'"]*@/gu, "$1[REDACTED]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]");

export const githubPushFailure = (repository: RepositoryName, ref: string, message: string) =>
  new GitHubPushFailure({
    repository,
    ref: scrubDiagnostic(ref),
    message: `GitHub refused the push to ${repository} at ${scrubDiagnostic(ref)} (HTTP 403). The token is a single-repository installation token. GitHub's message: ${scrubDiagnostic(message)}`,
  });

/** Git options that take a value consume it before refspecs are resolved. */
const destinations = Effect.fn("Executor.pushDestinations")(function* <E>(
  argv: ReadonlyArray<string>,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>,
) {
  const args = argv.slice(argv.indexOf("push") + 1);
  const positional: Array<string> = [];
  let skip = false;
  let repository: string | undefined;
  const patterns: Array<string> = [];
  for (const arg of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (arg.startsWith("--repo=")) repository = arg.slice("--repo=".length);
    if (arg === "--repo") repository = args[args.indexOf(arg) + 1];
    if (arg === "--all" || arg === "--branches") patterns.push("refs/heads/*");
    if (arg === "--tags") patterns.push("refs/tags/*");
    if (arg === "--mirror") patterns.push("refs/*");
    if (["--repo", "--receive-pack", "--exec", "--push-option", "-o"].includes(arg)) {
      skip = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  const specs = positional.slice(1);
  const remote = Option.fromNullishOr(positional[0] ?? repository);
  if (specs[0] === "tag" && specs[1])
    return { remote, refs: [...patterns, `refs/tags/${specs[1]}`] };
  return {
    remote,
    refs: [
      ...patterns,
      ...(yield* Effect.forEach(specs, (spec) => {
        const unforced = spec.replace(/^\+/u, "");
        if (unforced.includes(":")) {
          const ref = unforced.split(":").at(-1) ?? unforced;
          return Effect.succeed(ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);
        }
        return git(["rev-parse", "--symbolic-full-name", unforced]).pipe(
          Effect.map((ref) => ref.trim() || unforced),
        );
      })),
    ],
  };
});

const defaultDestination = Effect.fn("Executor.defaultPushDestination")(function* <E>(
  explicitRemote: Option.Option<string>,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>,
) {
  const branch = (yield* git(["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
  const name = branch.replace(/^refs\/heads\//u, "");
  const entries = (yield* git(["config", "--null", "--list"])).split("\0").map((entry) => {
    const separator = entry.indexOf("\n");
    return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
  });
  const config = new Map(entries);
  const upstreamRemote = config.get(`branch.${name}.remote`);
  const remote = Option.getOrElse(
    explicitRemote,
    () =>
      config.get(`branch.${name}.pushremote`) ??
      config.get("remote.pushdefault") ??
      upstreamRemote ??
      "origin",
  );
  const configured = entries
    .filter(([key]) => key === `remote.${remote}.push`)
    .map(([, spec]) => spec);
  if (configured.length > 0)
    return (yield* destinations(["push", remote, ...configured], git)).refs.join(", ");
  const mode = config.get("push.default") ?? "simple";
  if (mode === "matching") return "refs/heads/*";
  if (mode !== "current" && remote === upstreamRemote)
    return config.get(`branch.${name}.merge`) ?? branch;
  return branch;
});

/** Reads Git's structured errors, correlating transport children with their push command. */
export const readPushRefusal = Effect.fn("Executor.readPushRefusal")(function* <E>(options: {
  readonly attemptId: AttemptId;
  readonly repository: RepositoryName;
  readonly worktree: string;
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
  /** Returns an empty string when the trace is absent; credentials are scrubbed by the adapter. */
  readonly readFile: (path: string) => Effect.Effect<string, E>;
}) {
  yield* Effect.annotateCurrentSpan({
    attemptId: options.attemptId,
    repository: options.repository,
  });
  const git = (args: ReadonlyArray<string>) => options.git(["-C", options.worktree, ...args]);
  const directory = (yield* git(["rev-parse", "--absolute-git-dir"])).trim();
  const trace = yield* options.readFile(`${directory}/${PUSH_TRACE_FILE}`);
  const starts = new Map<string, ReadonlyArray<string>>();
  const pushes = new Set<string>();
  for (const line of trace.split("\n")) {
    if (line === "") continue;
    const parsed = decodeEvent(line);
    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("Ignored an incomplete Git trace event", {
        attemptId: options.attemptId,
        repository: options.repository,
        worktree: options.worktree,
      });
      continue;
    }
    const event = parsed.value;
    if ((event.event === "start" || event.event === "alias") && event.argv)
      starts.set(event.sid, event.argv);
    if (event.event === "cmd_name" && event.name === "push") pushes.add(event.sid);
    if (event.event !== "error" || !event.msg?.includes("The requested URL returned error: 403"))
      continue;
    const push = [...pushes].find((sid) => event.sid === sid || event.sid.startsWith(`${sid}/`));
    if (!push) continue;
    const transportSession = event.sid.split("/").slice(0, -1);
    const diagnosticPath =
      transportSession.length > 0 &&
      transportSession.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))
        ? Option.some(`${directory}/${PUSH_TRACE_FILE}.http/${transportSession.join("/")}.stderr`)
        : Option.none();
    const diagnostic = Option.isSome(diagnosticPath)
      ? yield* options.readFile(diagnosticPath.value)
      : "";
    const head = Option.isSome(diagnosticPath)
      ? (yield* options.readFile(`${diagnosticPath.value}.head`)).trim()
      : "";
    const resolve = (args: ReadonlyArray<string>) =>
      head &&
      args[0] === "rev-parse" &&
      args[1] === "--symbolic-full-name" &&
      (args[2] === "HEAD" || args[2] === "@")
        ? Effect.succeed(head)
        : git(args);
    const destination = yield* destinations(starts.get(push) ?? [], resolve);
    const ref =
      destination.refs.length > 0
        ? destination.refs.join(", ")
        : yield* defaultDestination(destination.remote, resolve);
    const failure = githubPushFailure(options.repository, ref, diagnostic.trim() || event.msg);
    yield* Effect.logError("GitHub refused an agent push; retaining its checkout", {
      attemptId: options.attemptId,
      repository: options.repository,
      ref: failure.ref,
      message: failure.message,
    });
    const commit = yield* Schema.decodeUnknownEffect(CommitSha)(
      (yield* git(["rev-parse", "HEAD"])).trim(),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutorOperationError({
            operation: "cleanup",
            message: "Git returned an invalid object ID",
            cause,
          }),
      ),
    );
    return Option.some(
      new SalvageRetained({
        path: options.worktree,
        commit: Option.some(commit),
        message: failure.message,
        pushFailure: Option.some(failure),
      }),
    );
  }
  return Option.none<SalvageRetained>();
});
