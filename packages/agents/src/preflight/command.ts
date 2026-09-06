import type { Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError, type HarnessCapability } from "@usine/core/agent/capability";
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { homedir } from "node:os";
import { SessionOperationError } from "../runtime.ts";

/** Runs a bounded readiness command without retaining its potentially sensitive diagnostics. */
export const probeCommand = Effect.fn("HarnessPreflight.command")(function* (
  harness: Harness,
  capability: HarnessCapability,
  command: string,
  args: ReadonlyArray<string>,
) {
  yield* Effect.annotateCurrentSpan({ harness, capability });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd: homedir(),
          detached: false,
          forceKillAfter: "2 seconds",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0)
        return yield* new HarnessUnavailableError({
          harness,
          capability,
          message: `${command} ${args.join(" ")} failed; check the Worker's ${harness} installation and login`,
        });
      return stdout.trim();
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
