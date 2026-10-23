import type { Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError, type HarnessCapability } from "@usine/core/agent/capability";
import { Effect, Option, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildHost } from "../child-host/child-host.ts";
import { hostCommand } from "../child-host/command.ts";
import { SessionOperationError } from "../runtime.ts";

/** The exit code OpenSSH returns if it cannot connect or run the remote command. */
const SSH_FAILURE = 255;

/** The trimmed stdout and exit code of a readiness command. */
interface ProbeOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Returns the error for a readiness command that exited non-zero; the message includes the command but not its output. */
export const probeFailed = (
  harness: Harness,
  capability: HarnessCapability,
  command: string,
  args: ReadonlyArray<string>,
) =>
  new HarnessUnavailableError({
    harness,
    capability,
    message: `${command} ${args.join(" ")} failed; check the Worker's ${harness} installation and login`,
  });

/**
 * Runs a readiness command on `host` with a 30-second timeout and returns its trimmed stdout and
 * exit code; stderr is discarded. If the remote host is unreachable or the command times out, fails
 * with `SessionOperationError`.
 */
export const probeOutput = Effect.fn("HarnessPreflight.command")(function* (
  host: ChildHost,
  environment: Readonly<Record<string, string>>,
  harness: Harness,
  capability: HarnessCapability,
  command: string,
  args: ReadonlyArray<string>,
) {
  yield* Effect.annotateCurrentSpan({ harness, capability, host: host._tag });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        hostCommand(
          host,
          { environment, command, args },
          { detached: false, forceKillAfter: "2 seconds" },
        ),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (host._tag === "RemoteShell" && exitCode === SSH_FAILURE)
        return yield* new SessionOperationError({
          operation: "launch",
          sessionId: Option.none(),
          message: `Could not reach ${host.destination} to run ${command}`,
          cause: new Error(`${host.ssh.command} exited with code ${SSH_FAILURE}`),
        });
      return { stdout: stdout.trim(), exitCode } satisfies ProbeOutput;
    }),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTags({
      PlatformError: () =>
        new HarnessUnavailableError({
          harness,
          capability,
          message: `Worker cannot execute ${command}`,
        }),
      TimeoutError: (cause) =>
        new SessionOperationError({
          operation: "launch",
          sessionId: Option.none(),
          message: `${command} readiness check timed out`,
          cause,
        }),
    }),
  );
});

/** Runs a readiness command and returns its trimmed stdout. Fails with `HarnessUnavailableError` if the command exits non-zero. */
export const probeCommand = (
  host: ChildHost,
  environment: Readonly<Record<string, string>>,
  harness: Harness,
  capability: HarnessCapability,
  command: string,
  args: ReadonlyArray<string>,
) =>
  probeOutput(host, environment, harness, capability, command, args).pipe(
    Effect.flatMap(({ stdout, exitCode }) =>
      exitCode === 0
        ? Effect.succeed(stdout)
        : Effect.fail(probeFailed(harness, capability, command, args)),
    ),
  );
