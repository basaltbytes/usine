import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { SalvageRef, SalvageRejected } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Cause, Effect, Fiber, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import { collectCommand, requireSuccess } from "../src/child-command.ts";
import { ExecutorOperationError } from "../src/executor.ts";
import { salvageWorktree } from "../src/salvage.ts";

const BASE = CommitSha.make("a".repeat(40));
const AHEAD = CommitSha.make("b".repeat(40));
const SNAPSHOT = CommitSha.make("c".repeat(40));
const REFUSED = CommitSha.make("f".repeat(40));
const WORKTREE = "/workers/local/attempts/run_execute_1";
const REF = SalvageRef.make("usine/salvage/run/1");

interface Scripted {
  readonly head: () => string;
  readonly status: string;
  readonly inspect?: "fails" | "fails without a cause message";
  readonly add?: "fails";
  readonly commit?: "fails";
  readonly push?: "fails" | "refuses-large-file" | "stalls";
}

/** A failed git command as an executor reports it: the exit code in the message and git's stderr as the cause. */
const PUSH_REJECTED = new ExecutorOperationError({
  operation: "cleanup",
  message: "git exited with code 128",
  cause: new Error("remote: Repository not found.\n"),
});

/** GitHub's refusal of a push with a file over its size limit, as git reports it. */
const LARGE_FILE_REFUSED = new ExecutorOperationError({
  operation: "cleanup",
  message: "git exited with code 1",
  cause: new Error(
    [
      "remote: error: File .pnpm-store/v11/files/3f/0a1b-exec is 279.12 MB; this exceeds GitHub's file size limit of 100.00 MB",
      "remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.",
      " ! [remote rejected] HEAD -> usine/salvage/run/1 (pre-receive hook declined)",
      "error: failed to push some refs to 'https://github.com/acme/demo.git'",
    ].join("\n"),
  ),
});

/** A failed git command whose cause is an `Error` without a message, such as Effect's `TimeoutError`. */
const NO_CAUSE_MESSAGE = new ExecutorOperationError({
  operation: "cleanup",
  message: "Can't run ssh",
  cause: new Cause.TimeoutError(),
});

/** Returns a git that responds from `script` and records every call in order. */
const fakeGit = (script: Scripted) => {
  const calls: Array<ReadonlyArray<string>> = [];
  let committed = false;
  const git = (args: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      calls.push(args);
      assert.deepStrictEqual(args.slice(0, 2), ["-C", WORKTREE]);
      const command = args.slice(2);
      if (command[0] === "rev-parse")
        return Effect.succeed(`${committed ? SNAPSHOT : script.head()}\n`);
      if (command[0] === "status") {
        if (script.inspect === "fails") return Effect.fail(new Error("inspection failed"));
        if (script.inspect === "fails without a cause message")
          return Effect.fail(NO_CAUSE_MESSAGE);
        return Effect.succeed(script.status);
      }
      if (command[0] === "add")
        return script.add === "fails"
          ? Effect.fail(new Error("index.lock exists"))
          : Effect.succeed("");
      if (command[0] === "reset") return Effect.succeed("");
      if (command[0] === "diff") return Effect.succeed("src/index.ts\0");
      if (command[0] === "write-tree") return Effect.succeed(`${"d".repeat(40)}\n`);
      if (command[0] === "ls-tree")
        return Effect.succeed(`100644 blob ${"e".repeat(40)}      42\tsrc/index.ts\0`);
      if (command.includes("commit")) {
        if (script.commit === "fails") return Effect.fail(new Error("nothing added"));
        committed = true;
        return Effect.succeed("");
      }
      if (command[0] === "push") {
        if (script.push === "fails") return Effect.fail(PUSH_REJECTED);
        if (script.push === "refuses-large-file") return Effect.fail(LARGE_FILE_REFUSED);
        return script.push === "stalls" ? Effect.never : Effect.succeed("");
      }
      return Effect.die(`unexpected git ${command.join(" ")}`);
    });
  return { git, calls };
};

const salvage = (script: Scripted, rejected = Option.none<SalvageRejected>()) => {
  const { git, calls } = fakeGit(script);
  return salvageWorktree({
    attemptId: AttemptId.make("run/execute/1"),
    worker: WorkerName.make("local"),
    host: "local",
    worktree: WORKTREE,
    baseCommit: Option.some(BASE),
    ref: REF,
    rejected,
    git,
  }).pipe(Effect.map((result) => ({ result, calls })));
};

/** Returns each call's git command, after `-C <worktree>` and any `-c <config>` options. */
const commandsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.map((args) =>
    args.slice(2).find((arg, index, rest) => arg !== "-c" && rest[index - 1] !== "-c"),
  );

describe("salvageWorktree", () => {
  it.effect("leaves a clean worktree at its base alone", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* salvage({ head: () => BASE, status: "" });
      assert(Option.isNone(result));
      assert.deepStrictEqual(commandsOf(calls).sort(), ["rev-parse", "status"]);
    }),
  );

  it.effect(
    "commits uncommitted changes as a wip snapshot and pushes the head to the salvage ref",
    () =>
      Effect.gen(function* () {
        const { result, calls } = yield* salvage({
          head: () => AHEAD,
          status: " M src/index.ts\n",
        });
        assert(Option.isSome(result) && result.value._tag === "Pushed");
        assert.strictEqual(result.value.ref, REF);
        assert.strictEqual(result.value.commit, SNAPSHOT);
        const commit = calls.find((args) => args.includes("commit"));
        assert(commit !== undefined);
        assert(commit.includes("--no-verify"));
        assert(commit.includes("wip(usine): salvage attempt run/execute/1"));
        const push = calls.at(-1);
        assert.deepStrictEqual(push?.slice(2), [
          "push",
          "--force",
          "--no-verify",
          "origin",
          `${SNAPSHOT}:refs/heads/${REF}`,
        ]);
      }),
  );

  it.effect(
    "pushes commits ahead of the base without creating a snapshot when nothing is dirty",
    () =>
      Effect.gen(function* () {
        const { result, calls } = yield* salvage({ head: () => AHEAD, status: "" });
        assert(Option.isSome(result) && result.value._tag === "Pushed");
        assert.strictEqual(result.value.commit, AHEAD);
        assert(!commandsOf(calls).includes("commit"));
      }),
  );

  it.effect("retains dirty work when the snapshot commit fails even with commits ahead", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: "?? scratch.txt\n",
        commit: "fails",
      });
      assert(Option.isSome(result) && result.value._tag === "Retained");
      assert.deepStrictEqual(result.value.commit, Option.some(AHEAD));
    }),
  );

  it.effect.each(["inspect", "add", "commit"] as const)(
    "retains dirty work at base when %s fails",
    (stage) =>
      Effect.gen(function* () {
        const { result, calls } = yield* salvage({
          head: () => BASE,
          status: "?? unfinished.ts\n",
          [stage]: "fails",
        });
        assert(Option.isSome(result) && result.value._tag === "Retained");
        assert.strictEqual(result.value.path, WORKTREE);
        assert(!commandsOf(calls).includes("push"));
      }),
  );

  // A defect here skipped the checkout's removal, so the machine stayed and the Run failed with
  // a step executor defect (#602).
  it.effect("retains the worktree when a git failure's cause has no message", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: "",
        inspect: "fails without a cause message",
      });
      assert(Option.isSome(result) && result.value._tag === "Retained");
      assert.strictEqual(result.value.path, WORKTREE);
      assert.strictEqual(result.value.message, "Can't run ssh");
    }),
  );

  it.effect("reports the retained worktree and git's own diagnostic when the push fails", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: " M src/index.ts\n",
        push: "fails",
      });
      assert(Option.isSome(result) && result.value._tag === "Retained");
      assert.strictEqual(result.value.path, WORKTREE);
      assert.deepStrictEqual(result.value.commit, Option.some(SNAPSHOT));
      // The exit code alone can't distinguish a deleted remote from a revoked App.
      assert.include(result.value.message, "git exited with code 128");
      assert.include(result.value.message, "remote: Repository not found.");
    }),
  );

  it.effect("records a push that GitHub refuses for a file over its size limit as rejected", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: "",
        push: "refuses-large-file",
      });
      assert(Option.isSome(result) && result.value._tag === "Rejected");
      assert.strictEqual(result.value.path, WORKTREE);
      assert.strictEqual(result.value.commit, AHEAD);
      assert.include(result.value.message, "GH001: Large files detected");
    }),
  );

  it.effect("pushes a rejected checkout again only once its commit changes", () =>
    Effect.gen(function* () {
      const rejected = new SalvageRejected({ path: WORKTREE, commit: AHEAD, message: "GH001" });
      const unchanged = yield* salvage({ head: () => AHEAD, status: "" }, Option.some(rejected));
      assert.deepStrictEqual(unchanged.result, Option.some(rejected));
      assert(!commandsOf(unchanged.calls).includes("push"));

      const changed = yield* salvage(
        { head: () => AHEAD, status: " M src/index.ts\n" },
        Option.some(rejected),
      );
      assert(Option.isSome(changed.result) && changed.result.value._tag === "Pushed");
      assert.strictEqual(changed.result.value.commit, SNAPSHOT);
    }),
  );

  it.effect.each(["inspect", "add", "commit"] as const)(
    "keeps the recorded rejection when %s fails, so that the next recovery doesn't push the refused commit",
    (stage) =>
      Effect.gen(function* () {
        const rejected = new SalvageRejected({ path: WORKTREE, commit: AHEAD, message: "GH001" });
        const failed = yield* salvage(
          { head: () => AHEAD, status: "?? unfinished.ts\n", [stage]: "fails" },
          Option.some(rejected),
        );
        assert.deepStrictEqual(failed.result, Option.some(rejected));
        assert(!commandsOf(failed.calls).includes("push"));

        // The next startup's recovery gets the recorded salvage back as its rejection.
        const recorded = Option.filter(
          failed.result,
          (result): result is SalvageRejected => result._tag === "Rejected",
        );
        const healthy = yield* salvage({ head: () => AHEAD, status: "" }, recorded);
        assert.deepStrictEqual(healthy.result, Option.some(rejected));
        assert(!commandsOf(healthy.calls).includes("push"));
      }),
  );

  it.effect(
    "retains a checkout whose head moved past the rejected commit when its commit fails",
    () =>
      Effect.gen(function* () {
        const rejected = new SalvageRejected({ path: WORKTREE, commit: REFUSED, message: "GH001" });
        const { result } = yield* salvage(
          { head: () => AHEAD, status: "?? unfinished.ts\n", commit: "fails" },
          Option.some(rejected),
        );
        assert(Option.isSome(result) && result.value._tag === "Retained");
        assert.deepStrictEqual(result.value.commit, Option.some(AHEAD));
        assert.include(result.value.message, "nothing added");
      }),
  );

  it.effect("names the stalled push instead of a bare timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        salvage({ head: () => AHEAD, status: "", push: "stalls" }),
      );
      yield* TestClock.adjust("2 minutes");
      const { result } = yield* Fiber.join(fiber);
      assert(Option.isSome(result) && result.value._tag === "Retained");
      assert.include(result.value.message, "git push didn't finish");
    }),
  );
});

/**
 * Creates a checkout at its base commit with a bare `origin`, in a directory removed with the
 * test's scope. `git` runs git as the local executor does.
 */
const gitCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = (args: ReadonlyArray<string>) =>
    collectCommand(spawner, "cleanup", "git", args, {}).pipe(
      Effect.flatMap((result) => requireSuccess("cleanup", "local", "git", args, result)),
    );
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-salvage-" });
  const remote = `${root}/origin.git`;
  const worktree = `${root}/checkout`;
  yield* git(["init", "--quiet", "--bare", remote]);
  yield* git(["init", "--quiet", worktree]);
  yield* git(["-C", worktree, "config", "user.name", "Usine Test"]);
  yield* git(["-C", worktree, "config", "user.email", "usine@example.invalid"]);
  yield* git(["-C", worktree, "remote", "add", "origin", remote]);
  yield* fileSystem.writeFileString(`${worktree}/README.md`, "# fixture\n");
  yield* git(["-C", worktree, "add", "README.md"]);
  yield* git(["-C", worktree, "commit", "--quiet", "--message", "fixture"]);
  const base = CommitSha.make((yield* git(["-C", worktree, "rev-parse", "HEAD"])).trim());
  const write = (file: string, content: string) =>
    fileSystem
      .makeDirectory(`${worktree}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(`${worktree}/${file}`, content)));
  // pnpm's store is in the checkout when its default store is on another filesystem.
  const installDependencies = Effect.all([
    write(".pnpm-store/v11/files/00/abc-exec", "binary\n"),
    write("node_modules/left-pad/index.js", "module.exports = 1;\n"),
    write("packages/app/node_modules/.bin/tool", "#!/bin/sh\n"),
    write(".turbo/cache/run.json", "{}\n"),
  ]);
  const writeLargeFile = (file: string) =>
    fileSystem
      .writeFileString(`${worktree}/${file}`, "")
      .pipe(Effect.andThen(fileSystem.truncate(`${worktree}/${file}`, 100 * 1024 * 1024 + 1)));
  const salvage = salvageWorktree({
    attemptId: AttemptId.make("run/execute/1"),
    worker: WorkerName.make("local"),
    host: "local",
    worktree,
    baseCommit: Option.some(base),
    ref: REF,
    rejected: Option.none(),
    git,
  });
  /** The salvage ref's commit in `origin` and its files. */
  const pushed = Effect.gen(function* () {
    const commit = (yield* git(["--git-dir", remote, "rev-parse", REF])).trim();
    const files = yield* git(["--git-dir", remote, "ls-tree", "-r", "--name-only", commit]);
    return { commit, files: files.trim().split("\n") };
  });
  return { git, remote, worktree, write, writeLargeFile, installDependencies, salvage, pushed };
});

describe("salvageWorktree in a git checkout", () => {
  it.live(
    "pushes the work without package stores, build caches, and files larger than GitHub accepts, and keeps the checkout that has those files",
    () =>
      Effect.gen(function* () {
        const { worktree, write, writeLargeFile, installDependencies, salvage, pushed } =
          yield* gitCheckout;
        yield* write("src/feature.ts", "export const feature = 1;\n");
        yield* installDependencies;
        yield* writeLargeFile("model.bin");

        const result = yield* salvage;

        const { commit, files } = yield* pushed;
        assert.deepStrictEqual(files, ["README.md", "src/feature.ts"]);
        assert(Option.isSome(result) && result.value._tag === "PartlyPushed");
        assert.strictEqual(result.value.ref, REF);
        assert.strictEqual(result.value.commit, commit);
        assert.strictEqual(result.value.path, worktree);
        assert.include(result.value.message, "model.bin (100.0 MiB)");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("leaves out package stores and build caches that the Attempt staged itself", () =>
    Effect.gen(function* () {
      const { git, worktree, write, installDependencies, salvage, pushed } = yield* gitCheckout;
      yield* write("src/feature.ts", "export const feature = 1;\n");
      yield* installDependencies;
      yield* git(["-C", worktree, "add", "--all"]);

      const result = yield* salvage;

      const { commit, files } = yield* pushed;
      assert.deepStrictEqual(files, ["README.md", "src/feature.ts"]);
      assert(Option.isSome(result) && result.value._tag === "Pushed");
      assert.strictEqual(result.value.commit, commit);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps a checkout at its base whose only change is a file larger than GitHub accepts",
    () =>
      Effect.gen(function* () {
        const { git, remote, worktree, writeLargeFile, salvage } = yield* gitCheckout;
        yield* writeLargeFile("model.bin");

        const result = yield* salvage;

        assert(Option.isSome(result) && result.value._tag === "Retained");
        assert.strictEqual(result.value.path, worktree);
        assert.include(result.value.message, "model.bin (100.0 MiB)");
        assert.strictEqual(yield* git(["--git-dir", remote, "branch", "--list"]), "");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "finds nothing to salvage in a checkout at its base with only installed dependencies",
    () =>
      Effect.gen(function* () {
        const { git, remote, installDependencies, salvage } = yield* gitCheckout;
        yield* installDependencies;

        const result = yield* salvage;

        assert(Option.isNone(result));
        assert.strictEqual(yield* git(["--git-dir", remote, "branch", "--list"]), "");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
