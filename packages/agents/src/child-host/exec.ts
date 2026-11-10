import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Option,
  PlatformError,
  Predicate,
  Queue,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type ExecShell,
  type HostInvocation,
  HostUnreachable,
  remoteCommandLine,
  remoteInput,
} from "./child-host.ts";

/** The exit code that an `ExecShell` handle reports after `kill`, as for a process that TERM ended. */
const KILLED = ChildProcessSpawner.ExitCode(143);

const transportFailure = (method: string, unreachable: HostUnreachable) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ExecShell",
    method,
    description: unreachable.message,
    cause: unreachable,
  });

const unsupported = (method: string) =>
  PlatformError.badArgument({
    module: "ExecShell",
    method,
    description: "An exec shell has no file descriptors other than the standard streams",
  });

/**
 * Returns the `HostUnreachable` that an `ExecShell` handle failed with, or `None` for any other
 * error.
 */
export const unreachableCause = (
  error: PlatformError.PlatformError,
): Option.Option<HostUnreachable> =>
  Schema.is(HostUnreachable)(error.reason.cause) ? Option.some(error.reason.cause) : Option.none();

/**
 * Returns the command's stdin from `options`: a stream, a queue that the handle's `stdin` sink
 * fills when the command input is `"pipe"`, or no input when the options set none, so a command
 * that reads stdin doesn't wait for a writer that doesn't exist.
 */
const stdinOf = Effect.fnUntraced(function* (
  host: ExecShell,
  input: ChildProcess.CommandOptions["stdin"],
) {
  const config: ChildProcess.StdinConfig | undefined =
    input === undefined || Predicate.isString(input) || Stream.isStream(input)
      ? input === undefined
        ? undefined
        : { stream: input }
      : input;
  const stream = config?.stream;
  if (Stream.isStream(stream)) {
    const relayed = stream.pipe(
      Stream.catch((error) =>
        Effect.logWarning("The input of a command on an exec shell failed; closing its stdin", {
          host: host.destination,
          message: error.message,
        }).pipe(Stream.fromEffectDrain),
      ),
    );
    return {
      stream: config?.endOnDone === false ? Stream.concat(relayed, Stream.never) : relayed,
      sink: Sink.drain,
    };
  }
  if (stream === undefined || stream === "ignore" || stream === "inherit")
    return { stream: Stream.empty, sink: Sink.drain };
  const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  return {
    stream: Stream.fromQueue(queue).pipe(Stream.catch(() => Stream.empty)),
    sink: Sink.forEach((bytes: Uint8Array) => Queue.offer(queue, bytes)).pipe(
      Sink.ensuring(Queue.end(queue)),
    ),
  };
});

/**
 * Starts `invocation` on `host` through its transport and returns a handle that behaves as a
 * process's: `stdout` and `stderr` end with every byte received, `exitCode` fails with a
 * `PlatformError` whose cause is `HostUnreachable` if the transport loses the command, and `kill`
 * cancels the command and reports exit code 143. The handle has no process ID or other file
 * descriptors. Dies if `environment` is not empty or the options ask for extra file descriptors.
 */
export const execHandle: (
  host: ExecShell,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
  options: ChildProcess.CommandOptions,
) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, never, Scope.Scope> = Effect.fnUntraced(
  function* (host, invocation, options) {
    const names = Object.keys(invocation.environment);
    if (names.length > 0)
      return yield* Effect.die(
        new Error(`Cannot pass ${names.join(", ")} to a remote command on its command line`),
      );
    if (options.additionalFds !== undefined && Object.keys(options.additionalFds).length > 0)
      return yield* Effect.die(new Error("An exec shell has no file descriptors beyond stdio"));
    const scope = yield* Scope.Scope;
    const call = yield* Scope.fork(scope);
    const stdin = yield* stdinOf(host, options.stdin);
    const process = yield* host.transport
      .run(remoteCommandLine(host, invocation), remoteInput(host, stdin.stream))
      .pipe(Scope.provide(call));
    const exited = yield* Deferred.make<
      ChildProcessSpawner.ExitCode,
      PlatformError.PlatformError
    >();
    yield* process.exitCode.pipe(
      Effect.mapBoth({
        onSuccess: ChildProcessSpawner.ExitCode,
        onFailure: (unreachable) => transportFailure("exitCode", unreachable),
      }),
      Deferred.into(exited),
      Effect.forkIn(scope),
    );
    const kill = () =>
      Effect.gen(function* () {
        // Settles the exit code before the transport reports the cancelled call as lost.
        if (!(yield* Deferred.succeed(exited, KILLED))) return;
        yield* Effect.logDebug("Cancelled a command on an exec shell", { host: host.destination });
        yield* Scope.close(call, Exit.void);
      });
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(0),
      stdin: stdin.sink,
      stdout: process.stdout,
      stderr: process.stderr,
      all: Stream.merge(process.stdout, process.stderr),
      exitCode: Deferred.await(exited),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill,
      getInputFd: () => Sink.fail(unsupported("getInputFd")),
      getOutputFd: () => Stream.fail(unsupported("getOutputFd")),
      unref: Effect.succeed(Effect.void),
    });
  },
);
