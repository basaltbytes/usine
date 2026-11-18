import { SupervisorUnavailable } from "@usine/agents/supervisor";
import type { SupervisorLimits } from "@usine/core/worker";
import { Effect, Fiber, FileSystem, Option, Result, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import type { ContainerRuntime } from "../remote/runtime.ts";

/** A running sandbox container. */
export interface SandboxContainer {
  readonly runtime: ContainerRuntime;
  readonly name: string;
}

/** How long one copy of a home into or out of a sandbox may take. */
const TRANSFER_TIMEOUT = "2 minutes";

const MIB = 1024 ** 2;

/** The first non-blank line of `text`, which names the cause in tar and runtime errors. */
const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/**
 * Returns why `limits` leave the harness too little memory, or `None`. The home and `/tmp` are
 * in-memory filesystems, so their files count against the container's memory limit; together
 * they may take at most half of it.
 */
export const memoryShortfall = (limits: SupervisorLimits): Option.Option<string> =>
  (limits.conversationSizeMib + limits.tmpfsSizeMib) * 2 > limits.memoryMib
    ? Option.some(
        `supervisor_limits.conversation_size_mib (${limits.conversationSizeMib}) plus tmpfs_size_mib (${limits.tmpfsSizeMib}) must be at most half of memory_mib (${limits.memoryMib}), because the files in a turn's home and /tmp count against its memory`,
      )
    : Option.none();

/** Passes `stream` on until it exceeds `limit` bytes, and then fails with `exceeded()`. */
export const capBytes =
  <E2>(limit: number, exceeded: () => E2) =>
  <E>(stream: Stream.Stream<Uint8Array, E>): Stream.Stream<Uint8Array, E | E2> =>
    Stream.suspend(() => {
      let bytes = 0;
      return stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;
          return bytes > limit ? Effect.fail(exceeded()) : Effect.succeed(chunk);
        }),
      );
    });

/** The bytes in the regular files under `path`, without following links; 0 when it is absent. */
const directoryBytes = Effect.fn("SupervisorStorage.directoryBytes")(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  if (!(yield* fs.exists(path))) return 0;
  let bytes = 0;
  for (const entry of yield* fs.readDirectory(path, { recursive: true })) {
    const info = yield* fs.lstat(`${path}/${entry}`);
    if (info.type === "File") bytes += Number(info.size);
  }
  return bytes;
});

/**
 * Fails when the files that the orchestrator's own harness process wrote in the conversation's
 * working directory exceed `conversation_size_mib`.
 */
export const checkWorkspaceSize = Effect.fn("SupervisorStorage.checkWorkspaceSize")(function* (
  fs: FileSystem.FileSystem,
  workspace: string,
  limits: SupervisorLimits,
) {
  const bytes = yield* directoryBytes(fs, workspace).pipe(
    Effect.mapError((error) =>
      SupervisorUnavailable.make({
        message: `Can't measure the conversation's saved sessions: ${error.message}`,
      }),
    ),
  );
  if (bytes <= limits.conversationSizeMib * MIB) return bytes;
  yield* Effect.logWarning("A supervisor conversation's saved sessions exceed their limit", {
    workspace,
    bytes,
    limitMib: limits.conversationSizeMib,
  });
  return yield* SupervisorUnavailable.make({
    message: `The conversation's saved sessions use ${Math.ceil(bytes / MIB)} MiB, more than supervisor_limits.conversation_size_mib (${limits.conversationSizeMib} MiB). Start a new conversation, or raise the limit and restart usine.`,
  });
});

/**
 * Removes the conversation images of the FUSE storage that earlier versions used, with the
 * directories they were mounted at, and logs each removal. A conversation without saved state
 * starts a new harness session at its next turn.
 */
export const removeFuseStorage = Effect.fn("SupervisorStorage.removeFuseStorage")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const disks = `${root}/disks`;
  if (!(yield* fs.exists(disks))) return;
  for (const file of yield* fs.readDirectory(disks)) {
    const key = /^([0-9a-f]{64})\.ext4(\.creating)?$/u.exec(file)?.[1];
    if (key === undefined) continue;
    const image = `${disks}/${file}`;
    const directory = `${root}/conversations/${key}`;
    const removed = yield* fs
      .remove(image, { force: true })
      .pipe(Effect.andThen(fs.remove(directory, { recursive: true, force: true })), Effect.result);
    if (Result.isSuccess(removed))
      yield* Effect.logInfo("Removed a supervisor conversation image from an earlier version", {
        image,
        directory,
      });
    else
      yield* Effect.logWarning(
        "Could not remove a supervisor conversation image from an earlier version",
        { image, directory, message: removed.failure.message },
      );
  }
  if ((yield* fs.readDirectory(disks)).length === 0) yield* fs.remove(disks, { recursive: true });
});

/**
 * Runs `args` in `container` with `<runtime> exec`, feeding `stdin` to it, and returns its stdout
 * as text. Fails with the command's first stderr line when it exits with another code than 0, and
 * otherwise with the error of `stdin`.
 */
const execIn = <E extends { readonly message: string }>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  container: SandboxContainer,
  action: string,
  args: ReadonlyArray<string>,
  stdin: Option.Option<Stream.Stream<Uint8Array, E>>,
) =>
  Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        container.runtime,
        ["exec", ...(Option.isSome(stdin) ? ["--interactive"] : []), container.name, ...args],
        { forceKillAfter: "2 seconds" },
      ),
    );
    const fed = yield* Option.match(stdin, {
      onNone: () => Effect.void,
      onSome: (input) => Stream.run(input, handle.stdin),
    }).pipe(Effect.result, Effect.forkScoped);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* SupervisorUnavailable.make({
        message: `Can't ${action}: ${firstLine(stderr) || `${args[0]} exited with code ${exitCode}`}`,
      });
    const input = yield* Fiber.join(fed);
    if (Result.isFailure(input))
      return yield* SupervisorUnavailable.make({
        message: `Can't ${action}: ${input.failure.message}`,
      });
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeout(TRANSFER_TIMEOUT),
    Effect.mapError((error) =>
      error._tag === "SupervisorUnavailable"
        ? error
        : SupervisorUnavailable.make({ message: `Can't ${action}: ${error.message}` }),
    ),
  );

/**
 * Prepares the home of a turn in `container`: extracts `archive`, the saved home, into `root`,
 * creates `home` when there is none, and writes `files` into it, replacing any entry at their
 * paths. `root` is the turn's in-memory filesystem.
 */
export const restoreHome = Effect.fn("SupervisorStorage.restoreHome")(function* <
  E extends { readonly message: string },
>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  container: SandboxContainer,
  root: string,
  archive: Option.Option<Stream.Stream<Uint8Array, E>>,
  files: ReadonlyArray<readonly [path: string, contents: string]>,
) {
  if (Option.isSome(archive))
    yield* execIn(
      spawner,
      container,
      "restore the conversation's saved home",
      ["tar", "-x", "-f", "-", "-C", root],
      archive,
    );
  yield* execIn(
    spawner,
    container,
    "create the conversation's home",
    ["mkdir", "-p", "--", `${root}/home`],
    Option.none(),
  );
  const encoder = new TextEncoder();
  for (const [path, contents] of files)
    yield* execIn(
      spawner,
      container,
      "write the harness's model settings",
      ["sh", "-c", 'mkdir -p -- "${1%/*}" && rm -rf -- "$1" && cat > "$1"', "sh", path],
      Option.some(Stream.make(encoder.encode(contents))),
    );
});

/**
 * The tar archive of `root/home` in `container`, which fails once it exceeds `limitMib` MiB, and at
 * its end when tar fails.
 */
export const archiveHome = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  container: SandboxContainer,
  root: string,
  limitMib: number,
): Stream.Stream<Uint8Array, SupervisorUnavailable> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          container.runtime,
          ["exec", container.name, "tar", "-c", "-f", "-", "-C", root, "home"],
          { forceKillAfter: "2 seconds" },
        ),
      );
      const stderr = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (head, text) => (head + text).slice(0, 8192),
        ),
        Effect.forkScoped,
      );
      const ended = Effect.gen(function* () {
        const exitCode = yield* handle.exitCode;
        if (exitCode === 0) return;
        const output = yield* Fiber.join(stderr);
        const detail = firstLine(output);
        return yield* SupervisorUnavailable.make({
          message: `Can't save the conversation's home: ${detail || `tar exited with code ${exitCode}`}`,
        });
      });
      return handle.stdout.pipe(
        capBytes(limitMib * MIB, () =>
          SupervisorUnavailable.make({
            message: `The conversation's home is larger than supervisor_limits.conversation_size_mib (${limitMib} MiB), so usine kept the state that the previous turn saved`,
          }),
        ),
        Stream.concat(Stream.drain(Stream.fromEffect(ended))),
      );
    }),
  ).pipe(
    Stream.mapError((error) =>
      error._tag === "SupervisorUnavailable"
        ? error
        : SupervisorUnavailable.make({
            message: `Can't save the conversation's home: ${error.message}`,
          }),
    ),
  );
