import { InvalidGitHubResponseError } from "@usine/github/github-app";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { RepositoryName } from "@usine/core/repository";
import { GitHubApiError } from "@usine/github/github-app";
import {
  ChangedPullRequest,
  ContentHash,
  EntityTag,
  GitHubPolling,
  PollCursor,
  PullRequestPayload,
  PullRequestSnapshot,
  RepositoryChanges,
  RepositoryLabelCatalog,
  RepositoryNotModified,
} from "@usine/github/polling";
import { DateTime, Effect, Logger, Option, Schema, Layer } from "effect";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { baseBranches, memoryCursorStore, pollingTestLayer } from "./support/polling.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const repository = RepositoryName.make("basaltbytes/usine");
const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [],
    invalidAgents: [],
    loops: [],
    quarantinedLoops: [],
    warnings: [],
  });
});
const updatedAt = DateTime.makeUnsafe("2026-10-24T10:00:00Z");

interface RemotePullRequest {
  readonly baseRefName: string;
  mergeable: string;
  mergeStateStatus?: string;
  statusCheckRollup?: PullRequestPayload["statusCheckRollup"];
}

const payload = (
  number: number,
  {
    baseRefName,
    mergeable,
    mergeStateStatus = "CLEAN",
    statusCheckRollup = null,
  }: RemotePullRequest,
) =>
  Schema.decodeEffect(PullRequestPayload)({
    number,
    title: "Track base branch heads",
    body: "",
    url: `https://github.com/basaltbytes/usine/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    createdAt: "2026-10-24T09:00:00Z",
    updatedAt: "2026-10-24T10:00:00Z",
    mergedAt: null,
    author: null,
    baseRefName,
    headRefName: `feature-${number}`,
    headRefOid: "a".repeat(40),
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: null,
    mergeable,
    mergeStateStatus,
    statusCheckRollup,
    labels: { totalCount: 0, nodes: [] },
    reviewRequests: { totalCount: 0, nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    closingIssuesReferences: { totalCount: 0, nodes: [] },
  });

/**
 * Returns a repository whose change detection reports `pullRequests` on the first poll only, and a
 * `poll` that returns the GitHub requests one cycle sent.
 */
const fakeRepository = (
  pullRequests: ReadonlyMap<number, RemotePullRequest>,
  baseRefHead: GitHubPolling["Service"]["baseRefHead"],
) => {
  let detected = false;
  let changes = 0;
  const baseRefReads: Array<string> = [];
  const snapshots: Array<number> = [];
  const github: GitHubPolling["Service"] = {
    missingIssues: () => Effect.succeed([]),
    labels: () =>
      Effect.succeed(RepositoryLabelCatalog.make({ entityTag: Option.none(), labels: [] })),
    changes: (_repository, cursor) =>
      Effect.sync(() => {
        changes += 1;
        if (detected) return RepositoryNotModified.make({ cursor, nextPollAt: Option.none() });
        detected = true;
        return RepositoryChanges.make({
          cursor: PollCursor.make({
            entityTag: Option.some(EntityTag.make('W/"changes"')),
            watermark: Option.some(updatedAt),
          }),
          items: [...pullRequests.keys()].map((number) =>
            ChangedPullRequest.make({ number, updatedAt }),
          ),
          backlog: false,
          nextPollAt: Option.none(),
        });
      }),
    baseRefHead: (repository, baseRefName, known) => {
      const conditional = Option.isSome(Option.flatMap(known, ({ entityTag }) => entityTag));
      baseRefReads.push(conditional ? `${baseRefName} if-none-match` : baseRefName);
      return baseRefHead(repository, baseRefName, known);
    },
    snapshot: (_repository, item) =>
      Effect.gen(function* () {
        snapshots.push(item.number);
        return PullRequestSnapshot.make({
          contentHash: ContentHash.make("a".repeat(64)),
          payload: yield* payload(
            item.number,
            pullRequests.get(item.number) ?? assert.fail(`no pull request #${item.number}`),
          ),
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? InvalidGitHubResponseError.make({
                operation: "fetch-pull-request-snapshot",
                message: "Invalid snapshot fixture",
                detail: cause.message,
              })
            : cause,
        ),
      ),
  };
  const poll = Effect.gen(function* () {
    const fixtureInstance = yield* instance;
    const polling = yield* PollingTriggers;
    changes = 0;
    baseRefReads.length = 0;
    snapshots.length = 0;

    const cycle = yield* polling.poll(fixtureInstance);
    assert.deepStrictEqual(cycle.failures, []);
    return {
      changes,
      baseRefReads: [...baseRefReads].sort(),
      snapshots: [...snapshots].sort(),
    };
  });
  return { github, poll };
};

const testLayer = (
  github: GitHubPolling["Service"],
  cursors: ReturnType<typeof memoryCursorStore>,
) => pollingTestLayer(github, [], undefined, undefined, cursors.store);

describe("open pull request refresh", () => {
  it.effect(
    "sends only change detection and one conditional request per base branch when nothing changed",
    () => {
      const cursors = memoryCursorStore();
      const { github, poll } = fakeRepository(
        new Map([
          [28, { baseRefName: "main", mergeable: "MERGEABLE" }],
          [29, { baseRefName: "main", mergeable: "CONFLICTING" }],
          [30, { baseRefName: "release/1.x", mergeable: "MERGEABLE" }],
        ]),
        baseBranches().baseRefHead,
      );
      return Effect.gen(function* () {
        const pollResult = yield* poll;
        assert.deepStrictEqual(pollResult, {
          changes: 1,
          baseRefReads: [],
          snapshots: [28, 29, 30],
        });
        // The first read of a base branch can't show whether it moved since the fetch.
        const currentPollResult = yield* poll;
        assert.deepStrictEqual(currentPollResult, {
          changes: 1,
          baseRefReads: ["main", "release/1.x"],
          snapshots: [28, 29, 30],
        });
        const nextPollResult = yield* poll;
        assert.deepStrictEqual(nextPollResult, {
          changes: 1,
          baseRefReads: ["main if-none-match", "release/1.x if-none-match"],
          snapshots: [],
        });
      }).pipe(Effect.provide(testLayer(github, cursors)));
    },
  );

  it.effect(
    "fetches a pull request with UNKNOWN mergeability on every poll until it settles",
    () => {
      const cursors = memoryCursorStore();
      const pullRequest = { baseRefName: "main", mergeable: "UNKNOWN" };
      const { github, poll } = fakeRepository(
        new Map([[28, pullRequest]]),
        baseBranches().baseRefHead,
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, [28]);
        const pollResult = yield* poll;
        assert.deepStrictEqual(pollResult, {
          changes: 1,
          baseRefReads: ["main if-none-match"],
          snapshots: [28],
        });
        pullRequest.mergeable = "CONFLICTING";

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, []);
      }).pipe(Effect.provide(testLayer(github, cursors)));
    },
  );

  for (const [initial, settled] of [
    ["PENDING", "SUCCESS"],
    ["PENDING", "FAILURE"],
    ["PENDING", "ERROR"],
    ["EXPECTED", "SUCCESS"],
  ] as const) {
    it.effect(`refreshes a ${initial} check rollup on every poll until ${settled}`, () => {
      const cursors = memoryCursorStore();
      const pullRequest: RemotePullRequest = {
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: { state: initial },
      };
      const { github, poll } = fakeRepository(
        new Map([[28, pullRequest]]),
        baseBranches().baseRefHead,
      );
      return Effect.gen(function* () {
        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, [28]);
        const pollResult = yield* poll;
        assert.deepStrictEqual(pollResult, {
          changes: 1,
          baseRefReads: ["main if-none-match"],
          snapshots: [28],
        });
        pullRequest.statusCheckRollup = { state: settled };

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, []);
      }).pipe(Effect.provide(testLayer(github, cursors)));
    });
  }

  it.effect(
    "refreshes an absent rollup on a blocked pull request until checks appear and settle",
    () => {
      const cursors = memoryCursorStore();
      const pullRequest: RemotePullRequest = {
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: null,
      };
      const { github, poll } = fakeRepository(
        new Map([[28, pullRequest]]),
        baseBranches().baseRefHead,
      );
      return Effect.gen(function* () {
        yield* poll;
        yield* poll;

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, [28]);
        pullRequest.statusCheckRollup = { state: "PENDING" };

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, [28]);
        pullRequest.statusCheckRollup = { state: "SUCCESS" };
        pullRequest.mergeStateStatus = "CLEAN";

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, []);
      }).pipe(Effect.provide(testLayer(github, cursors)));
    },
  );

  it.effect(
    "refreshes a cursor without check state once, then retries only unsettled checks",
    () => {
      const cursors = memoryCursorStore();
      const pullRequest: RemotePullRequest = { baseRefName: "main", mergeable: "MERGEABLE" };
      const { github, poll } = fakeRepository(
        new Map([
          [28, pullRequest],
          [29, { baseRefName: "main", mergeable: "MERGEABLE" }],
        ]),
        baseBranches().baseRefHead,
      );
      const key = `github-poll:${repository}`;
      const LegacyOpenPullRequests = Schema.Array(
        Schema.Struct({
          number: Schema.Finite,
          updatedAt: Schema.String,
          baseRefName: Schema.String,
          mergeable: Schema.String,
        }),
      );
      return Effect.gen(function* () {
        yield* poll;
        yield* poll;

        assert.deepStrictEqual((yield* poll).snapshots, []);
        const { openPullRequests, ...rest } = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
          cursors.stored.get(key),
        );
        const decodedValue17 =
          yield* Schema.decodeUnknownEffect(LegacyOpenPullRequests)(openPullRequests);
        cursors.stored.set(key, {
          ...rest,
          openPullRequests: decodedValue17,
        });
        pullRequest.statusCheckRollup = { state: "PENDING" };
        const pollResult = yield* poll;
        assert.deepStrictEqual(pollResult, {
          changes: 1,
          baseRefReads: ["main if-none-match"],
          snapshots: [28, 29],
        });

        assert.deepStrictEqual((yield* poll).snapshots, [28]);
        pullRequest.statusCheckRollup = { state: "SUCCESS" };

        assert.deepStrictEqual((yield* poll).snapshots, [28]);

        assert.deepStrictEqual((yield* poll).snapshots, []);
      }).pipe(Effect.provide(testLayer(github, cursors)));
    },
  );

  it.effect("refreshes every open pull request after upgrading a cursor without base heads", () => {
    const cursors = memoryCursorStore();
    const { github, poll } = fakeRepository(
      new Map([
        [28, { baseRefName: "main", mergeable: "MERGEABLE" }],
        [29, { baseRefName: "main", mergeable: "CONFLICTING" }],
      ]),
      baseBranches().baseRefHead,
    );
    const key = `github-poll:${repository}`;
    // Decoding drops the fields that cursors written before base heads were recorded don't have.
    const LegacyOpenPullRequests = Schema.Array(
      Schema.Struct({ number: Schema.Finite, updatedAt: Schema.String }),
    );
    return Effect.gen(function* () {
      yield* poll;
      yield* poll;

      assert.deepStrictEqual((yield* poll).snapshots, []);

      const {
        baseRefHeads: _baseRefHeads,
        openPullRequests,
        ...rest
      } = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(cursors.stored.get(key));
      const decodedValue22 =
        yield* Schema.decodeUnknownEffect(LegacyOpenPullRequests)(openPullRequests);
      cursors.stored.set(key, {
        ...rest,
        openPullRequests: decodedValue22,
      });

      const pollResult = yield* poll;
      assert.deepStrictEqual(pollResult, { changes: 1, baseRefReads: [], snapshots: [28, 29] });
      const currentPollResult = yield* poll;
      assert.deepStrictEqual(currentPollResult, {
        changes: 1,
        baseRefReads: ["main"],
        snapshots: [28, 29],
      });

      assert.deepStrictEqual((yield* poll).snapshots, []);
    }).pipe(Effect.provide(testLayer(github, cursors)));
  });

  it.effect(
    "refreshes the pull requests of an unreadable base branch on every poll with one warning",
    () => {
      const cursors = memoryCursorStore();
      const readable = baseBranches();
      const warnings: Array<string> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(stringifyJson(message));
      });
      const { github, poll } = fakeRepository(
        new Map([
          [28, { baseRefName: "main", mergeable: "MERGEABLE" }],
          [29, { baseRefName: "main", mergeable: "MERGEABLE" }],
          [30, { baseRefName: "release/1.x", mergeable: "MERGEABLE" }],
        ]),
        (repository, baseRefName, known) =>
          baseRefName === "main"
            ? Effect.fail(
                GitHubApiError.make({
                  operation: "fetch-base-ref-head",
                  status: Option.some(502),
                  message: "GitHub returned HTTP status 502",
                }),
              )
            : readable.baseRefHead(repository, baseRefName, known),
      );
      return Effect.gen(function* () {
        yield* poll;

        assert.deepStrictEqual((yield* poll).snapshots, [28, 29, 30]);
        warnings.length = 0;
        const pollResult = yield* poll;
        assert.deepStrictEqual(pollResult, {
          changes: 1,
          baseRefReads: ["main", "release/1.x if-none-match"],
          snapshots: [28, 29],
        });
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0] ?? "", /Could not read the base branch head/u);
      }).pipe(
        Effect.provide(testLayer(github, cursors).pipe(Layer.provideMerge(Logger.layer([logger])))),
      );
    },
  );
});
