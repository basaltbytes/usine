import { Option, Schema, SchemaGetter } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u, {
    message: "Expected a GitHub UTC timestamp",
  }),
);

export const EntityTag = Schema.NonEmptyString.pipe(Schema.brand("GitHubEntityTag"));
export type EntityTag = typeof EntityTag.Type;

export const RepositoryLabelName = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubRepositoryLabelName"),
);
export type RepositoryLabelName = typeof RepositoryLabelName.Type;

/** GitHub stores label colors as six hex digits without the leading hash. */
export const RepositoryLabelColor = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{6}$/u, { message: "Expected a six-digit hex label color" }),
).pipe(Schema.brand("GitHubRepositoryLabelColor"));
export type RepositoryLabelColor = typeof RepositoryLabelColor.Type;

/** One repository label as GitHub defines it. The name routes lanes, and color and description are presentation only. */
export class RepositoryLabel extends Schema.Class<RepositoryLabel>("@usine/github/RepositoryLabel")(
  {
    name: RepositoryLabelName,
    color: RepositoryLabelColor,
    description: Schema.OptionFromNullOr(Schema.String),
  },
) {}

const uniqueLabelNames = Schema.makeFilter<ReadonlyArray<RepositoryLabel>>(
  (labels) => new Set(labels.map(({ name }) => name)).size === labels.length,
  { message: "Expected unique label names" },
);

/** A complete label catalog with the ETag of its canonical REST URL. */
export class RepositoryLabelCatalog extends Schema.Class<RepositoryLabelCatalog>(
  "@usine/github/RepositoryLabelCatalog",
)({
  entityTag: Schema.OptionFromNullOr(EntityTag),
  labels: Schema.Array(RepositoryLabel).check(uniqueLabelNames),
}) {}

/** GitHub confirmed the catalog named by its ETag has not changed. */
export class RepositoryLabelsNotModified extends Schema.TaggedClass<RepositoryLabelsNotModified>(
  "@usine/github/RepositoryLabelsNotModified",
)("RepositoryLabelsNotModified", {}) {}

export const RepositoryLabelDetection = Schema.Union([
  RepositoryLabelCatalog,
  RepositoryLabelsNotModified,
]);
export type RepositoryLabelDetection = typeof RepositoryLabelDetection.Type;

/** REST cursor for efficiency only. Losing it is safe because Event dedup is permanent (ADR 0007). */
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
  /** True when the page cap ended the walk early. The rest arrives next cycle. */
  backlog: Schema.Boolean,
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
}) {}

export const ChangeDetection = Schema.Union([RepositoryNotModified, RepositoryChanges]);
export type ChangeDetection = typeof ChangeDetection.Type;

/**
 * GitHub declares most GraphQL connections nullable, and a null connection means
 * the same as an empty one. Decoding null to empty keeps the payload type
 * non-null and hashes both shapes identically.
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

/** The issue payload slice that `if:` expressions and prompt interpolation range over. */
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

/** Null when the reviewer is a deleted user or a mannequin. That null is real content and stays in the payload. */
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

/** The pull-request payload slice that `if:` expressions and prompt interpolation range over. */
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

/** Identifies an Item's payload content for Event deduplication; timestamp-only changes keep the same hash. */
export const ContentHash = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/u, { message: "Expected a SHA-256 content hash" }),
).pipe(Schema.brand("GitHubContentHash"));
export type ContentHash = typeof ContentHash.Type;

/** An issue's observed payload and the content identity used to decide whether it represents new work. */
export class IssueSnapshot extends Schema.TaggedClass<IssueSnapshot>("@usine/github/IssueSnapshot")(
  "IssueSnapshot",
  {
    payload: IssuePayload,
    contentHash: ContentHash,
  },
) {}

/** A pull request's observed payload and the content identity used to decide whether it represents new work. */
export class PullRequestSnapshot extends Schema.TaggedClass<PullRequestSnapshot>(
  "@usine/github/PullRequestSnapshot",
)("PullRequestSnapshot", {
  payload: PullRequestPayload,
  contentHash: ContentHash,
}) {}

/** The fetched Item state shared by selection, prompt rendering, and Event deduplication. */
export const PayloadSnapshot = Schema.Union([IssueSnapshot, PullRequestSnapshot]);
export type PayloadSnapshot = typeof PayloadSnapshot.Type;
