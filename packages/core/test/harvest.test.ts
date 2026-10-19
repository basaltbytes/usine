import { assert, describe, it } from "@effect/vitest";
import { Data, Effect, Logger } from "effect";
import { AttemptId } from "../src/attempt/attempt.ts";
import { CommitSha, RepositoryName, RepositoryRevision } from "../src/repository.ts";
import { type HarvestSpec, harvestFacts } from "../src/step/harvest.ts";

const BASE = CommitSha.make("a".repeat(40));
const HEAD = CommitSha.make("b".repeat(40));
const OTHER = CommitSha.make("c".repeat(40));

const spec: HarvestSpec = {
  attemptId: AttemptId.make("run_execute_1"),
  repository: RepositoryName.make("acme/demo"),
  revision: RepositoryRevision.make("main"),
  baseCommit: BASE,
};

class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

const PULL_REQUESTS = `gh api repos/acme/demo/commits/${HEAD}/pulls?per_page=100 --paginate --slurp`;

/**
 * Harvests a checkout whose agent committed `HEAD` on top of the base, with
 * `remoteRefs` as the remote's branch and pull request refs and `pullRequests`
 * as GitHub's answer. Returns the facts, the commands run, and the log lines
 * at warning level or above.
 */
const harvest = (
  remoteRefs: ReadonlyArray<string>,
  pullRequests: Effect.Effect<ReadonlyArray<string>, CommandFailed>,
) => {
  const commands: Array<string> = [];
  const warnings: Array<string> = [];
  const answers = new Map<string, Effect.Effect<ReadonlyArray<string>, CommandFailed>>([
    [`git log --reverse --format=%H %s ${BASE}..HEAD`, Effect.succeed([`${HEAD} Fix the issue`])],
    ["git rev-parse HEAD", Effect.succeed([HEAD])],
    ["git branch --show-current", Effect.succeed([])],
    ["git ls-remote origin refs/heads/* refs/pull/*/head", Effect.succeed(remoteRefs)],
    [PULL_REQUESTS, pullRequests],
  ]);
  return harvestFacts(spec, (command, args) => {
    const line = [command, ...args].join(" ");
    commands.push(line);
    return answers.get(line) ?? Effect.die(`unexpected command ${line}`);
  }).pipe(
    Effect.map((facts) => ({ facts, commands, warnings })),
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") warnings.push(JSON.stringify(message));
        }),
      ]),
    ),
  );
};

describe("harvesting an Attempt's facts", () => {
  it.effect("asks GitHub nothing and warns of nothing when the final commit was never pushed", () =>
    Effect.gen(function* () {
      const { facts, commands, warnings } = yield* harvest(
        [`${OTHER}\trefs/heads/main`, `${BASE}\trefs/pull/7/head`],
        Effect.fail(new CommandFailed({ message: "gh exited with code 1" })),
      );
      assert.deepStrictEqual(
        facts.map((fact) => fact._tag),
        ["Commit"],
      );
      assert.notInclude(commands, PULL_REQUESTS);
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("records the pull request whose head is the pushed final commit", () =>
    Effect.gen(function* () {
      const { facts, warnings } = yield* harvest(
        [`${OTHER}\trefs/heads/main`, `${HEAD}\trefs/heads/usine/fix`],
        Effect.succeed([
          JSON.stringify([
            [
              { number: 71, html_url: "https://github.com/acme/demo/pull/71", head: { sha: HEAD } },
              { number: 5, html_url: "https://github.com/acme/demo/pull/5", head: { sha: OTHER } },
            ],
          ]),
        ]),
      );
      assert.deepStrictEqual(
        facts.flatMap((fact) => (fact._tag === "PullRequest" ? [fact.number] : [])),
        [71],
      );
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("finds a pushed final commit by its pull request ref once its branch is gone", () =>
    Effect.gen(function* () {
      const { commands } = yield* harvest(
        [`${HEAD}\trefs/pull/71/head`],
        Effect.succeed([JSON.stringify([[]])]),
      );
      assert.include(commands, PULL_REQUESTS);
    }),
  );

  it.effect("keeps the commits and warns when GitHub fails for a pushed final commit", () =>
    Effect.gen(function* () {
      const { facts, warnings } = yield* harvest(
        [`${HEAD}\trefs/heads/usine/fix`],
        Effect.fail(new CommandFailed({ message: "gh exited with code 1" })),
      );
      assert.deepStrictEqual(
        facts.map((fact) => fact._tag),
        ["Commit"],
      );
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "Pull request discovery failed");
    }),
  );
});
