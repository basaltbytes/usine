import { CommitSha } from "@usine/core/repository";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** An isolated checkout with real Git history and a credential-free GitHub response. */
export const makeCheckout = Effect.fn("test.makeCheckout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-run-host-" });
  const git = Effect.fn("test.git")(function* (args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "git",
            ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
            { cwd },
          ),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0) return yield* Effect.die(`git ${args.join(" ")}: ${stderr}`);
        return stdout.trim();
      }),
    );
  });
  yield* git(["init", "--initial-branch=main", "--template="]);
  yield* git(["config", "user.name", "Usine Test"]);
  yield* git(["config", "user.email", "usine@example.invalid"]);
  const commit = Effect.fn("test.commit")(function* (message: string) {
    yield* git(["commit", "--allow-empty", "--allow-empty-message", "-m", message]);
    return yield* Schema.decodeUnknownEffect(CommitSha)(yield* git(["rev-parse", "HEAD"]));
  });
  const baseCommit = yield* commit("Existing work before the Attempt");
  yield* git(["checkout", "--detach"]);
  const hostSpawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand" && command.command === "gh") {
      return spawner.spawn(
        ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("[[]]\\n")'], { cwd }),
      );
    }
    return spawner.spawn(ChildProcess.setCwd(command, cwd));
  });
  return { baseCommit, commit, hostSpawner };
});
