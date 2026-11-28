import type { HarnessDescriptor } from "../harness/harness.ts";
import type { ProbeTarget } from "../harness/runtime.ts";
import type { Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError, type HarnessCapability } from "@usine/core/agent/capability";
import { Effect, Option } from "effect";
import type { ChildHost } from "../child-host/child-host.ts";
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
 * stderr, and its exit code. If the remote host is unreachable or the command times out, fails
 * with `SessionOperationError`. Dies if `host` is a remote shell and `environment` is not empty.
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
  return yield* hostOutput(host, { environment, command, args }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTags({
      HostUnreachable: (unreachable) =>
        SessionOperationError.make({
          operation: "launch",
          sessionId: Option.none(),
          message: `Can't reach ${unreachable.destination} to run ${command}`,
          cause: unreachable,
        }),
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

/** The exit codes of a shell that can't find or execute a command. */
const NOT_INSTALLED = new Set([126, 127]);

/**
 * Checks a runtime prerequisite with `command --version`, or the `run` command line that runs it,
 * and returns its stdout. Fails with the target's installation guidance if the command can't run,
 * and with its exit code if it ran and failed; the log entry of that failure has the end of its
 * stderr, which the error message leaves out.
 */
export const probeBinary = Effect.fn("HarnessPreflight.binary")(function* (
  descriptor: HarnessDescriptor,
  target: ProbeTarget,
  command: string,
  args: ReadonlyArray<string>,
  run: { readonly command: string; readonly args: ReadonlyArray<string> } = { command, args },
) {
  const { host, environment, placement, credential } = target;
  yield* Effect.annotateCurrentSpan({ harness: descriptor.id, worker: target.worker, credential });
  const where = placement === "sandbox" ? "in the sandbox image" : "on the worker";
  const failed = () =>
    HarnessUnavailableError.make({
      harness: descriptor.id,
      capability: "binary",
      message:
        placement === "sandbox"
          ? `${command} --version failed ${where}. Check the ${descriptor.label} installation in the sandbox image.`
          : command === "node" && credential !== "host-login"
            ? `Remote ${descriptor.label} children require Node.js on the worker's command path.`
            : `${command} --version failed. Check the ${descriptor.label} installation${credential === "host-login" ? " and login" : ""} on the worker.`,
    });
  const result = yield* probeOutput(
    host,
    environment,
    descriptor.id,
    "binary",
    run.command,
    run.args,
  ).pipe(Effect.catchTag("HarnessUnavailableError", () => failed()));
  if (result.exitCode !== 0) {
    yield* Effect.logWarning("Harness prerequisite check failed", {
      harness: descriptor.id,
      worker: target.worker,
      credential,
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-1000),
    });
    if (NOT_INSTALLED.has(result.exitCode)) return yield* failed();
    return yield* HarnessUnavailableError.make({
      harness: descriptor.id,
      capability: "binary",
      message: `${command} --version exited with code ${result.exitCode} ${where}. The log entry "Harness prerequisite check failed" has its error output.`,
    });
  }
  yield* Effect.logInfo("Harness prerequisite verified", {
    harness: descriptor.id,
    worker: target.worker,
    credential,
    command,
    version: result.stdout,
  });
  return result.stdout;
});
