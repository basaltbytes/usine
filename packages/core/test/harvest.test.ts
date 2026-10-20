import { assert, describe, it } from "@effect/vitest";
import { Data, DateTime, Effect, Logger, Option } from "effect";
import { Agent, AgentName, AgentPersona } from "../src/agent/agent.ts";
import { BrainSpec, ModelId } from "../src/agent/brain.ts";
import { AttemptId } from "../src/attempt/attempt.ts";
import { CommitSha, RepositoryName, RepositoryRevision } from "../src/repository.ts";
import { type HarvestSpec, harvestFacts } from "../src/step/harvest.ts";
import type { StepResultFact } from "../src/step/result.ts";
import { BotLogin } from "../src/worker.ts";

const BASE = CommitSha.make("a".repeat(40));
const HEAD = CommitSha.make("b".repeat(40));
const OTHER = CommitSha.make("c".repeat(40));

const spec: HarvestSpec = {
  attemptId: AttemptId.make("run_execute_1"),
  repository: RepositoryName.make("acme/demo"),
  revision: RepositoryRevision.make("main"),
  baseCommit: BASE,
  payload: { tick: { scheduledAt: "2026-10-19T12:00:00Z" } },
  preparedAt: Option.some(DateTime.makeUnsafe("2026-10-19T12:00:00.250Z")),
  botLogin: Option.some(BotLogin.make("usine-test[bot]")),
  agent: new Agent({
    name: AgentName.make("developer"),
    brain: new BrainSpec({
      harness: "claude",
      model: ModelId.make("claude-sonnet-4-6"),
      effort: "high",
    }),
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make("Implement the issue."),
  }),
};

class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

type Answer = Effect.Effect<ReadonlyArray<string>, CommandFailed>;

const PULL_REQUESTS = `gh api repos/acme/demo/commits/${HEAD}/pulls?per_page=100 --paginate --slurp`;

/**
 * Harvests a checkout whose agent committed `HEAD` on top of the base, with
 * `remoteRefs` as the remote's branch and pull request refs, `pullRequests`
 * as GitHub's answer for the final commit, and `github` answering the other
 * GitHub commands for `harvested`. Returns the facts, the commands run, and
 * the log lines at warning level or above.
 */
const harvest = (
  remoteRefs: ReadonlyArray<string>,
  pullRequests: Answer,
  github: ReadonlyArray<readonly [string, Answer]> = [],
  harvested: HarvestSpec = spec,
) => {
  const commands: Array<string> = [];
  const warnings: Array<string> = [];
  const answers = new Map<string, Answer>([
    [`git log --reverse --format=%H %s ${BASE}..HEAD`, Effect.succeed([`${HEAD} Fix the issue`])],
    ["git rev-parse HEAD", Effect.succeed([HEAD])],
    ["git branch --show-current", Effect.succeed([])],
    ["git ls-remote origin refs/heads/* refs/pull/*/head", Effect.succeed(remoteRefs)],
    [PULL_REQUESTS, pullRequests],
    ...github,
  ]);
  return harvestFacts(harvested, (command, args) => {
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

const NEVER_ASKED: Answer = Effect.die("the final commit was never pushed");
const BOT = "usine-test[bot]";
const SINCE = "2026-10-19T12:00:00Z";
const VIEWER = "gh api graphql -f query=query { viewer { login } }";
const ISSUE_COMMENTS = `gh api repos/acme/demo/issues/12/comments?since=${SINCE}&per_page=100 --paginate --slurp`;
const pages = (...items: ReadonlyArray<object>): Answer =>
  Effect.succeed([JSON.stringify([items])]);
/** A body the Attempt's Agent signed as its prompt asks, ending with a newline as `gh` bodies often do. */
const signed = (text: string) => `${text}\n\n— usine agent: developer\n`;
const comments = (facts: ReadonlyArray<StepResultFact>) =>
  facts.flatMap((fact) => (fact._tag === "Comment" ? [[fact.kind, fact.url.href]] : []));

/** A Run on pull request 71 or issue 12 of acme/demo, prepared at 12:00:00.250. */
const itemRun = (path: "pull/71" | "issues/12"): HarvestSpec => ({
  ...spec,
  payload: { number: Number(path.split("/")[1]), url: `https://github.com/acme/demo/${path}` },
});

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

  it.effect(
    "records what the RunSpec's bot login wrote on its pull request since preparation",
    () =>
      Effect.gen(function* () {
        const conversation = "https://github.com/acme/demo/pull/71#issuecomment-11";
        const review = "https://github.com/acme/demo/pull/71#pullrequestreview-21";
        const reply = "https://github.com/acme/demo/pull/71#discussion_r31";
        const { facts, warnings } = yield* harvest(
          [],
          NEVER_ASKED,
          [
            [
              `gh api repos/acme/demo/issues/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              pages(
                {
                  html_url: conversation,
                  body: signed("Done."),
                  user: { login: BOT },
                  created_at: "2026-10-19T12:01:00Z",
                  updated_at: "2026-10-19T12:04:00Z",
                },
                {
                  html_url: "https://github.com/acme/demo/pull/71#issuecomment-12",
                  body: signed("Done."),
                  user: { login: "octocat" },
                  created_at: "2026-10-19T12:05:00Z",
                  updated_at: "2026-10-19T12:05:00Z",
                },
              ),
            ],
            [
              "gh api repos/acme/demo/pulls/71/reviews?per_page=100 --paginate --slurp",
              pages(
                {
                  id: 20,
                  html_url: "https://github.com/acme/demo/pull/71#pullrequestreview-20",
                  body: signed("Done."),
                  user: { login: BOT },
                  state: "COMMENTED",
                  submitted_at: "2026-10-18T09:00:00Z",
                },
                {
                  id: 21,
                  html_url: review,
                  body: signed("Done."),
                  user: { login: BOT },
                  state: "COMMENTED",
                  submitted_at: "2026-10-19T12:06:00Z",
                },
                {
                  id: 22,
                  html_url: "https://github.com/acme/demo/pull/71#pullrequestreview-22",
                  body: signed("Done."),
                  user: { login: BOT },
                  state: "PENDING",
                },
                {
                  id: 23,
                  html_url: "https://github.com/acme/demo/pull/71#pullrequestreview-23",
                  body: signed("Done."),
                  user: null,
                  state: "COMMENTED",
                  submitted_at: "2026-10-19T12:07:00Z",
                },
              ),
            ],
            [
              `gh api repos/acme/demo/pulls/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              pages(
                {
                  html_url: reply,
                  body: signed("Done."),
                  user: { login: BOT },
                  created_at: "2026-10-19T12:02:00Z",
                  updated_at: "2026-10-19T12:06:00Z",
                  pull_request_review_id: 21,
                },
                {
                  html_url: "https://github.com/acme/demo/pull/71#discussion_r32",
                  body: signed("Done."),
                  user: { login: BOT },
                  created_at: "2026-10-19T12:08:00Z",
                  updated_at: "2026-10-19T12:08:00Z",
                  pull_request_review_id: 22,
                },
              ),
            ],
          ],
          itemRun("pull/71"),
        );
        assert.deepStrictEqual(comments(facts), [
          ["issue-comment", conversation],
          ["review", review],
          ["review-comment", reply],
        ]);
        // A comment is dated by its creation, even when the Attempt edited it later; a review by its submission.
        assert.deepStrictEqual(
          facts.flatMap((fact) =>
            fact._tag === "Comment" ? [Option.map(fact.at, DateTime.formatIso)] : [],
          ),
          [
            Option.some("2026-10-19T12:01:00.000Z"),
            Option.some("2026-10-19T12:06:00.000Z"),
            Option.some("2026-10-19T12:02:00.000Z"),
          ],
        );
        assert.strictEqual(facts[0]?._tag, "Commit");
        assert.deepStrictEqual(warnings, []);
      }),
  );

  it.effect(
    "records only the comments and reviews that end with the Attempt's Agent's signature",
    () =>
      Effect.gen(function* () {
        const at = { created_at: "2026-10-19T12:01:00Z", updated_at: "2026-10-19T12:01:00Z" };
        const submitted = { state: "COMMENTED", submitted_at: "2026-10-19T12:01:00Z" };
        const url = (anchor: string) => `https://github.com/acme/demo/pull/71#${anchor}`;
        // Another Loop's Attempt on the same pull request writes as the same bot login.
        const reviewer = (text: string) => `${text}\n\n— usine agent: reviewer`;
        const { facts } = yield* harvest(
          [],
          NEVER_ASKED,
          [
            [
              `gh api repos/acme/demo/issues/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              pages(
                {
                  html_url: url("issuecomment-11"),
                  body: signed("Fixed."),
                  user: { login: BOT },
                  ...at,
                },
                {
                  html_url: url("issuecomment-12"),
                  body: reviewer("Found two issues."),
                  user: { login: BOT },
                  ...at,
                },
                { html_url: url("issuecomment-13"), body: "Fixed.", user: { login: BOT }, ...at },
                {
                  html_url: url("issuecomment-14"),
                  body: "— usine agent: developer\n\nwrote the above.",
                  user: { login: BOT },
                  ...at,
                },
              ),
            ],
            [
              "gh api repos/acme/demo/pulls/71/reviews?per_page=100 --paginate --slurp",
              pages(
                {
                  id: 21,
                  html_url: url("pullrequestreview-21"),
                  body: signed("Replied."),
                  user: { login: BOT },
                  ...submitted,
                },
                {
                  id: 22,
                  html_url: url("pullrequestreview-22"),
                  body: reviewer("Two findings."),
                  user: { login: BOT },
                  ...submitted,
                },
                {
                  id: 23,
                  html_url: url("pullrequestreview-23"),
                  body: "",
                  user: { login: BOT },
                  ...submitted,
                },
              ),
            ],
            [
              `gh api repos/acme/demo/pulls/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              pages(
                {
                  html_url: url("discussion_r31"),
                  body: signed("Renamed."),
                  user: { login: BOT },
                  pull_request_review_id: 21,
                  ...at,
                },
                {
                  html_url: url("discussion_r32"),
                  body: reviewer("P1: rename this."),
                  user: { login: BOT },
                  pull_request_review_id: 22,
                  ...at,
                },
              ),
            ],
          ],
          itemRun("pull/71"),
        );
        assert.deepStrictEqual(comments(facts), [
          ["issue-comment", url("issuecomment-11")],
          ["review", url("pullrequestreview-21")],
          ["review-comment", url("discussion_r31")],
        ]);
      }),
  );

  it.effect("reads only the conversation of an issue", () =>
    Effect.gen(function* () {
      const comment = "https://github.com/acme/demo/issues/12#issuecomment-41";
      const { facts } = yield* harvest(
        [],
        NEVER_ASKED,
        [
          [
            ISSUE_COMMENTS,
            pages({
              html_url: comment,
              body: signed("Done."),
              user: { login: BOT },
              created_at: "2026-10-19T12:01:00Z",
              updated_at: "2026-10-19T12:04:00Z",
            }),
          ],
        ],
        itemRun("issues/12"),
      );
      assert.deepStrictEqual(comments(facts), [["issue-comment", comment]]);
    }),
  );

  it.effect(
    "matches the login GitHub reports for the Attempt's credential when the RunSpec names none",
    () =>
      Effect.gen(function* () {
        const integration = "exe-dev-github-integration[bot]";
        const comment = "https://github.com/acme/demo/issues/12#issuecomment-42";
        const { facts, commands } = yield* harvest(
          [],
          NEVER_ASKED,
          [
            [
              VIEWER,
              Effect.succeed([JSON.stringify({ data: { viewer: { login: integration } } })]),
            ],
            [
              ISSUE_COMMENTS,
              pages(
                {
                  html_url: comment,
                  body: signed("Done."),
                  user: { login: integration },
                  created_at: SINCE,
                  updated_at: SINCE,
                },
                {
                  html_url: "https://github.com/acme/demo/issues/12#issuecomment-43",
                  body: signed("Done."),
                  user: { login: BOT },
                  created_at: SINCE,
                  updated_at: SINCE,
                },
              ),
            ],
          ],
          { ...itemRun("issues/12"), botLogin: Option.none() },
        );
        assert.include(commands, VIEWER);
        assert.deepStrictEqual(comments(facts), [["issue-comment", comment]]);
      }),
  );

  it.effect(
    "asks GitHub nothing about comments for a Run without an Item or a preparation time",
    () =>
      Effect.gen(function* () {
        for (const harvested of [spec, { ...itemRun("pull/71"), preparedAt: Option.none() }]) {
          const { facts, commands } = yield* harvest([], NEVER_ASKED, [], harvested);
          assert.deepStrictEqual(
            facts.map((fact) => fact._tag),
            ["Commit"],
          );
          assert.isFalse(commands.some((command) => command.startsWith("gh ")));
        }
      }),
  );

  it.effect("keeps the commits and warns when comment discovery fails", () =>
    Effect.gen(function* () {
      const { facts, warnings } = yield* harvest(
        [],
        NEVER_ASKED,
        [[ISSUE_COMMENTS, Effect.fail(new CommandFailed({ message: "gh exited with code 1" }))]],
        itemRun("issues/12"),
      );
      assert.deepStrictEqual(
        facts.map((fact) => fact._tag),
        ["Commit"],
      );
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "Comment discovery failed");
    }),
  );
});
