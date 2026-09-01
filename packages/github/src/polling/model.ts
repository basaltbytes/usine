import { Option, Schema, SchemaGetter } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u, {
    message: "Expected a GitHub UTC timestamp",
  }),
);

/**
 * The payload keys that hold a `Timestamp` above. Bound to the slice schemas:
 * a field added to a slice with a `Timestamp` value MUST be listed here, or it
 * silently joins the content hash and re-fires every item once (ADR 0007 keeps
 * timestamps in the payload but out of the hash).
 */
export const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
  "closedAt",
  "createdAt",
  "mergedAt",
  "submittedAt",
  "updatedAt",
]);

export const EntityTag = Schema.NonEmptyString.pipe(Schema.brand("GitHubEntityTag"));
export type EntityTag = typeof EntityTag.Type;

export const RepositoryLabelName = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubRepositoryLabelName"),
);
export type RepositoryLabelName = typeof RepositoryLabelName.Type;

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
  /** True when the page cap ended the walk early; the rest arrives next cycle. */
  backlog: Schema.Boolean,
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

export const ChangeDetection = Schema.Union([RepositoryNotModified, RepositoryChanges]);
export type ChangeDetection = typeof ChangeDetection.Type;

/**
 * GitHub declares most GraphQL connections nullable. A null connection and an
 * empty one carry the same information, so the boundary normalizes null to
 * empty — the domain type (and the CEL environment typed on it) stays
 * non-null, and both shapes hash identically.
 */
const orEmpty = <A>(schema: Schema.Codec<A, A, never, never>, empty: A) =>
  Schema.NullOr(schema).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transform((value: A | null) => value ?? empty),
      encode: SchemaGetter.transform((value: A) => value),
    }),
  );

const emptyConnection = { totalCount: 0, nodes: [] } as const;

const Actor = Schema.Struct({ login: Schema.NonEmptyString });
const NullableActor = Schema.NullOr(Actor);
const Label = Schema.Struct({ name: Schema.NonEmptyString });
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
  labels: orEmpty(Labels, emptyConnection),
  assignees: Schema.Struct({ totalCount: NonNegativeInt, nodes: Schema.Array(Actor) }),
  comments: IssueComments,
  closedByPullRequestsReferences: orEmpty(
    Schema.Struct({
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
    emptyConnection,
  ),
});
export type IssuePayload = typeof IssuePayload.Type;

/** Null when the reviewer is a deleted user or a mannequin — real content, kept. */
const RequestedReviewer = Schema.NullOr(
  Schema.Struct({ login: Schema.optionalKey(Schema.NonEmptyString) }),
);
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
  labels: orEmpty(Labels, emptyConnection),
  reviewRequests: orEmpty(
    Schema.Struct({
      totalCount: NonNegativeInt,
      nodes: Schema.Array(Schema.Struct({ requestedReviewer: RequestedReviewer })),
    }),
    emptyConnection,
  ),
  reviews: orEmpty(
    Schema.Struct({ totalCount: NonNegativeInt, nodes: Schema.Array(Review) }),
    emptyConnection,
  ),
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
  closingIssuesReferences: orEmpty(
    Schema.Struct({
      totalCount: NonNegativeInt,
      nodes: Schema.Array(Schema.Struct({ number: PositiveInt, state: Schema.String })),
    }),
    emptyConnection,
  ),
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
