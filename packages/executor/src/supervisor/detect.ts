import { SupervisorUnavailable } from "@usine/agents/supervisor";
import { Cause, Effect, Option, Result } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";
import type { ContainerRuntime } from "../remote/runtime.ts";
import { noNewPrivileges, ROOTLESS_PODMAN_REFUSAL } from "./privileges.ts";

/** How long the runtime has to answer at startup, so that a hung daemon doesn't hold the orchestrator. */
const DETECTION_TIMEOUT = "15 seconds";

/** The container runtime that runs supervisor sandboxes, and whether it runs without root. */
export interface SandboxRuntime {
  readonly runtime: ContainerRuntime;
  readonly rootless: boolean;
}

/** The output format of `<runtime> info` that says whether the runtime runs without root. */
const rootlessFormat = {
  podman: "{{.Host.Security.Rootless}}",
  docker: "{{json .SecurityOptions}}",
} satisfies Record<ContainerRuntime, string>;

/**
 * Finds the container runtime for supervisor sandboxes: `preferred`, or Podman and then Docker.
 * Returns why there is none when no candidate is installed or can run containers.
 */
export const detectSandboxRuntime = Effect.fn("SupervisorSandbox.detectRuntime")(function* (
  preferred: Option.Option<ContainerRuntime>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const candidates = Option.match(preferred, {
    onNone: () => ["podman", "docker"] as const,
    onSome: (runtime) => [runtime] as const,
  });
  const problems: Array<string> = [];
  for (const runtime of candidates) {
    const info = yield* collectCommand(
      spawner,
      "preflight",
      runtime,
      ["info", "--format", rootlessFormat[runtime]],
      { forceKillAfter: "2 seconds" },
      65536,
    ).pipe(Effect.timeout(DETECTION_TIMEOUT), Effect.result);
    if (Result.isFailure(info)) {
      if (Cause.isTimeoutError(info.failure)) {
        problems.push(`${runtime} didn't answer within ${DETECTION_TIMEOUT}`);
        yield* Effect.logInfo("Skipped a container runtime that didn't answer", {
          runtime,
          timeout: DETECTION_TIMEOUT,
        });
        continue;
      }
      yield* Effect.logInfo("Skipped a container runtime that isn't installed", {
        runtime,
        message: info.failure.message,
      });
      continue;
    }
    if (info.success.exitCode !== 0) {
      const reason = info.success.stderr.trim().split("\n")[0] ?? "";
      const detail = reason === "" ? "" : `: ${reason}`;
      problems.push(
        runtime === "podman" && (yield* noNewPrivileges)
          ? `${ROOTLESS_PODMAN_REFUSAL} (podman${detail})`
          : `${runtime} is installed but can't run containers${detail}`,
      );
      yield* Effect.logInfo("Skipped a container runtime that can't run containers", {
        runtime,
        exitCode: info.success.exitCode,
        reason,
      });
      continue;
    }
    const output = info.success.stdout.trim();
    const rootless = runtime === "podman" ? output === "true" : output.includes("rootless");
    yield* Effect.logInfo("Found the container runtime for supervisor sandboxes", {
      runtime,
      rootless,
    });
    return Result.succeed<SandboxRuntime>({ runtime, rootless });
  }
  const names = candidates.map((runtime) => (runtime === "podman" ? "Podman" : "Docker"));
  return Result.fail(
    SupervisorUnavailable.make({
      message:
        problems.length > 0
          ? `Supervisor sessions run in a container, and ${problems.join("; ")}`
          : `Supervisor sessions run in a container, and ${names.join(" or ")} isn't installed on the orchestrator host`,
    }),
  );
});
