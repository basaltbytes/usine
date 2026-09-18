import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option } from "effect";
import { salvageWorktree } from "../src/salvage.ts";

const BASE = CommitSha.make("a".repeat(40));
const AHEAD = CommitSha.make("b".repeat(40));
const SNAPSHOT = CommitSha.make("c".repeat(40));
const WORKTREE = "/workers/local/attempts/run_execute_1";
const REF = SalvageRef.make("usine/salvage/run/1");

interface Scripted {
  readonly head: () => string;
  readonly status: string;
  readonly commit?: "fails";
  readonly push?: "fails";
}

/** A git that answers from the script and records every call, in order. */
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
      if (command[0] === "status") return Effect.succeed(script.status);
      if (command[0] === "add") return Effect.succeed("");
      if (command.includes("commit")) {
        if (script.commit === "fails") return Effect.fail(new Error("nothing added"));
        committed = true;
        return Effect.succeed("");
      }
      if (command[0] === "push") {
        return script.push === "fails"
          ? Effect.fail(new Error("remote rejected"))
          : Effect.succeed("");
      }
      return Effect.die(`unexpected git ${command.join(" ")}`);
    });
  return { git, calls };
};

const salvage = (script: Scripted) => {
  const { git, calls } = fakeGit(script);
  return salvageWorktree({
    attemptId: AttemptId.make("run/execute/1"),
    worker: WorkerName.make("local"),
    host: "local",
    worktree: WORKTREE,
    baseCommit: BASE,
    ref: REF,
    git,
  }).pipe(Effect.map((result) => ({ result, calls })));
};

const commandsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.map((args) => args.slice(2).filter((arg) => !arg.startsWith("user.") && arg !== "-c")[0]);

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

  it.effect("still pushes the committed work when the snapshot commit fails", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: "?? scratch.txt\n",
        commit: "fails",
      });
      assert(Option.isSome(result) && result.value._tag === "Pushed");
      assert.strictEqual(result.value.commit, AHEAD);
    }),
  );

  it.effect("reports the retained worktree when the push fails", () =>
    Effect.gen(function* () {
      const { result } = yield* salvage({
        head: () => AHEAD,
        status: " M src/index.ts\n",
        push: "fails",
      });
      assert(Option.isSome(result) && result.value._tag === "Retained");
      assert.strictEqual(result.value.path, WORKTREE);
      assert.strictEqual(result.value.commit, SNAPSHOT);
      assert(result.value.message.includes("remote rejected"));
    }),
  );
});
