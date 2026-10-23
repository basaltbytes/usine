import { Effect, Option, Schema } from "effect";

/** GitHub's opaque HTTP validator for a conditional repository or label-catalog request. */
export const EntityTag = Schema.NonEmptyString.pipe(Schema.brand("GitHubEntityTag"));
export type EntityTag = typeof EntityTag.Type;

/** A REST cursor used only for efficiency; losing it is safe because Event deduplication is permanent (ADR 0007). */
export class PollCursor extends Schema.Class<PollCursor>("@usine/github/PollCursor")({
  entityTag: Schema.OptionFromNullOr(EntityTag),
  watermark: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {
  static readonly empty = new PollCursor({
    entityTag: Option.none(),
    watermark: Option.none(),
  });
}

/** An issue number and update time from repository change detection. */
export class ChangedIssue extends Schema.TaggedClass<ChangedIssue>("@usine/github/ChangedIssue")(
  "ChangedIssue",
  {
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    updatedAt: Schema.DateTimeUtc,
  },
) {}

/** A pull request number and update time from repository change detection. */
export class ChangedPullRequest extends Schema.TaggedClass<ChangedPullRequest>(
  "@usine/github/ChangedPullRequest",
)("ChangedPullRequest", {
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: Schema.DateTimeUtc,
}) {}

/** An issue or pull request whose payload must be fetched after change detection. */
export const ChangedItem = Schema.Union([ChangedIssue, ChangedPullRequest]);
export type ChangedItem = typeof ChangedItem.Type;

/** The result when GitHub confirms that the repository cursor is current. */
export class RepositoryNotModified extends Schema.TaggedClass<RepositoryNotModified>(
  "@usine/github/RepositoryNotModified",
)("RepositoryNotModified", {
  cursor: PollCursor,
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
  /** The backoff from rate pressure or `Retry-After`, not including the normal polling interval. */
  backoffUntil: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {}

/** Changed Items, the next cursor, and whether the page cap left Items unfetched. */
export class RepositoryChanges extends Schema.TaggedClass<RepositoryChanges>(
  "@usine/github/RepositoryChanges",
)("RepositoryChanges", {
  cursor: PollCursor,
  items: Schema.Array(ChangedItem),
  /** Whether the page cap ended the walk early; the rest is fetched next cycle. */
  backlog: Schema.Boolean,
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
  /** The backoff from rate pressure or `Retry-After`, not including the normal polling interval. */
  backoffUntil: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {}

/** The result of checking repository changes, including the earliest next poll time. */
export const ChangeDetection = Schema.Union([RepositoryNotModified, RepositoryChanges]);
export type ChangeDetection = typeof ChangeDetection.Type;
