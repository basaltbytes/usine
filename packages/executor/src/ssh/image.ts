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
    const absent =
      runtime === "podman"
        ? result.exitCode === 125 && result.stderr.trim().endsWith(": image not known")
        : result.exitCode === 1;
    if (result.exitCode !== 0 && !absent)
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    yield* Effect.logInfo("Pulling the attempt image", { ...fields, attempt });
    const [duration, pulled] = yield* commands
      .inspect(operation, machine.shell, runtime, ["pull", "--quiet", image])
      .pipe(Effect.timed);
    const pullFields = {
      ...fields,
      attempt,
      durationMillis: Duration.toMillis(duration),
      exitCode: pulled.exitCode,
    };
    if (pulled.exitCode !== 0) {
      yield* Effect.logWarning("Attempt image pull failed", {
        ...pullFields,
        stderr: pulled.stderr.trim().slice(0, 1000),
      });
      const local = yield* inspect();
      if (Option.isNone(local)) {
        if (attempt < 3) {
          const delayMillis = attempt === 1 ? 5000 : 15000;
          yield* Effect.logInfo("Retrying the attempt image pull", {
            ...fields,
            nextAttempt: attempt + 1,
            delayMillis,
          });
          yield* Effect.sleep(delayMillis);
          continue;
        }
        return yield* gap(
          `SSH worker "${worker}" can't pull the attempt image ${image}`,
          pulled.stderr.trim() || `${runtime} pull exited with code ${pulled.exitCode}`,
        );
      }
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
    return;
  }
});
