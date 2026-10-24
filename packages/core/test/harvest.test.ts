import { assert, describe, it } from "@effect/vitest";
import { Data, DateTime, Effect, Logger, Option } from "effect";
import { Agent, AgentName, AgentPersona } from "../src/agent/agent.ts";
import { BrainSpec, ModelId } from "../src/agent/brain.ts";
import { AttemptId, AttemptWindow, AttemptWindows } from "../src/attempt/attempt.ts";
import { CommitSha, RepositoryName, RepositoryRevision } from "../src/repository.ts";
import {
  type AttemptWindowsRead,
  type HarvestSpec,
  harvestFacts,
  harvestPostedComments,
} from "../src/step/harvest.ts";
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

/** Returns an Attempt window that is open if `endedAt` is `null`. */
const window = (attemptId: AttemptId, startedAt: string, endedAt: string | null = null) =>
  new AttemptWindow({
    attemptId,
    startedAt: DateTime.makeUnsafe(startedAt),
    endedAt: Option.fromNullOr(endedAt).pipe(Option.map(DateTime.makeUnsafe)),
  });

/** The windows of `spec`'s Attempt, open since 12:00:00.100, with no overlapping Attempt. */
const ALONE = new AttemptWindows({
  own: Option.some(window(spec.attemptId, "2026-10-19T12:00:00.100Z")),
  overlapping: [],
});

type Answer = Effect.Effect<ReadonlyArray<string>, CommandFailed>;

const PULL_REQUESTS = `gh api repos/acme/demo/commits/${HEAD}/pulls?per_page=100 --paginate --slurp`;

/**
 * Runs `harvestFacts` against scripted `git` and `gh` output. Returns the facts, the commands
 * run, the warning-or-higher log lines, and the info log messages.
 */
const harvest = (
  remoteRefs: ReadonlyArray<string>,
  pullRequests: Answer,
  github: ReadonlyArray<readonly [string, Answer]> = [],
  harvested: HarvestSpec = spec,
  windows: AttemptWindowsRead<CommandFailed> = Effect.succeed(ALONE),
) => {
  const commands: Array<string> = [];
  const warnings: Array<string> = [];
  const infos: Array<unknown> = [];
  const answers = new Map<string, Answer>([
    [`git log --reverse --format=%H %s ${BASE}..HEAD`, Effect.succeed([`${HEAD} Fix the issue`])],
    ["git rev-parse HEAD", Effect.succeed([HEAD])],
    ["git branch --show-current", Effect.succeed([])],
    ["git ls-remote origin refs/heads/* refs/pull/*/head", Effect.succeed(remoteRefs)],
    [PULL_REQUESTS, pullRequests],
    ...github,
  ]);
  return harvestFacts(
    harvested,
    (command, args) => {
      const line = [command, ...args].join(" ");
      commands.push(line);
      return answers.get(line) ?? Effect.die(`unexpected command ${line}`);
    },
    windows,
  ).pipe(
    Effect.map((facts) => ({ facts, commands, warnings, infos })),
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") warnings.push(JSON.stringify(message));
          if (logLevel === "Info") infos.push(message);
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
/** Returns `text` with the developer Agent's signature and a trailing newline. */
const signed = (text: string) => `${text}\n\n— usine agent: developer\n`;
const comments = (facts: ReadonlyArray<StepResultFact>) =>
  facts.flatMap((fact) => (fact._tag === "Comment" ? [[fact.kind, fact.url.href]] : []));

/** Returns a spec for pull request 71 or issue 12 of `acme/demo`, prepared at 12:00:00.250. */
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
        // A comment's time is its creation time, even if edited later; a review's is its submission time.
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

  it.effect(
    "leaves out what the Agent's other Attempt on the Item could have posted while both were open",
    () =>
      Effect.gen(function* () {
        // Two Loops run the developer Agent on pull request 71: the fix Attempt from 12:00 to
        // 12:10 and the docs Attempt from 12:05.
        const fix = AttemptId.make("fix/implement/1");
        const docs = AttemptId.make("docs/implement/1");
        const fixWindow = window(fix, "2026-10-19T12:00:00.100Z");
        const docsWindow = window(docs, "2026-10-19T12:05:00.700Z");
        const url = (anchor: string) => `https://github.com/acme/demo/pull/71#${anchor}`;
        const posted = (anchor: string, at: string) => ({
          html_url: url(anchor),
          body: signed("Done."),
          user: { login: BOT },
          created_at: at,
          updated_at: at,
        });
        const conversation = pages(
          // Posted the day before, and edited at 12:07 while both were open.
          {
            ...posted("issuecomment-0", "2026-10-18T09:00:00Z"),
            updated_at: "2026-10-19T12:07:00Z",
          },
          posted("issuecomment-1", "2026-10-19T12:01:00Z"),
          posted("issuecomment-2", "2026-10-19T12:07:00Z"),
          posted("issuecomment-3", "2026-10-19T12:15:00Z"),
        );
        const reviews: readonly [string, Answer] = [
          "gh api repos/acme/demo/pulls/71/reviews?per_page=100 --paginate --slurp",
          pages(),
        ];
        const listed = (since: string): ReadonlyArray<readonly [string, Answer]> => [
          [
            `gh api repos/acme/demo/issues/71/comments?since=${since}&per_page=100 --paginate --slurp`,
            conversation,
          ],
          reviews,
          [
            `gh api repos/acme/demo/pulls/71/comments?since=${since}&per_page=100 --paginate --slurp`,
            pages(),
          ],
        ];

        const fixed = yield* harvest(
          [],
          NEVER_ASKED,
          listed(SINCE),
          { ...itemRun("pull/71"), attemptId: fix },
          Effect.succeed(
            new AttemptWindows({ own: Option.some(fixWindow), overlapping: [docsWindow] }),
          ),
        );
        const documented = yield* harvest(
          [],
          NEVER_ASKED,
          listed("2026-10-19T12:05:01Z"),
          {
            ...itemRun("pull/71"),
            attemptId: docs,
            preparedAt: Option.some(DateTime.makeUnsafe("2026-10-19T12:05:01.250Z")),
          },
          Effect.succeed(
            new AttemptWindows({
              own: Option.some(docsWindow),
              overlapping: [window(fix, "2026-10-19T12:00:00.100Z", "2026-10-19T12:10:00.000Z")],
            }),
          ),
        );

        // The 12:07 comment is inside both windows, so neither Attempt records it. The comment
        // edited at 12:07 was created before both windows, so neither records it.
        assert.deepStrictEqual(comments(fixed.facts), [["issue-comment", url("issuecomment-1")]]);
        assert.deepStrictEqual(comments(documented.facts), [
          ["issue-comment", url("issuecomment-3")],
        ]);
        assert.deepInclude(fixed.infos, [
          "Left out a comment that another open Attempt of the Agent on the Item could have posted",
          {
            attemptId: fix,
            overlapping: [docs],
            comment: url("issuecomment-2"),
            kind: "issue-comment",
          },
        ]);
        assert.deepInclude(documented.infos, [
          "Left out a comment that another open Attempt of the Agent on the Item could have posted",
          {
            attemptId: docs,
            overlapping: [fix],
            comment: url("issuecomment-2"),
            kind: "issue-comment",
          },
        ]);
      }),
  );

  it.effect(
    "reads the windows once GitHub has listed the comments, so an Attempt that started during the harvest counts",
    () =>
      Effect.gen(function* () {
        // The docs Attempt starts on pull request 71 during the fix Attempt's harvest and posts
        // before GitHub responds.
        const docs = window(AttemptId.make("docs/implement/1"), "2026-10-19T12:10:01Z");
        const open: Array<AttemptWindow> = [];
        const comment = "https://github.com/acme/demo/pull/71#issuecomment-5";
        const { facts, infos } = yield* harvest(
          [],
          NEVER_ASKED,
          [
            [
              `gh api repos/acme/demo/issues/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              Effect.sync(() => void open.push(docs)).pipe(
                Effect.andThen(
                  pages({
                    html_url: comment,
                    body: signed("Done."),
                    user: { login: BOT },
                    created_at: "2026-10-19T12:10:03Z",
                    updated_at: "2026-10-19T12:10:03Z",
                  }),
                ),
              ),
            ],
            ["gh api repos/acme/demo/pulls/71/reviews?per_page=100 --paginate --slurp", pages()],
            [
              `gh api repos/acme/demo/pulls/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
              pages(),
            ],
          ],
          itemRun("pull/71"),
          Effect.sync(() => new AttemptWindows({ own: ALONE.own, overlapping: [...open] })),
        );
        assert.deepStrictEqual(comments(facts), []);
        assert.deepInclude(infos, [
          "Left out a comment that another open Attempt of the Agent on the Item could have posted",
          {
            attemptId: spec.attemptId,
            overlapping: [docs.attemptId],
            comment,
            kind: "issue-comment",
          },
        ]);
      }),
  );

  it.effect(
    "records no comment posted after a canceled Attempt's window ended, though no window overlaps it",
    () =>
      Effect.gen(function* () {
        // The operator cancels the fix Attempt at 12:10; the orchestrator ends its window, then
        // stops its executor, which harvests. The docs Attempt starts at 12:10:02, after that
        // window ended, and posts at 12:10:03.
        const canceled = window(spec.attemptId, "2026-10-19T12:00:00.100Z", "2026-10-19T12:10:00Z");
        const own = (anchor: string, at: string) => ({
          html_url: `https://github.com/acme/demo/pull/71#${anchor}`,
          body: signed("Done."),
          user: { login: BOT },
          created_at: at,
          updated_at: at,
        });
        const answers = new Map<string, Answer>([
          [
            `gh api repos/acme/demo/issues/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
            pages(
              own("issuecomment-1", "2026-10-19T12:09:59Z"),
              // Posted in the second the window ended; GitHub timestamps can't distinguish it.
              own("issuecomment-2", "2026-10-19T12:10:00Z"),
              own("issuecomment-3", "2026-10-19T12:10:03Z"),
            ),
          ],
          [
            "gh api repos/acme/demo/pulls/71/reviews?per_page=100 --paginate --slurp",
            pages({
              id: 9,
              html_url: "https://github.com/acme/demo/pull/71#pullrequestreview-9",
              body: signed("Approved."),
              user: { login: BOT },
              state: "COMMENTED",
              submitted_at: "2026-10-19T12:10:03Z",
            }),
          ],
          [
            `gh api repos/acme/demo/pulls/71/comments?since=${SINCE}&per_page=100 --paginate --slurp`,
            pages(),
          ],
        ]);
        const infos: Array<unknown> = [];
        const posted = yield* harvestPostedComments(
          itemRun("pull/71"),
          (command, args) =>
            answers.get([command, ...args].join(" ")) ?? Effect.die("unexpected command"),
          Effect.succeed(new AttemptWindows({ own: Option.some(canceled), overlapping: [] })),
        ).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make(({ logLevel, message }) => {
                if (logLevel === "Info") infos.push(message);
              }),
            ]),
          ),
        );
        assert.deepStrictEqual(
          posted.map(({ kind, url }) => [kind, url.href]),
          [
            ["issue-comment", "https://github.com/acme/demo/pull/71#issuecomment-1"],
            ["issue-comment", "https://github.com/acme/demo/pull/71#issuecomment-2"],
          ],
        );
        assert.deepInclude(infos, [
          "Left out a comment posted outside the Attempt's own window on the Item",
          {
            attemptId: spec.attemptId,
            window: "2026-10-19T12:00:00.100Z/2026-10-19T12:10:00.000Z",
            postedAt: "2026-10-19T12:10:03.000Z",
            comment: "https://github.com/acme/demo/pull/71#issuecomment-3",
            kind: "issue-comment",
          },
        ]);
        assert(
          infos.some(
            (message) =>
              Array.isArray(message) &&
              message[0] === "Collected the comments and reviews the Attempt posted on its Item" &&
              message[1].outside === 2 &&
              message[1].ambiguous === 0,
          ),
        );
      }),
  );

  it.effect(
    "fails a finished Attempt's harvest, and records no comment of an unsuccessful one, when the windows cannot be read",
    () =>
      Effect.gen(function* () {
        const listed: ReadonlyArray<readonly [string, Answer]> = [
          [
            ISSUE_COMMENTS,
            pages({
              html_url: "https://github.com/acme/demo/issues/12#issuecomment-44",
              body: signed("Done."),
              user: { login: BOT },
              created_at: "2026-10-19T12:01:00Z",
              updated_at: "2026-10-19T12:01:00Z",
            }),
          ],
        ];
        const unread = Effect.fail(
          new CommandFailed({ message: "the run tables are unavailable" }),
        );
        const error = yield* harvest([], NEVER_ASKED, listed, itemRun("issues/12"), unread).pipe(
          Effect.flip,
        );
        assert(error._tag === "HarvestError" && error.stage === "windows");

        const answers = new Map(listed);
        const posted = yield* harvestPostedComments(
          itemRun("issues/12"),
          (command, args) =>
            answers.get([command, ...args].join(" ")) ?? Effect.die("unexpected command"),
          unread,
        );
        assert.deepStrictEqual(posted, []);
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
