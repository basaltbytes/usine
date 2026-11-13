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
    WorkerCapabilityError.make({
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
  if (Option.isNone(before)) {
    if (
      machine.address.machine._tag === "Provisioned" &&
      machine.address.machine.provisioner.provider === "boat"
    )
      yield* Effect.logInfo(
        "The attempt image is absent on the Boat machine; downloading it",
        fields,
      );
    else
      yield* Effect.logWarning(
        Option.isSome(machine.provisioned)
          ? "The worker snapshot lacks the attempt image; downloading it. Rebuild the snapshot with this image."
          : "The attempt image is absent on the worker; downloading it",
        fields,
      );
  }
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
    yield* removeOldWorkerImages(commands, machine, image, after.value, runtime, operation);
    return;
  }
});

/** A script that prints the image ID of each container of the runtime `$1`, one per line. */
const CONTAINER_IMAGES_SCRIPT = String.raw`
set -eu
ids=$("$1" ps --all --quiet --no-trunc)
[ -z "$ids" ] || exec "$1" container inspect --format '{{.Image}}' $ids
`.trim();

/**
 * Removes the images of the repository of `image` other than the current one, `currentId`, the
 * newest of the others, which a rollback uses, and those that a container uses. Logs what it
 * removes and any failure without failing: the free disk space check decides whether Attempts
 * start.
 */
const removeOldWorkerImages = Effect.fn("SshExecutor.removeOldWorkerImages")(
  function* (
    commands: RemoteCommands,
    machine: SshMachine,
    image: ContainerImage,
    currentId: string,
    runtime: ContainerRuntime,
    operation: "preflight" | "prepare",
  ) {
    const fields = {
      worker: machine.address.name,
      host: machine.shell.destination,
      image,
      runtime,
    };
    yield* Effect.annotateCurrentSpan(fields);
    const repository = imageRepository(image);
    const listed = yield* commands.run(operation, machine.shell, runtime, [
      "image",
      "ls",
      "--no-trunc",
      "--format",
      "{{.ID}} {{.Repository}} {{.Tag}} {{.CreatedAt}}",
      repository,
    ]);
    const images = workerImagesFromList(listed, repository);
    if (Option.isNone(images)) {
      yield* Effect.logWarning(
        "Kept the older worker images: the runtime listed an image without a readable creation time",
        { ...fields, listed: listed.trim().slice(0, 1000) },
      );
      return;
    }
    const used = yield* commands.run(operation, machine.shell, "sh", [
      "-c",
      CONTAINER_IMAGES_SCRIPT,
      "sh",
      runtime,
    ]);
    const selection = oldWorkerImages(
      images.value,
      currentId,
      new Set(
        used
          .split("\n")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    );
    const selectionFields = {
      ...fields,
      images: images.value.length,
      previous: Option.getOrElse(selection.previous, () => "none"),
      inUse: selection.inUse.join(","),
    };
    if (selection.remove.length === 0) {
      yield* Effect.logDebug("No older worker image to remove", selectionFields);
      return;
    }
    const removed = yield* commands.inspect(operation, machine.shell, runtime, [
      "image",
      "rm",
      ...selection.remove,
    ]);
    if (removed.exitCode !== 0) {
      yield* Effect.logWarning("Could not remove some older worker images", {
        ...selectionFields,
        removed: selection.remove.join(","),
        exitCode: removed.exitCode,
        stderr: removed.stderr.trim().slice(0, 1000),
      });
      return;
    }
    yield* Effect.logInfo("Removed older worker images", {
      ...selectionFields,
      removed: selection.remove.join(","),
    });
  },
  (effect, _commands, machine, image) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not remove older worker images", {
          worker: machine.address.name,
          image,
          message: error.message,
        }),
      ),
      Effect.ignore,
    ),
);

/** Returns the repository of `image`, without its tag or digest. */
export const imageRepository = (image: string): string => {
  const [name = image] = image.split("@");
  const colon = name.lastIndexOf(":");
  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
};

/** An image of the worker image's repository on a machine, as the runtime lists it. */
export interface WorkerImage {
  /** The image ID, without the `sha256:` prefix. */
  readonly id: string;
  /** The `repository:tag` that names it, or `None` for an untagged image. */
  readonly reference: Option.Option<string>;
  /** When the image was built, in milliseconds since the epoch. */
  readonly createdAt: number;
}

const withoutAlgorithm = (id: string): string => id.trim().replace(/^sha256:/u, "");

/** Matches Go's `time.Time` string, such as `2026-11-12 10:00:00 +0000 UTC`, and RFC 3339. */
const CREATED_AT =
  /^(?<date>\d{4}-\d{2}-\d{2})[ T](?<time>\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?<offset>Z|[+-]\d{2}:?\d{2})/u;

const createdAtMillis = (text: string): Option.Option<number> => {
  const groups = CREATED_AT.exec(text.trim())?.groups;
  if (groups?.date === undefined || groups.time === undefined || groups.offset === undefined)
    return Option.none();
  const offset =
    groups.offset === "Z" || groups.offset.includes(":")
      ? groups.offset
      : `${groups.offset.slice(0, 3)}:${groups.offset.slice(3)}`;
  const millis = Date.parse(`${groups.date}T${groups.time}${offset}`);
  return Number.isNaN(millis) ? Option.none() : Option.some(millis);
};

/**
 * Parses the lines `<ID> <repository> <tag> <created at>` of an image listing and keeps the
 * images of `repository`. Returns `None` if a creation time can't be read.
 */
export const workerImagesFromList = (
  output: string,
  repository: string,
): Option.Option<ReadonlyArray<WorkerImage>> => {
  const images: Array<WorkerImage> = [];
  for (const line of output.split("\n")) {
    const [id = "", name = "", tag = "", ...created] = line.trim().split(/\s+/u);
    if (id === "" || name !== repository) continue;
    const createdAt = createdAtMillis(created.join(" "));
    if (Option.isNone(createdAt)) return Option.none();
    images.push({
      id: withoutAlgorithm(id),
      reference: tag === "" || tag === "<none>" ? Option.none() : Option.some(`${name}:${tag}`),
      createdAt: createdAt.value,
    });
  }
  return Option.some(images);
};

/** The older worker images on a machine and which of them stay. */
export interface OldWorkerImages {
  /** The newest image other than the current one, which stays for a rollback. */
  readonly previous: Option.Option<string>;
  /** The older images that stay because a container uses them. */
  readonly inUse: ReadonlyArray<string>;
  /** The references, or the IDs of untagged images, to remove. */
  readonly remove: ReadonlyArray<string>;
}

/**
 * Selects the images to remove: every image but the current one (`currentId`), the newest of the
 * others, and those whose ID `used` contains.
 */
export const oldWorkerImages = (
  images: ReadonlyArray<WorkerImage>,
  currentId: string,
  used: ReadonlySet<string>,
): OldWorkerImages => {
  const current = withoutAlgorithm(currentId);
  const inUse = new Set([...used].map(withoutAlgorithm));
  const byId = new Map<string, { createdAt: number; references: Array<string> }>();
  for (const { id, reference, createdAt } of images) {
    if (id === current) continue;
    const entry = byId.get(id) ?? { createdAt, references: [] };
    if (Option.isSome(reference)) entry.references.push(reference.value);
    byId.set(id, entry);
  }
  const older = [...byId].sort(([, a], [, b]) => b.createdAt - a.createdAt);
  const [newest, ...rest] = older;
  return {
    previous: Option.map(Option.fromUndefinedOr(newest), ([id]) => id),
    inUse: rest.flatMap(([id]) => (inUse.has(id) ? [id] : [])),
    remove: rest.flatMap(([id, { references }]) =>
      inUse.has(id) ? [] : references.length > 0 ? references : [id],
    ),
  };
};
