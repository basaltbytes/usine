import { preflight } from "@usine/agents/preflight";
import type { HarnessReadiness } from "@usine/core/agent/capability";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ExecutorOperationError } from "../executor.ts";
import type { HarnessProbe } from "../harness-preflight.ts";

/**
 * Checks one brain in this process with the harness CLIs and SDKs, as the run
 * host's `--preflight` does on a remote Worker. The probe's commands see only
 * `environment`, never the orchestrator's own (ADR 0011). A timed-out probe
 * stays a retryable infrastructure error.
 */
export const agentsHarnessProbe =
  (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    environment: Record<string, string>,
  ): HarnessProbe =>
  (brain) =>
    preflight(brain).pipe(
      Effect.map((ready): HarnessReadiness => ready),
      Effect.catchTag("HarnessUnavailableError", (unavailable) => Effect.succeed(unavailable)),
      Effect.mapError(
        (cause) =>
          new ExecutorOperationError({
            operation: "preflight",
            message: cause.message,
            cause,
          }),
      ),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          command._tag === "StandardCommand"
            ? spawner.spawn(
                ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  env: environment,
                  extendEnv: false,
                }),
              )
            : Effect.die(new Error("Harness readiness probes run single commands, not pipelines")),
        ),
      ),
    );
