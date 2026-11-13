import { SupervisorUnavailable } from "@usine/agents/supervisor";
import type { ContainerImage } from "@usine/core/worker";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";
import type { ContainerRuntime } from "../remote/runtime.ts";

export const prepareImage = Effect.fn("SupervisorSandbox.prepareImage")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runtime: ContainerRuntime,
  image: ContainerImage,
) {
  yield* Effect.annotateCurrentSpan({ runtime, image });
  const command = (args: ReadonlyArray<string>, timeout: "15 seconds" | "5 minutes") =>
    collectCommand(
      spawner,
      "preflight",
      runtime,
      args,
      { forceKillAfter: "2 seconds" },
      65536,
    ).pipe(
      Effect.timeout(timeout),
      Effect.mapError((cause) =>
        SupervisorUnavailable.make({
          message: `Cannot prepare the supervisor image: ${cause.message}`,
        }),
      ),
    );
  const cached = yield* command(["image", "inspect", image], "15 seconds");
  if (cached.exitCode === 0) {
    yield* Effect.logInfo("Using the cached supervisor image", { runtime, image });
    return;
  }
  yield* Effect.logInfo("Pulling the supervisor image", { runtime, image });
  const pulled = yield* command(["pull", image], "5 minutes");
  if (pulled.exitCode !== 0)
    return yield* SupervisorUnavailable.make({
      message: `Cannot pull the supervisor image: ${pulled.stderr.trim().split("\n")[0]}`,
    });
  yield* Effect.logInfo("The supervisor image is ready", { runtime, image });
});
