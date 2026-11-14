import { SupervisorUnavailable } from "@usine/agents/supervisor";
import type { ContainerImage } from "@usine/core/worker";
import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";
import type { ContainerRuntime } from "../remote/runtime.ts";

export const prepareImage = Effect.fn("SupervisorSandbox.prepareImage")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  image: ContainerImage,
  pullTimeout: Option.Option<Duration.Duration>,
) {
  yield* Effect.annotateCurrentSpan({ runtime, image });
  const cached = yield* collectCommand(
    spawner,
    "preflight",
    runtime,
    ["image", "inspect", image],
    { forceKillAfter: "2 seconds" },
    65536,
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      SupervisorUnavailable.make({
        message: `Cannot prepare the supervisor image: ${cause.message}`,
      }),
    ),
  );
  if (cached.exitCode === 0) {
    yield* Effect.logInfo("Using the cached supervisor image", { runtime, image });
    return;
  }
  yield* Effect.logInfo("Pulling the supervisor image", { runtime, image });
  const pull = Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(runtime, ["pull", image], { forceKillAfter: "2 seconds" }),
    );
    return yield* Effect.all(
      {
        exitCode: handle.exitCode,
        stdout: Stream.runDrain(handle.stdout),
        stderr: handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, text) => (tail + text).slice(-8192),
          ),
        ),
      },
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.scoped);
  const pulled = yield* pull.pipe(
    Effect.timeout(Option.getOrElse(pullTimeout, () => Duration.infinity)),
    Effect.mapError((cause) =>
      SupervisorUnavailable.make({ message: `Cannot pull the supervisor image: ${cause.message}` }),
    ),
  );
  if (Number(pulled.exitCode) !== 0)
    return yield* SupervisorUnavailable.make({
      message: `Cannot pull the supervisor image: ${pulled.stderr.trim().split("\n")[0]}`,
    });
  yield* Effect.logInfo("The supervisor image is ready", { runtime, image });
});
