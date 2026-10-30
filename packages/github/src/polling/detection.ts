import { CommitSha } from "@usine/core/repository";
import { Effect, Option, Schema } from "effect";

/** GitHub's opaque HTTP validator for a conditional repository, label-catalog, or branch request. */
export const EntityTag = Schema.NonEmptyString.pipe(Schema.brand("GitHubEntityTag"));
export type EntityTag = typeof EntityTag.Type;

/** The name of the branch a pull request merges into, without the `refs/heads/` prefix. */
export const BaseRefName = Schema.NonEmptyString.pipe(Schema.brand("GitHubBaseRefName"));
export type BaseRefName = typeof BaseRefName.Type;

/** The commit at the tip of a base branch, with the ETag for the next conditional read. */
export class BaseRefHead extends Schema.Class<BaseRefHead>("@usine/github/BaseRefHead")({
  /** The branch name without `refs/heads/`; reuse this head only for that branch and repository. */
  baseRefName: BaseRefName,
  /** The commit at the branch tip when GitHub answered the read. */
  sha: CommitSha,
  /** The HTTP validator for the next read, or `None` when GitHub omitted it. */
  entityTag: Schema.OptionFromNullOr(EntityTag),
}) {}

/** A REST cursor used only for efficiency; losing it is safe because event deduplication is permanent (ADR 0007). */
export class PollCursor extends Schema.Class<PollCursor>("@usine/github/PollCursor")({
  /** The HTTP validator for the saved change-detection URL; `None` requests an unconditional read. */
  entityTag: Schema.OptionFromNullOr(EntityTag),
  /** The latest processed update time in UTC; the next request overlaps it by five seconds to avoid gaps. */
  watermark: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
}) {
  /** Starts an unconditional poll with no saved update watermark. */
  static readonly empty = new PollCursor({
    entityTag: Option.none(),
    watermark: Option.none(),
  });
}

/** An issue number and update time from repository change detection. */
export class ChangedIssue extends Schema.TaggedClass<ChangedIssue>("@usine/github/ChangedIssue")(
  "ChangedIssue",
  {
    /** The repository-local item number used to fetch its payload slice. */
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The UTC update time reported by the REST Issues endpoint, used to advance the polling watermark. */
    updatedAt: Schema.DateTimeUtc,
  },
) {}

/** A pull request number and update time from repository change detection. */
export class ChangedPullRequest extends Schema.TaggedClass<ChangedPullRequest>(
  "@usine/github/ChangedPullRequest",
)("ChangedPullRequest", {
  /** The repository-local item number used to fetch its payload slice. */
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The UTC update time reported by the REST Issues endpoint, used to advance the polling watermark. */
  updatedAt: Schema.DateTimeUtc,
}) {}

/** An issue or pull request whose payload must be fetched after change detection. */
export const ChangedItem = Schema.Union([ChangedIssue, ChangedPullRequest]);
export type ChangedItem = typeof ChangedItem.Type;

/** The result when GitHub confirms that the repository cursor is current. */
export class RepositoryNotModified extends Schema.TaggedClass<RepositoryNotModified>(
  "@usine/github/RepositoryNotModified",
)("RepositoryNotModified", {
  /** The cursor to save after processing this detection result. */
  cursor: PollCursor,
  /** The earliest UTC time for the next conditional poll, including the normal poll interval and request backoff; `None` adds no server delay. */
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
  /** The backoff from rate pressure or `Retry-After`, not including the normal polling interval. */
  backoffUntil: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {}

/** Changed items, the next cursor, and whether the page cap left items unfetched. */
export class RepositoryChanges extends Schema.TaggedClass<RepositoryChanges>(
  "@usine/github/RepositoryChanges",
)("RepositoryChanges", {
  /** The cursor to save after processing this detection result. */
  cursor: PollCursor,
  /** The detected issue and pull request updates; watermark overlap can return previously seen items. */
  items: Schema.Array(ChangedItem),
  /** Whether the page cap ended the walk early; the rest is fetched next cycle. */
  backlog: Schema.Boolean,
  /** The earliest UTC time for the next conditional poll, including the normal poll interval and request backoff; `None` adds no server delay. */
  nextPollAt: Schema.Option(Schema.DateTimeUtc),
  /** The backoff from rate pressure or `Retry-After`, not including the normal polling interval. */
  backoffUntil: Schema.Option(Schema.DateTimeUtc).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {}

/** The result of checking repository changes, including the earliest next poll time. */
export const ChangeDetection = Schema.Union([RepositoryNotModified, RepositoryChanges]);
export type ChangeDetection = typeof ChangeDetection.Type;
