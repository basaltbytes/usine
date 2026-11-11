import { Deferred, Effect, Exit, Option, PlatformError, Schema, Scope, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  type ExecShell,
  type HostCommandOptions,
  type HostInput,
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
 * Returns the command's stdin: `input`'s stream, or end of file without input. If the stream fails,
 * stdin closes with a warning, even when `endOnDone` is `false`.
 */
const stdinOf = (host: ExecShell, input: HostInput | undefined): Stream.Stream<Uint8Array> => {
  if (input === undefined) return Stream.empty;
  const stream =
    input.endOnDone === false ? Stream.concat(input.stream, Stream.never) : input.stream;
  return stream.pipe(
    Stream.catch((error) =>
      Effect.logWarning("The input of a command on an exec shell failed; closing its stdin", {
        host: host.destination,
        message: error.message,
      }).pipe(Stream.fromEffectDrain),
    ),
  );
};

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
  options: HostCommandOptions,
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
    const process = yield* host.transport
      .run(remoteCommandLine(host, invocation), remoteInput(host, stdinOf(host, options.stdin)))
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
      stdin: Sink.drain,
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
