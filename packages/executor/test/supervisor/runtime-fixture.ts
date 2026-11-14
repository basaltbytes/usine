// The fake command boundary synchronously checks mount sources and sizes sparse test images.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, truncateSync } from "node:fs";
import { type Duration, Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
const encoder = new TextEncoder();

/** What a fake command prints and its exit code, or `hang` for one that never exits. */
export type Answer =
  | {
      readonly stdout: string;
      readonly stderr?: string;
      readonly exitCode: number;
      readonly duration?: Duration.Input;
    }
  | "hang";

/**
 * A spawner that answers each command with `answer`, and on which a command that `answer` leaves
 * `undefined` is missing, as on a host without it. Records every command line in `calls`.
 */
export const spawning = (
  answer: (command: string, args: ReadonlyArray<string>) => Answer | undefined,
  calls: Array<ReadonlyArray<string>> = [],
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        calls.push([command.command, ...command.args]);
        const answered = answer(command.command, command.args);
        if (answered === undefined)
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `spawn ${command.command} ENOENT`,
          });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            answered === "hang"
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(answered.exitCode)).pipe(
                  Effect.delay(answered.duration ?? 0),
                ),
          isRunning: Effect.succeed(answered === "hang"),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: answered === "hang" ? Stream.never : Stream.make(encoder.encode(answered.stdout)),
          stderr:
            answered === "hang" ? Stream.never : Stream.make(encoder.encode(answered.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

export interface RuntimeState {
  starts: boolean;
  hangStart?: boolean;
  rejectLimits?: boolean;
  staleMount?: boolean;
  repaired?: boolean;
  image?: Answer;
  pull?: Answer;
}

/**
 * A Podman that runs every command, and lists `left` as the containers that it still runs. As
 * Podman does, `run` refuses a `--mount` whose host path doesn't exist. `relay.starts` says
 * whether the sandbox's model relay accepts connections, and `removes` whether `rm` succeeds.
 */
export const podman = (
  calls: Array<ReadonlyArray<string>>,
  left: ReadonlyArray<string> = [],
  relay: RuntimeState = { starts: true },
  removes = true,
) => {
  const containers = new Map(left.map((name) => [name, ""]));
  const mounts = new Set<string>();
  return spawning((command, args) => {
    if (command === "mountpoint")
      return {
        stdout: "",
        exitCode:
          args[0] === "--version" || relay.staleMount === true || mounts.has(args[1]!) ? 0 : 32,
      };
    if (command === "fuse2fs") {
      if (args[0] !== "-V") {
        mounts.add(args[args.length - 1]!);
        return "hang";
      }
      return { stdout: "", exitCode: 0 };
    }
    if (command === "fusermount") {
      if (args[0] === "-u") {
        mounts.delete(args[1]!);
        relay.staleMount = false;
      }
      return { stdout: "", exitCode: 0 };
    }
    if (command === "fallocate") {
      if (args[0] === "-l") truncateSync(args[2]!, Number(args[1]));
      return { stdout: "", exitCode: 0 };
    }
    if (command === "mkfs.ext4" || command === "e2fsck")
      return {
        stdout: "",
        exitCode: command === "e2fsck" && args[0] === "-p" && relay.repaired === true ? 1 : 0,
      };
    if (command !== "podman") return undefined;
    if (args[0] === "image") return relay.image ?? { stdout: "", exitCode: 1 };
    if (args[0] === "pull") return relay.pull ?? { stdout: "", exitCode: 0 };
    if (args[0] === "info") return { stdout: "true", exitCode: 0 };
    if (args[0] === "ps") {
      const filter = args.find((arg) => arg.startsWith("label=usine.supervisor.conversation="));
      return {
        stdout: [...containers]
          .filter(
            ([, conversation]) =>
              filter === undefined ||
              filter === `label=usine.supervisor.conversation=${conversation}`,
          )
          .map(([name]) => name)
          .join("\n"),
        exitCode: 0,
      };
    }
    if (args[0] === "exec")
      return {
        stdout: "",
        exitCode: relay.starts && !(relay.rejectLimits === true && args[2] === "sh") ? 0 : 1,
      };
    if (args[0] === "rm") {
      if (!removes) return { stdout: "", stderr: "Error: cannot remove container", exitCode: 125 };
      containers.delete(args[2]!);
    }
    if (args[0] === "run") {
      const sources = args.flatMap((arg, index) =>
        args[index - 1] === "--mount"
          ? [arg.match(/"source=((?:[^"]|"")*)"/u)?.[1]?.replaceAll('""', '"')]
          : [],
      );
      const missing = sources.find((source) => source !== undefined && !existsSync(source));
      if (missing !== undefined)
        return {
          stdout: "",
          stderr: `Error: statfs ${missing}: no such file or directory`,
          exitCode: 125,
        };
      const name = args[args.indexOf("--name") + 1]!;
      const conversation = args
        .find((arg) => arg.startsWith("usine.supervisor.conversation="))!
        .slice("usine.supervisor.conversation=".length);
      containers.set(name, conversation);
      if (relay.hangStart === true) return "hang";
    }
    return { stdout: "", exitCode: 0 };
  }, calls);
};
