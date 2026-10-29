import { assert, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { Effect, Option } from "effect";
import { readPushRefusal } from "../src/push-refusal.ts";

it.effect(
  "correlates interleaved transport errors with their push and scrubs an expired token on recovery",
  () =>
    Effect.gen(function* () {
      const token = "ghs_expiredInstallationToken";
      const diagnostic = `unable to access 'https://user:${token}@github.com/acme/demo/': The requested URL returned error: 403`;
      const events = [
        { event: "start", sid: "fetch", argv: ["git", "fetch", "origin"] },
        { event: "cmd_name", sid: "fetch", name: "fetch" },
        { event: "start", sid: "push", argv: ["git", "push", "origin", "HEAD:refs/heads/feature"] },
        { event: "cmd_name", sid: "push", name: "push" },
        { event: "error", sid: "fetch/transport", msg: diagnostic },
        { event: "error", sid: "push/transport", msg: diagnostic },
      ];
      const commit = CommitSha.make("a".repeat(40));
      const serverMessage = `remote: Permission to acme/demo.git denied to usine-test[bot]. ${token}\n${diagnostic}`;
      const read = (trace: string, response = "") =>
        readPushRefusal({
          attemptId: AttemptId.make("run/execute/1"),
          repository: RepositoryName.make("acme/demo"),
          worktree: "/checkout",
          git: (args) =>
            Effect.succeed(args.includes("--absolute-git-dir") ? "/checkout/.git" : commit),
          readFile: (path) =>
            Effect.succeed(
              path.endsWith(".jsonl")
                ? trace
                : path.endsWith("/push.stderr")
                  ? response
                  : path.endsWith("/fetch.stderr")
                    ? "unrelated fetch response"
                    : "",
            ),
        });
      assert(
        Option.isNone(
          yield* read(
            events
              .slice(0, -1)
              .map((event) => JSON.stringify(event))
              .join("\n"),
          ),
        ),
      );
      const pushTrace = events.map((event) => JSON.stringify(event)).join("\n");
      const legacy = yield* read(pushTrace);
      assert(Option.isSome(legacy));
      assert.include(legacy.value.message, "The requested URL returned error: 403");
      const retained = yield* read(pushTrace, serverMessage);
      assert(Option.isSome(retained) && Option.isSome(retained.value.pushFailure));
      const failure = retained.value.pushFailure.value;
      assert.strictEqual(failure.ref, "refs/heads/feature");
      assert.include(failure.message, "The requested URL returned error: 403");
      assert.include(failure.message, "Permission to acme/demo.git denied to usine-test[bot].");
      assert.notInclude(failure.message, "unrelated fetch response");
      assert.include(failure.message, "[REDACTED]");
      assert.notInclude(failure.message, token);
      assert.deepStrictEqual(retained.value.commit, Option.some(commit));
    }),
);
