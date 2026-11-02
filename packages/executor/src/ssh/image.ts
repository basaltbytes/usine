import { SSH_FAILURE } from "@usine/agents/child-host";
import type { ContainerImage } from "@usine/core/worker";
import { Duration, Effect, Option } from "effect";
import { WorkerCapabilityError } from "../executor.ts";
import type { RemoteCommands } from "../remote/commands.ts";
import type { ContainerRuntime } from "../remote/runtime.ts";
import type { SshMachine } from "./model.ts";

/** Checks the local image before any container starts and pulls it during preflight or when absent. */
export const prepareAttemptImage = Effect.fn("SshExecutor.prepareAttemptImage")(function* (
  commands: RemoteCommands,
  machine: SshMachine,
  image: ContainerImage,
  runtime: ContainerRuntime,
  operation: "preflight" | "prepare",
) {
  const worker = machine.address.name;
  const fields = { worker, host: machine.shell.destination, image, runtime };
  yield* Effect.annotateCurrentSpan(fields);
  const gap = (message: string, detail: string) =>
    new WorkerCapabilityError({
      worker,
      capability: "container",
      message,
      cause: new Error(detail),
    });
  const inspect = Effect.fn("SshExecutor.inspectAttemptImage")(function* () {
    yield* Effect.annotateCurrentSpan(fields);
    const [duration, result] = yield* commands
      .inspect(operation, machine.shell, runtime, [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        image,
      ])
      .pipe(Effect.timed);
    if (result.exitCode === SSH_FAILURE || (result.exitCode !== 0 && result.exitCode !== 1))
      return yield* gap(`Can't inspect the attempt image ${image}`, result.stderr.trim());
    const id = result.stdout.trim();
    if (result.exitCode === 0 && id.length === 0)
      return yield* gap(`Can't inspect the attempt image ${image}`, "Image inspect returned no ID");
    const present = result.exitCode === 0;
    yield* Effect.logInfo("Inspected the attempt image", {
      ...fields,
      status: present ? "present" : "absent",
      durationMillis: Duration.toMillis(duration),
    });
    return present ? Option.some(id) : Option.none<string>();
  });
  const before = yield* inspect();
  if (operation === "prepare" && Option.isSome(before)) return;
  if (Option.isNone(before))
    yield* Effect.logWarning(
      Option.isSome(machine.provisioned)
        ? "The worker snapshot lacks the attempt image; downloading it. Rebuild the snapshot with this image."
        : "The attempt image is absent on the worker; downloading it",
      fields,
    );
  yield* Effect.logInfo("Pulling the attempt image", fields);
  const [duration, pulled] = yield* commands
    .inspect(operation, machine.shell, runtime, ["pull", "--quiet", image])
    .pipe(Effect.timed);
  const pullFields = {
    ...fields,
    durationMillis: Duration.toMillis(duration),
    exitCode: pulled.exitCode,
  };
  if (pulled.exitCode !== 0) {
    yield* Effect.logWarning("Attempt image pull failed", pullFields);
    const local = yield* inspect();
    if (Option.isNone(local))
      return yield* gap(
        `SSH worker "${worker}" can't pull the attempt image ${image}`,
        pulled.stderr.trim() || `${runtime} pull exited with code ${pulled.exitCode}`,
      );
    yield* Effect.logWarning(
      "SSH Worker could not pull the Attempt image; its Attempts use the image already on the machine",
      { ...fields, message: pulled.stderr.trim() },
    );
    return;
  }
  const after = yield* inspect();
  if (Option.isNone(after))
    return yield* gap(
      `Can't inspect the pulled attempt image ${image}`,
      "Image is absent after pull",
    );
  yield* Effect.logInfo("Pulled the attempt image", {
    ...pullFields,
    downloaded: Option.isNone(before) || before.value !== after.value,
  });
});
