import { assert, describe, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { IssueTrigger, PullRequestTrigger } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { CursorStore } from "@usine/engine/cursor";
import { Claimed, RunEngine } from "@usine/engine/engine";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import {
  ChangedIssue,
  ChangedPullRequest,
  ContentHash,
  EntityTag,
  GitHubItemNotFoundError,
  GitHubPolling,
  type IssuePayload,
  IssueSnapshot,
  PollCursor,
  PullRequestPayload,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryLabelCatalog,
  RepositoryNotModified,
} from "@usine/github/polling";
import { DateTime, Effect, Layer, Logger, Option, Schema } from "effect";
import { PollingTriggers } from "../src/polling-triggers.ts";
import {
  inertGitHubLabelWriterLayer,
  inertLabelReconcilerLayer,
  itemProjectionWriterLayer,
  itemProjectionReaderLayer,
  loopControlLayer,
  memoryCursorStore,
  noCycleBudgets,
  repositoryLabelProjectionReaderLayer,
  repositoryLabelProjectionWriterLayer,
} from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const updatedAt = DateTime.makeUnsafe("2026-10-17T10:00:00Z");
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: repository }],
  settings: { poll_interval: 60 },
});
const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});

const loop = (name: string, condition: string, body: string, on: "issue" | "pr" = "issue") =>
  new LoopFile({
    name: LoopName.make(name),
    trigger:
      on === "issue"
        ? new IssueTrigger({ on, if: Source.make(condition) })
        : new PullRequestTrigger({ on, if: Source.make(condition) }),
    selector: Option.none(),
    approval: "none",
    step: StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make(body),
  });

const instanceWith = (loops: ReadonlyArray<LoopFile>) =>
  new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
    warnings: [],
  });

const issuePayload = (number: number, milestone: string | null): IssuePayload => ({
  number,
  title: "Nullable fields",
  body: "",
  url: `https://github.com/basaltbytes/usine/issues/${number}`,
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-10-17T09:00:00Z",
  updatedAt: "2026-10-17T10:00:00Z",
  closedAt: null,
  author: null,
  issueType: null,
  milestone: milestone === null ? null : { title: milestone },
  labels: { totalCount: 1, nodes: [{ name: "ready" }] },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

const pullRequestPayload = (number: number) =>
  Schema.decodeUnknownSync(PullRequestPayload)({
    ...issuePayload(number, null),
    isDraft: false,
    merged: false,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "a".repeat(40),
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: null,
    reviewThreads: { totalCount: 0, nodes: [] },
    reviewRequests: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    closingIssuesReferences: { totalCount: 0, nodes: [] },
  });

const advanced = new PollCursor({
  entityTag: Option.some(EntityTag.make('W/"advanced"')),
  watermark: Option.some(updatedAt),
});

/** Returns `items` once from an empty cursor, then no changes. */
const changesOnce =
  (items: ReadonlyArray<ChangedIssue | ChangedPullRequest>): GitHubPolling["Service"]["changes"] =>
  (_repository, cursor) =>
    Effect.succeed(
      Option.isNone(cursor.entityTag)
        ? new RepositoryChanges({
            cursor: advanced,
            items,
            backlog: false,
            nextPollAt: Option.none(),
          })
        : new RepositoryNotModified({ cursor, nextPollAt: Option.none() }),
    );

const submissions: Array<string> = [];

const claimingRuns = Layer.succeed(RunEngine)({
  resolveFailure: () => Effect.void,
  intervene: () => Effect.void,
  approve: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  discardLeftovers: () => Effect.die("unused"),
  inspect: () => Effect.die("unused"),
  reconcile: () => Effect.die("unused"),
  drain: () => Effect.void,
  retry: () => Effect.die("unused"),
  runAgain: () => Effect.die("unused"),
  revoke: () => Effect.succeed([]),
  submit: (submission) =>
    Effect.sync(() => {
      submissions.push(submission.loop);
      return new Claimed({
        eventId: submission.event.id,
        runId: RunId.make(`run-${submissions.length}`),
      });
    }),
  transcript: () => Effect.die("unused"),
});

/** A new PollingTriggers, as one `usine up` process builds it, over a shared cursor store. */
const processLayer = (github: GitHubPolling["Service"], cursors: CursorStore["Service"]) =>
  PollingTriggers.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        noCycleBudgets,
        Layer.succeed(CursorStore)(cursors),
        itemProjectionWriterLayer,
        itemProjectionReaderLayer,
        repositoryLabelProjectionReaderLayer,
        repositoryLabelProjectionWriterLayer,
        inertGitHubLabelWriterLayer,
        inertLabelReconcilerLayer,
        claimingRuns,
        MarcbachmannCelLayer,
        ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer)),
        Layer.succeed(GitHubPolling, github),
        loopControlLayer(),
      ),
    ),
  );

const capturedLogs = () => {
  const lines: Array<{ readonly level: string; readonly text: string }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    lines.push({ level: logLevel, text: JSON.stringify(message) });
  });
  return {
    logger,
    errors: (pattern: RegExp) =>
      lines.filter(({ level, text }) => level === "Error" && pattern.test(text)).length,
  };
};

const FAILED = /Loop evaluation failed on an Item/u;

const storedFailingItems = (cursors: ReturnType<typeof memoryCursorStore>) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ failingItems: Schema.Array(Schema.Struct({ number: Schema.Number })) }),
  )(cursors.stored.get(`github-poll:${repository}`)).failingItems.map(({ number }) => number);

describe("Loop evaluation failures", () => {
  it.effect(
    "isolates a failing if: to its Loop and Item, advances the cursor, and reports it once",
    () =>
      Effect.gen(function* () {
        submissions.length = 0;
        const cursors = memoryCursorStore();
        const fetched: Array<number> = [];
        const logs = capturedLogs();
        const github: GitHubPolling["Service"] = {
          missingIssues: () => Effect.succeed([]),
          labels: () =>
            Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
          changes: changesOnce([
            new ChangedIssue({ number: 28, updatedAt }),
            new ChangedIssue({ number: 29, updatedAt }),
          ]),
          snapshot: (_repository, item) =>
            Effect.sync(() => {
              fetched.push(item.number);
              return new IssueSnapshot({
                payload: issuePayload(item.number, item.number === 28 ? null : "v1"),
                contentHash: ContentHash.make(String(item.number).repeat(32)),
              });
            }),
        };
        const instance = instanceWith([
          loop("milestone", 'item.milestone.title == "v1"', "Plan {{ item.number }}."),
          loop("ready", 'item.labels.nodes.exists(label, label.name == "ready")', "Do it."),
        ]);

        yield* Effect.gen(function* () {
          const polling = yield* PollingTriggers;
          const first = yield* polling.poll(instance);
          assert.deepStrictEqual(submissions.sort(), ["milestone", "ready", "ready"]);
          assert.strictEqual(first.failures.length, 1);
          assert.strictEqual(first.failures[0]?.errorTag, "ExpressionEvaluationError");
          assert.match(
            first.failures[0]?.message ?? "",
            /^Loop milestone: if: failed on issue #28: No such key: title/u,
          );
          const saved = Schema.decodeUnknownSync(Schema.Struct({ cursor: PollCursor }))(
            cursors.stored.get(`github-poll:${repository}`),
          );
          assert.deepStrictEqual(saved.cursor, advanced);
          assert.deepStrictEqual(storedFailingItems(cursors), [28]);

          const second = yield* polling.poll(instance);
          assert.deepStrictEqual(second.failures, first.failures);
          assert.deepStrictEqual(fetched.sort(), [28, 29]);
          assert.strictEqual(logs.errors(FAILED), 1);
        }).pipe(
          Effect.provide(processLayer(github, cursors.store)),
          Effect.provide(Logger.layer([logs.logger])),
        );
      }),
  );

  it.effect("logs a prompt failure on an open pull request once per content hash", () =>
    Effect.gen(function* () {
      submissions.length = 0;
      const cursors = memoryCursorStore();
      const logs = capturedLogs();
      let contentHash = "a";
      let fetches = 0;
      const github: GitHubPolling["Service"] = {
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: changesOnce([new ChangedPullRequest({ number: 12, updatedAt })]),
        snapshot: () =>
          Effect.sync(() => {
            fetches += 1;
            return new PullRequestSnapshot({
              payload: pullRequestPayload(12),
              contentHash: ContentHash.make(contentHash.repeat(64)),
            });
          }),
      };
      const instance = instanceWith([
        loop("review", 'item.state == "OPEN"', "Review {{ item.statusCheckRollup.state }}.", "pr"),
      ]);

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const first = yield* polling.poll(instance);
        assert.strictEqual(first.failures.length, 1);
        assert.match(
          first.failures[0]?.message ?? "",
          /^Loop review: prompt \{\{ item\.statusCheckRollup\.state \}\} failed on pull request #12: No such key: state/u,
        );
        // Open pull requests are fetched on every poll; the failure stays
        // reported without being logged again.
        const second = yield* polling.poll(instance);
        assert.deepStrictEqual(second.failures, first.failures);
        assert.strictEqual(fetches, 2);
        assert.strictEqual(logs.errors(FAILED), 1);

        contentHash = "b";
        yield* polling.poll(instance);
        assert.strictEqual(logs.errors(FAILED), 2);
        assert.deepStrictEqual(submissions, []);
      }).pipe(
        Effect.provide(processLayer(github, cursors.store)),
        Effect.provide(Logger.layer([logs.logger])),
      );
    }),
  );

  it.effect("retries a failing issue on the first poll of the next process", () =>
    Effect.gen(function* () {
      submissions.length = 0;
      const cursors = memoryCursorStore();
      const fetched: Array<number> = [];
      const github: GitHubPolling["Service"] = {
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: changesOnce([new ChangedIssue({ number: 28, updatedAt })]),
        snapshot: (_repository, item) =>
          Effect.sync(() => {
            fetched.push(item.number);
            return new IssueSnapshot({
              payload: issuePayload(item.number, null),
              contentHash: ContentHash.make("c".repeat(64)),
            });
          }),
      };
      const condition = 'item.labels.nodes.exists(label, label.name == "ready")';

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const broken = instanceWith([loop("plan", condition, "Plan {{ item.milestone.title }}.")]);
        const first = yield* polling.poll(broken);
        assert.strictEqual(first.failures.length, 1);
        assert.deepStrictEqual(storedFailingItems(cursors), [28]);
        // Within one process the Loop cannot change, so an unchanged Item is not fetched again.
        yield* polling.poll(broken);
        assert.deepStrictEqual(fetched, [28]);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));

      // The operator fixes the prompt and restarts; detection reports no change.
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const fixed = instanceWith([
          loop(
            "plan",
            condition,
            'Plan {{ item.milestone != null ? item.milestone.title : "no milestone" }}.',
          ),
        ]);
        const retried = yield* polling.poll(fixed);
        assert.deepStrictEqual(fetched, [28, 28]);
        assert.deepStrictEqual(retried.failures, []);
        assert.deepStrictEqual(submissions, ["plan"]);
        assert.deepStrictEqual(storedFailingItems(cursors), []);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));
    }),
  );

  it.effect("retries a failing issue on the first poll after a reload changes the instance", () =>
    Effect.gen(function* () {
      submissions.length = 0;
      const cursors = memoryCursorStore();
      const fetched: Array<number> = [];
      const github: GitHubPolling["Service"] = {
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: changesOnce([new ChangedIssue({ number: 28, updatedAt })]),
        snapshot: (_repository, item) =>
          Effect.sync(() => {
            fetched.push(item.number);
            return new IssueSnapshot({
              payload: issuePayload(item.number, null),
              contentHash: ContentHash.make("c".repeat(64)),
            });
          }),
      };
      const condition = 'item.labels.nodes.exists(label, label.name == "ready")';

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const broken = instanceWith([loop("plan", condition, "Plan {{ item.milestone.title }}.")]);
        yield* polling.poll(broken);
        yield* polling.poll(broken);
        assert.deepStrictEqual(fetched, [28]);

        // The operator fixes the prompt and reloads; detection reports no change.
        const fixed = instanceWith([
          loop(
            "plan",
            condition,
            'Plan {{ item.milestone != null ? item.milestone.title : "no milestone" }}.',
          ),
        ]);
        const retried = yield* polling.poll(fixed);
        assert.deepStrictEqual(fetched, [28, 28]);
        assert.deepStrictEqual(retried.failures, []);
        assert.deepStrictEqual(submissions, ["plan"]);
        assert.deepStrictEqual(storedFailingItems(cursors), []);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));
    }),
  );

  it.effect("drops a failing Item it can no longer fetch instead of stalling the repository", () =>
    Effect.gen(function* () {
      submissions.length = 0;
      const cursors = memoryCursorStore();
      let deleted = false;
      const github: GitHubPolling["Service"] = {
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: changesOnce([new ChangedIssue({ number: 28, updatedAt })]),
        snapshot: (_repository, item) =>
          deleted
            ? Effect.fail(
                new GitHubItemNotFoundError({
                  operation: "fetch-issue-snapshot",
                  item: item.number,
                  message: `GitHub has no issue ${item.number}`,
                }),
              )
            : Effect.succeed(
                new IssueSnapshot({
                  payload: issuePayload(item.number, null),
                  contentHash: ContentHash.make("d".repeat(64)),
                }),
              ),
      };
      const instance = instanceWith([
        loop("plan", 'item.state == "OPEN"', "Plan {{ item.milestone.title }}."),
      ]);

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        yield* polling.poll(instance);
        assert.deepStrictEqual(storedFailingItems(cursors), [28]);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));

      deleted = true;
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const cycle = yield* polling.poll(instance);
        assert.deepStrictEqual(cycle.failures, []);
        assert.deepStrictEqual(storedFailingItems(cursors), []);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));
    }),
  );

  it.effect("drops a failing Item GitHub no longer has on the first poll after a reload", () =>
    Effect.gen(function* () {
      submissions.length = 0;
      const cursors = memoryCursorStore();
      let deleted = false;
      const github: GitHubPolling["Service"] = {
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: changesOnce([new ChangedIssue({ number: 28, updatedAt })]),
        snapshot: (_repository, item) =>
          deleted
            ? Effect.fail(
                new GitHubItemNotFoundError({
                  operation: "fetch-issue-snapshot",
                  item: item.number,
                  message: `GitHub has no issue ${item.number}`,
                }),
              )
            : Effect.succeed(
                new IssueSnapshot({
                  payload: issuePayload(item.number, null),
                  contentHash: ContentHash.make("d".repeat(64)),
                }),
              ),
      };

      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        yield* polling.poll(
          instanceWith([loop("plan", 'item.state == "OPEN"', "Plan {{ item.milestone.title }}.")]),
        );
        assert.deepStrictEqual(storedFailingItems(cursors), [28]);

        deleted = true;
        const reloaded = instanceWith([
          loop("plan", 'item.state == "OPEN"', "Plan issue {{ item.milestone.title }}."),
        ]);
        const cycle = yield* polling.poll(reloaded);
        assert.deepStrictEqual(cycle.failures, []);
        assert.deepStrictEqual(storedFailingItems(cursors), []);
      }).pipe(Effect.provide(processLayer(github, cursors.store)));
    }),
  );
});
