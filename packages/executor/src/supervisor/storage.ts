import { SupervisorUnavailable } from "@usine/agents/supervisor";
import type { SupervisorLimits } from "@usine/core/worker";
import { Effect, FileSystem, Ref, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";

/** Mounts a preallocated filesystem, so a conversation cannot grow the instance's host filesystem. */
export const mountConversation = Effect.fn("SupervisorSandbox.mountConversation")(
  function* (
    fs: FileSystem.FileSystem,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    root: string,
    name: string,
    limits: SupervisorLimits,
  ) {
    const directory = `${root}/conversations/${name}`;
    const image = `${root}/disks/${name}.ext4`;
    const bytes = limits.conversationSizeMib * 1024 ** 2;
    yield* Effect.annotateCurrentSpan({ directory, bytes });
    const run = (command: string, args: ReadonlyArray<string>, accepted = [0]) =>
      collectCommand(spawner, "prepare", command, args, { forceKillAfter: "2 seconds" }, 8192).pipe(
        Effect.timeout("30 seconds"),
        Effect.filterOrFail(
          (result) => accepted.includes(result.exitCode),
          (result) =>
            SupervisorUnavailable.make({ message: `${command} failed: ${result.stderr.trim()}` }),
        ),
      );
    yield* fs.makeDirectory(`${root}/disks`, { recursive: true });
    yield* fs.makeDirectory(directory, { recursive: true });
    const mounted = yield* run("mountpoint", ["-q", directory], [0, 32]);
    if (mounted.exitCode === 0) {
      yield* Effect.logInfo("Unmounting a previous supervisor filesystem before a turn", {
        directory,
      });
      yield* run("fusermount", ["-u", directory]);
    }
    if (!(yield* fs.exists(image))) {
      const staging = `${image}.creating`;
      yield* fs.remove(staging, { force: true });
      yield* Effect.gen(function* () {
        yield* fs.writeFile(staging, new Uint8Array(), { flag: "wx", mode: 0o600 });
        yield* run("fallocate", ["-l", String(bytes), staging]);
        yield* run("mkfs.ext4", [
          "-q",
          "-F",
          "-E",
          `nodiscard,root_owner=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          "-d",
          directory,
          staging,
        ]);
        yield* fs.rename(staging, image);
      }).pipe(
        Effect.ensuring(
          fs.remove(staging, { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logError("Could not remove an incomplete supervisor filesystem", {
                staging,
                message: error.message,
              }),
            ),
          ),
        ),
      );
    }
    const size = yield* fs.stat(image);
    if (Number(size.size) !== bytes)
      return yield* SupervisorUnavailable.make({
        message:
          "The existing conversation filesystem differs from conversation_size_mib; migrate it before changing the limit",
      });
    const checked = yield* run("e2fsck", ["-p", image], [0, 1]);
    if (checked.exitCode === 1)
      yield* Effect.logWarning("Repaired a supervisor conversation filesystem", { directory });
    const mountedProcess = yield* spawner.spawn(
      ChildProcess.make("fuse2fs", ["-f", "-o", "rw,nosuid,nodev,allow_other", image, directory], {
        detached: false,
        forceKillAfter: "2 seconds",
      }),
    );
    const diagnostics = yield* Ref.make("");
    yield* Stream.merge(mountedProcess.stdout, mountedProcess.stderr).pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Ref.update(diagnostics, (tail) => (tail + text).slice(-8192))),
      Effect.catch((error) =>
        Effect.logWarning("Supervisor filesystem diagnostics stopped", {
          directory,
          message: error.message,
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      run("fusermount", ["-u", directory]).pipe(
        Effect.retry({ times: 2, schedule: Schedule.spaced("200 millis") }),
        Effect.catch((error) =>
          Effect.logError("Could not unmount a supervisor filesystem", {
            directory,
            message: error.message,
          }),
        ),
      ),
    );
    yield* run("mountpoint", ["-q", directory]).pipe(
      Effect.retry({ schedule: Schedule.spaced("100 millis") }),
      Effect.timeout("10 seconds"),
      Effect.raceFirst(
        mountedProcess.exitCode.pipe(
          Effect.flatMap((code) =>
            Ref.get(diagnostics).pipe(
              Effect.flatMap((detail) =>
                Effect.fail(
                  SupervisorUnavailable.make({
                    message: `fuse2fs exited with ${code}: ${detail.trim()}`,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    yield* Effect.logInfo("Mounted a bounded supervisor filesystem", { directory, bytes });
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        SupervisorUnavailable.make({
          message: `Cannot mount the supervisor conversation filesystem: ${error.message}`,
        }),
      ),
    ),
);

/** Checks the unprivileged filesystem tools before admitting supervisor turns. */
export const checkConversationStorage = Effect.fn("SupervisorSandbox.checkStorage")(
  function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    for (const [command, flag] of [
      ["fuse2fs", "-V"],
      ["fusermount", "-V"],
      ["mkfs.ext4", "-V"],
      ["e2fsck", "-V"],
      ["fallocate", "--version"],
      ["mountpoint", "--version"],
    ] as const) {
      const result = yield* collectCommand(
        spawner,
        "preflight",
        command,
        [flag],
        { forceKillAfter: "2 seconds" },
        8192,
      );
      if (result.exitCode !== 0)
        return yield* SupervisorUnavailable.make({
          message: `Supervisor storage requires ${command}`,
        });
    }
    const conversations = `${root}/conversations`;
    if (yield* fs.exists(conversations)) {
      for (const name of yield* fs.readDirectory(conversations)) {
        if (!/^[0-9a-f]{64}$/u.test(name)) continue;
        const directory = `${conversations}/${name}`;
        const mounted = yield* collectCommand(
          spawner,
          "preflight",
          "mountpoint",
          ["-q", directory],
          { forceKillAfter: "2 seconds" },
          8192,
        );
        if (mounted.exitCode === 32) continue;
        if (mounted.exitCode !== 0)
          return yield* SupervisorUnavailable.make({
            message: "Cannot inspect a previous supervisor mount",
          });
        const unmounted = yield* collectCommand(
          spawner,
          "preflight",
          "fusermount",
          ["-u", directory],
          { forceKillAfter: "2 seconds" },
          8192,
        );
        if (unmounted.exitCode !== 0)
          return yield* SupervisorUnavailable.make({
            message: `Cannot unmount a previous supervisor filesystem: ${unmounted.stderr.trim()}`,
          });
        yield* Effect.logInfo("Unmounted a previous supervisor filesystem", { directory });
      }
    }
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError((error) =>
        SupervisorUnavailable.make({
          message: `Supervisor storage requires fuse2fs, fusermount, e2fsprogs and fallocate: ${error.message}`,
        }),
      ),
    ),
);
