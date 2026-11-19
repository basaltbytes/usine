// The fake command boundary synchronously checks mount sources.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { type Duration, Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { memoryHomesLayer } from "../../src/supervisor/homes/memory.ts";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a fake command prints and its exit code, or `hang` for one that never exits. */
export type Answer =
  | {
      readonly stdout: string | Stream.Stream<Uint8Array>;
      readonly stderr?: string | Stream.Stream<Uint8Array>;
      readonly exitCode: number;
      readonly duration?: Duration.Input;
    }
  | "hang";

/** A command line and the text that the command read from its stdin. */
export interface Input {
  readonly command: ReadonlyArray<string>;
  readonly text: string;
}

/**
 * A spawner that answers each command with `answer`, and on which a command that `answer` leaves
 * `undefined` is missing, as on a host without it. Records every command line in `calls`, each
 * released command in `releases`, and what each command read from its stdin in `inputs`.
 */
export const spawning = (
  answer: (command: string, args: ReadonlyArray<string>) => Answer | undefined,
  calls: Array<ReadonlyArray<string>> = [],
  releases: Array<ReadonlyArray<string>> = [],
  inputs: Array<Input> = [],
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        const line = [command.command, ...command.args];
        calls.push(line);
        const answered = answer(command.command, command.args);
        if (answered === undefined)
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `spawn ${command.command} ENOENT`,
          });
        const output = (value: string | Stream.Stream<Uint8Array>) =>
          Stream.isStream(value) ? value : Stream.make(encoder.encode(value));
        let read = "";
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            answered === "hang"
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(answered.exitCode)).pipe(
                  Effect.delay(answered.duration ?? 0),
                ),
          isRunning: Effect.succeed(answered === "hang"),
          kill: () => Effect.void,
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => {
              read += decoder.decode(chunk);
            }),
          ),
          stdout: answered === "hang" ? Stream.never : output(answered.stdout),
          stderr: answered === "hang" ? Stream.never : output(answered.stderr ?? ""),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
        return yield* Effect.acquireRelease(Effect.succeed(handle), () =>
          Effect.sync(() => {
            releases.push(line);
            if (read !== "") inputs.push({ command: line, text: read });
          }),
        );
      }),
    ),
  );

export interface RuntimeState {
  starts: boolean;
  /** Whether `run` of a turn's sandbox, but not of the startup check's, never exits. */
  hangStart?: boolean;
  rejectLimits?: boolean;
  image?: Answer;
  pull?: Answer;
  /** How `tar -c` in a sandbox answers; by default it prints `archive` and exits with 0. */
  archive?: Answer;
  /** How `tar -x` in a sandbox answers; by default it exits with 0. */
  restore?: Answer;
}

/** The arguments of a `podman exec` after its options: the container and the command. */
const execCommand = (args: ReadonlyArray<string>) =>
  args.slice(1).filter((arg) => arg !== "--interactive");

/**
 * A Podman that runs every command, and lists `left` as the containers that it still runs. As
 * Podman does, `run` refuses a `--mount` whose host path doesn't exist. `relay.starts` says
 * whether the sandbox's model relay accepts connections, and `removes` whether `rm` succeeds.
 * Provides saved homes in memory too.
 */
export const podman = (
  calls: Array<ReadonlyArray<string>>,
  left: ReadonlyArray<string> = [],
  relay: RuntimeState = { starts: true },
  removes = true,
  releases: Array<ReadonlyArray<string>> = [],
  inputs: Array<Input> = [],
) => {
  const containers = new Map(left.map((name) => [name, ""]));
  return Layer.merge(
    spawning(
      (command, args) => {
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
        if (args[0] === "exec") {
          const [, program, flag] = execCommand(args);
          if (program === "node") return { stdout: "", exitCode: relay.starts ? 0 : 1 };
          if (program === "sh" && flag === "-ec")
            return { stdout: "", exitCode: relay.rejectLimits === true ? 1 : 0 };
          if (program === "tar" && flag === "-c")
            return relay.archive ?? { stdout: "archive", exitCode: 0 };
          if (program === "tar" && flag === "-x")
            return relay.restore ?? { stdout: "", exitCode: 0 };
          return { stdout: "", exitCode: 0 };
        }
        if (args[0] === "rm") {
          if (!removes)
            return { stdout: "", stderr: "Error: cannot remove container", exitCode: 125 };
          containers.delete(args[2]!);
        }
        if (args[0] === "run") {
          const sources = args.flatMap((arg, index) =>
            args[index - 1] === "--mount" && arg.startsWith("type=bind")
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
          if (relay.hangStart === true && conversation !== "usine-startup-check") return "hang";
        }
        return { stdout: "", exitCode: 0 };
      },
      calls,
      releases,
      inputs,
    ),
    memoryHomesLayer,
  );
};

/** The `run` calls of turns in `calls`, without the startup check's. */
export const turnRuns = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(
    (args) =>
      args[1] === "run" && !args.includes("usine.supervisor.conversation=usine-startup-check"),
  );
