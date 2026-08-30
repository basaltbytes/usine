import { Repository } from "@usine/core";
import { Context, Effect, Option, Schema } from "effect";
import type { GitHubAppError } from "../model.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u, {
    message: "Expected a GitHub UTC timestamp",
  }),
);

export const EntityTag = Schema.NonEmptyString.pipe(Schema.brand("GitHubEntityTag"));
export type EntityTag = typeof EntityTag.Type;

/** Efficiency-only REST cursor. Losing it is safe because Event dedup is permanent. */
export class PollCursor extends Schema.Class<PollCursor>("@usine/github/PollCursor")({
  entityTag: Schema.OptionFromNullOr(EntityTag),
  watermark: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {
  static readonly empty = new PollCursor({
    entityTag: Option.none(),
    watermark: Option.none(),
  });
}

export class ChangedIssue extends Schema.TaggedClass<ChangedIssue>("@usine/github/ChangedIssue")(
  "ChangedIssue",
  {
    number: PositiveInt,
    updatedAt: Schema.DateTimeUtc,
  },
) {}

export class ChangedPullRequest extends Schema.TaggedClass<ChangedPullRequest>(
  "@usine/github/ChangedPullRequest",
)("ChangedPullRequest", {
  number: PositiveInt,
  updatedAt: Schema.DateTimeUtc,
}) {}

export const ChangedItem = Schema.Union([ChangedIssue, ChangedPullRequest]);
export type ChangedItem = typeof ChangedItem.Type;

export class RepositoryNotModified extends Schema.TaggedClass<RepositoryNotModified>(
  "@usine/github/RepositoryNotModified",
)("RepositoryNotModified", {
  cursor: PollCursor,
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

export class RepositoryChanges extends Schema.TaggedClass<RepositoryChanges>(
  "@usine/github/RepositoryChanges",
)("RepositoryChanges", {
  cursor: PollCursor,
  items: Schema.Array(ChangedItem),
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

export const ChangeDetection = Schema.Union([RepositoryNotModified, RepositoryChanges]);
export type ChangeDetection = typeof ChangeDetection.Type;

const Actor = Schema.Struct({ login: Schema.NonEmptyString });
const NullableActor = Schema.NullOr(Actor);
const Label = Schema.Struct({ name: Schema.String });
const Labels = Schema.Struct({ totalCount: NonNegativeInt, nodes: Schema.Array(Label) });
const IssueComment = Schema.Struct({
  author: NullableActor,
  body: Schema.String,
  createdAt: Timestamp,
});
const IssueComments = Schema.Struct({
  totalCount: NonNegativeInt,
  nodes: Schema.Array(IssueComment),
});

/** Exact v1 issue payload slice recorded by issue #11. */
export const IssuePayload = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  body: Schema.String,
  url: Schema.NonEmptyString,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  closedAt: Schema.NullOr(Timestamp),
  author: NullableActor,
  issueType: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  labels: Labels,
  assignees: Schema.Struct({ totalCount: NonNegativeInt, nodes: Schema.Array(Actor) }),
  comments: IssueComments,
  closedByPullRequestsReferences: Schema.Struct({
    totalCount: NonNegativeInt,
    nodes: Schema.Array(
      Schema.Struct({
        number: PositiveInt,
        state: Schema.String,
        isDraft: Schema.Boolean,
        url: Schema.NonEmptyString,
      }),
    ),
  }),
});
export type IssuePayload = typeof IssuePayload.Type;

const RequestedReviewer = Schema.Struct({ login: Schema.optionalKey(Schema.NonEmptyString) });
const Review = Schema.Struct({
  author: NullableActor,
  state: Schema.String,
  body: Schema.String,
  submittedAt: Schema.NullOr(Timestamp),
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.NonEmptyString })),
});
const ReviewThreadComment = Schema.Struct({ author: NullableActor, body: Schema.String });

/** Exact v1 pull-request payload slice recorded by issue #11. */
export const PullRequestPayload = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  body: Schema.String,
  url: Schema.NonEmptyString,
  state: Schema.String,
  isDraft: Schema.Boolean,
  merged: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  mergedAt: Schema.NullOr(Timestamp),
  author: NullableActor,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.NonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  reviewDecision: Schema.NullOr(Schema.String),
  statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
  labels: Labels,
  reviewRequests: Schema.Struct({
    totalCount: NonNegativeInt,
    nodes: Schema.Array(Schema.Struct({ requestedReviewer: RequestedReviewer })),
  }),
  reviews: Schema.Struct({ totalCount: NonNegativeInt, nodes: Schema.Array(Review) }),
  reviewThreads: Schema.Struct({
    totalCount: NonNegativeInt,
    nodes: Schema.Array(
      Schema.Struct({
        isResolved: Schema.Boolean,
        isOutdated: Schema.Boolean,
        path: Schema.String,
        comments: Schema.Struct({
          totalCount: NonNegativeInt,
          nodes: Schema.Array(ReviewThreadComment),
        }),
      }),
    ),
  }),
  comments: IssueComments,
  closingIssuesReferences: Schema.Struct({
    totalCount: NonNegativeInt,
    nodes: Schema.Array(Schema.Struct({ number: PositiveInt, state: Schema.String })),
  }),
});
export type PullRequestPayload = typeof PullRequestPayload.Type;

export const ContentHash = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: "Expected a SHA-256 content hash" }),
).pipe(Schema.brand("GitHubContentHash"));
export type ContentHash = typeof ContentHash.Type;

export class IssueSnapshot extends Schema.TaggedClass<IssueSnapshot>("@usine/github/IssueSnapshot")(
  "IssueSnapshot",
  {
    payload: IssuePayload,
    contentHash: ContentHash,
  },
) {}

export class PullRequestSnapshot extends Schema.TaggedClass<PullRequestSnapshot>(
  "@usine/github/PullRequestSnapshot",
)("PullRequestSnapshot", {
  payload: PullRequestPayload,
  contentHash: ContentHash,
}) {}

export const PayloadSnapshot = Schema.Union([IssueSnapshot, PullRequestSnapshot]);
export type PayloadSnapshot = typeof PayloadSnapshot.Type;

export class PayloadHashError extends Schema.TaggedError<PayloadHashError>(
  "@usine/github/PayloadHashError",
)("PayloadHashError", {
  message: Schema.NonEmptyString,
  cause: Schema.Defect(),
}) {}

/** GitHub change detection and snapshot fetching behind one external seam. */
export class GitHubPolling extends Context.Service<
  GitHubPolling,
  {
    readonly changes: (
      repository: Repository.Name,
      cursor: PollCursor,
    ) => Effect.Effect<ChangeDetection, GitHubAppError>;
    readonly snapshot: (
      repository: Repository.Name,
      item: ChangedItem,
    ) => Effect.Effect<PayloadSnapshot, GitHubAppError | PayloadHashError>;
  }
>()("@usine/github/GitHubPolling") {}
