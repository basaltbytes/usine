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
import { DateTime, Effect, Logger, Option, Schema } from "effect";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { baseBranches, memoryCursorStore, pollingTestLayer } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [{ name: repository }] }),
  agents: [],
  invalidAgents: [],
  loops: [],
  quarantinedLoops: [],
  warnings: [],
});
const updatedAt = DateTime.makeUnsafe("2026-10-24T10:00:00Z");

interface RemotePullRequest {
  readonly baseRefName: string;
  mergeable: string;
}

const payload = (number: number, { baseRefName, mergeable }: RemotePullRequest) =>
  Schema.decodeUnknownSync(PullRequestPayload)({
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
    mergeStateStatus: "UNKNOWN",
    statusCheckRollup: null,
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
      Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
    changes: (_repository, cursor) =>
      Effect.sync(() => {
        changes += 1;
        if (detected) return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
        detected = true;
        return new RepositoryChanges({
          cursor: new PollCursor({
            entityTag: Option.some(EntityTag.make('W/"changes"')),
            watermark: Option.some(updatedAt),
          }),
          items: [...pullRequests.keys()].map(
            (number) => new ChangedPullRequest({ number, updatedAt }),
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
      Effect.sync(() => {
        snapshots.push(item.number);
        return new PullRequestSnapshot({
          contentHash: ContentHash.make("a".repeat(64)),
          payload: payload(
            item.number,
            pullRequests.get(item.number) ?? assert.fail(`no pull request #${item.number}`),
          ),
        });
      }),
  };
  const poll = Effect.gen(function* () {
    const polling = yield* PollingTriggers;
    changes = 0;
    baseRefReads.length = 0;
    snapshots.length = 0;
    const cycle = yield* polling.poll(instance);
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
        assert.deepStrictEqual(yield* poll, {
          changes: 1,
          baseRefReads: [],
          snapshots: [28, 29, 30],
        });
        // The first read of a base branch can't show whether it moved since the fetch.
        assert.deepStrictEqual(yield* poll, {
          changes: 1,
          baseRefReads: ["main", "release/1.x"],
          snapshots: [28, 29, 30],
        });
        assert.deepStrictEqual(yield* poll, {
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
        assert.deepStrictEqual(yield* poll, {
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
      Schema.Struct({ number: Schema.Number, updatedAt: Schema.String }),
    );
    return Effect.gen(function* () {
      yield* poll;
      yield* poll;
      assert.deepStrictEqual((yield* poll).snapshots, []);

      const {
        baseRefHeads: _baseRefHeads,
        openPullRequests,
        ...rest
      } = Schema.decodeUnknownSync(Schema.JsonObject)(cursors.stored.get(key));
      cursors.stored.set(key, {
        ...rest,
        openPullRequests: Schema.decodeUnknownSync(LegacyOpenPullRequests)(openPullRequests),
      });

      assert.deepStrictEqual(yield* poll, { changes: 1, baseRefReads: [], snapshots: [28, 29] });
      assert.deepStrictEqual(yield* poll, {
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
        if (logLevel === "Warn") warnings.push(JSON.stringify(message));
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
                new GitHubApiError({
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
        assert.deepStrictEqual(yield* poll, {
          changes: 1,
          baseRefReads: ["main", "release/1.x if-none-match"],
          snapshots: [28, 29],
        });
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0] ?? "", /Could not read the base branch head/u);
      }).pipe(Effect.provide(testLayer(github, cursors)), Effect.provide(Logger.layer([logger])));
    },
  );
});
