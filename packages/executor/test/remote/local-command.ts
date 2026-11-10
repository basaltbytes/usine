// The fakes run commands with callbacks inside their transport's handlers.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { Data, Effect, Queue, Stream } from "effect";

/** What a command run by `runLocally` reports, ending with `Exited`. */
export type LocalEvent = Data.TaggedEnum<{
  Output: { readonly channel: "stdout" | "stderr"; readonly bytes: Uint8Array };
  Exited: { readonly exitCode: number };
}>;
const LocalEvent = Data.taggedEnum<LocalEvent>();

/** The exit code of a command that `TERM` ended, the only signal that the fakes send. */
const TERMINATED = 128 + 15;

/**
 * Runs `line` with this machine's `sh -c` in its own process group, as a remote machine runs a
 * command line, writing `stdin` to it until the stream ends. Ending the returned stream early, or
 * aborting `signal`, sends `TERM` to the group.
 */
export const runLocally = (
  line: string,
  stdin: Stream.Stream<Uint8Array>,
  signal?: AbortSignal,
): Stream.Stream<LocalEvent> =>
  Stream.callback<LocalEvent>((queue) =>
    Effect.gen(function* () {
      const child = spawn("sh", ["-c", line], { detached: true, stdio: "pipe" });
      const stop = () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, "SIGTERM");
      };
      signal?.addEventListener("abort", stop);
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      for (const channel of ["stdout", "stderr"] as const)
        child[channel].on("data", (bytes: Buffer) =>
          Queue.offerUnsafe(queue, LocalEvent.Output({ channel, bytes: new Uint8Array(bytes) })),
        );
      child.on("close", (code) => {
        Queue.offerUnsafe(queue, LocalEvent.Exited({ exitCode: code ?? TERMINATED }));
        Queue.endUnsafe(queue);
      });
      child.stdin.on("error", () => {});
      yield* stdin.pipe(
        Stream.runForEach((bytes) =>
          Effect.callback<void>((resume) => {
            if (child.stdin.write(bytes)) resume(Effect.void);
            else child.stdin.once("drain", () => resume(Effect.void));
          }),
        ),
        Effect.andThen(Effect.sync(() => child.stdin.end())),
        Effect.forkScoped,
      );
    }),
  );
