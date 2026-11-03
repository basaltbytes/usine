import type { Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError, type HarnessCapability } from "@usine/core/agent/capability";
import { Effect, Option } from "effect";
import { type ChildHost, SSH_FAILURE } from "../child-host/child-host.ts";
import { hostOutput } from "../child-host/command.ts";
import { SessionOperationError } from "../runtime.ts";

/** Returns the error for a readiness command that exited non-zero; the message includes the command but not its output. */
export const probeFailed = (
  harness: Harness,
  capability: HarnessCapability,
  command: string,
  args: ReadonlyArray<string>,
) =>
  HarnessUnavailableError.make({
    harness,
    capability,
    message: `${command} ${args.join(" ")} failed. Check the ${harness} installation and login on the worker.`,
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
  const output = hostOutput(host, { environment, command, args });
  const reachable =
    host._tag === "RemoteShell"
      ? output.pipe(
          Effect.filterOrFail(
            (result) => result.exitCode !== SSH_FAILURE,
            () =>
              SessionOperationError.make({
                operation: "launch",
                sessionId: Option.none(),
                message: `Can't reach ${host.destination} to run ${command}`,
                cause: new Error(`${host.ssh.command} exited with code ${SSH_FAILURE}`),
              }),
          ),
        )
      : output;
  return yield* reachable.pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTags({
      PlatformError: () =>
        HarnessUnavailableError.make({
          harness,
          capability,
          message: `The worker can't run ${command}`,
        }),
      TimeoutError: (cause) =>
        SessionOperationError.make({
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
