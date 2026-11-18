import { LaneItemState } from "@usine/config/board";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { GitHubLabelName } from "@usine/core/label";
import { RepositoryName } from "@usine/core/repository";
import type { ItemProjection } from "@usine/engine/item-projection";
import { type Brand, Option, Schema } from "effect";
import type { ProjectedItem } from "../board/items.ts";
import { fillText, jsonBytes } from "./page.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The kind of an entry of an Item: its body, a comment, a review, or a review comment. */
export const ItemEntryKind = Schema.Literals(["body", "comment", "review", "review-comment"]);
/** The kind of an entry of an item: its body, a comment, a review, or a review comment. */
export type ItemEntryKind = typeof ItemEntryKind.Type;

/** A position in an Item's entries: an entry index and an offset in that entry's text. */
export class ItemEntryCursor extends Schema.Class<
  ItemEntryCursor,
  Brand.Brand<"@usine/orchestrator/operator/item/ItemEntryCursor">
>("@usine/orchestrator/ItemEntryCursor")({
  /** The index of the entry; the body is entry 0. */
  entry: Count,
  /** The position in the entry's text, in UTF-16 code units. */
  offset: Count,
}) {}

/** The text of one entry of an Item, or the part of it that fits a page. */
export class ItemEntryView extends Schema.Class<
  ItemEntryView,
  Brand.Brand<"@usine/orchestrator/operator/item/ItemEntryView">
>("@usine/orchestrator/ItemEntryView")({
  /** The index of the entry; the body is entry 0. */
  entry: Count,
  /** Whether the entry is the body, a comment, a review, or a review comment. */
  kind: ItemEntryKind,
  /** The author's GitHub login, or null for a deleted account. */
  author: Schema.NullOr(Schema.String),
  /** When GitHub recorded the entry, as an ISO 8601 timestamp, or null for a review comment. */
  at: Schema.NullOr(Schema.String),
  /** The state of a review, such as `APPROVED`. */
  state: Schema.optionalKey(Schema.String),
  /** The file that a review comment is on. */
  path: Schema.optionalKey(Schema.String),
  /** The entry's text from `offset`. */
  text: Schema.String,
  /** The position of `text` in the entry's text, in UTF-16 code units. */
  offset: Count,
  /** The length of the entry's text, in UTF-16 code units. */
  length: Count,
}) {}

/**
 * An Item as polling last stored it, with a page of its entries: the body, then comments and
 * reviews by time, then review comments by thread.
 */
export class ItemView extends Schema.Class<
  ItemView,
  Brand.Brand<"@usine/orchestrator/operator/item/ItemView">
>("@usine/orchestrator/ItemView")({
  /** The stored item identity, including its stream and repository. */
  itemKey: ItemKey,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** Whether the item is an issue or pull request. */
  kind: Schema.Literals(["issue", "pr"]),
  /** The GitHub item number within its repository. */
  number: ItemNumber,
  /** The last polled GitHub title. */
  title: Schema.String,
  /** The GitHub URL for the item. */
  url: Schema.NonEmptyString,
  /** The last polled issue or pull request state used for lane placement. */
  state: LaneItemState,
  /** The last polled labels. */
  labels: Schema.Array(GitHubLabelName),
  /** The author's GitHub login, or null for a deleted account. */
  author: Schema.NullOr(Schema.String),
  /** The entries of this page, in order. */
  entries: Schema.Array(ItemEntryView),
  /** The number of stored entries. */
  entriesTotal: Count,
  /**
   * The comments, reviews, and review comments on GitHub that polling doesn't store: it keeps the
   * latest 20 comments and reviews, and the first 10 comments of the first 50 review threads.
   */
  omitted: Count,
  /** Where the next page starts, or null after the last entry. */
  next: Schema.NullOr(ItemEntryCursor),
}) {}

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const Connection = <S extends Schema.Top>(node: S) =>
  Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ totalCount: Count, nodes: Schema.Array(node) })),
  );

// The fields read here exist in every stored payload slice, old or new, so the read stays lenient.
const ItemText = Schema.Struct({
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  author: Schema.optionalKey(Author),
  createdAt: Schema.optionalKey(Schema.String),
  comments: Connection(
    Schema.Struct({ author: Author, body: Schema.String, createdAt: Schema.String }),
  ),
  reviews: Connection(
    Schema.Struct({
      author: Author,
      state: Schema.String,
      body: Schema.String,
      submittedAt: Schema.NullOr(Schema.String),
    }),
  ),
  reviewThreads: Connection(
    Schema.Struct({
      path: Schema.String,
      comments: Schema.Struct({
        totalCount: Count,
        nodes: Schema.Array(Schema.Struct({ author: Author, body: Schema.String })),
      }),
    }),
  ),
});
type ItemText = typeof ItemText.Type;
const decodeItemText = Schema.decodeUnknownOption(ItemText);

interface Entry {
  readonly kind: ItemEntryKind;
  readonly author: string | null;
  readonly at: string | null;
  readonly state?: string;
  readonly path?: string;
  readonly text: string;
}

const login = (author: typeof Author.Type | undefined) => author?.login ?? null;

/** Returns the entries of `text` in reading order, and how many GitHub has that it leaves out. */
const entriesOf = (text: ItemText) => {
  const comments = text.comments ?? { totalCount: 0, nodes: [] };
  const reviews = text.reviews ?? { totalCount: 0, nodes: [] };
  const threads = text.reviewThreads ?? { totalCount: 0, nodes: [] };
  const dated: ReadonlyArray<Entry> = [
    ...comments.nodes.map((comment): Entry => ({
      kind: "comment",
      author: login(comment.author),
      at: comment.createdAt,
      text: comment.body,
    })),
    ...reviews.nodes.map((review): Entry => ({
      kind: "review",
      author: login(review.author),
      at: review.submittedAt,
      state: review.state,
      text: review.body,
    })),
  ];
  const entries: ReadonlyArray<Entry> = [
    {
      kind: "body",
      author: login(text.author),
      at: text.createdAt ?? null,
      text: text.body ?? "",
    },
    // A review without a submission time is pending, so it goes last.
    ...[...dated].sort((left, right) =>
      left.at === null || right.at === null
        ? Number(left.at === null) - Number(right.at === null)
        : left.at.localeCompare(right.at),
    ),
    ...threads.nodes.flatMap(({ path, comments }) =>
      comments.nodes.map((comment): Entry => ({
        kind: "review-comment",
        author: login(comment.author),
        at: null,
        path,
        text: comment.body,
      })),
    ),
  ];
  const omitted =
    comments.totalCount -
    comments.nodes.length +
    reviews.totalCount -
    reviews.nodes.length +
    threads.totalCount -
    threads.nodes.length +
    threads.nodes.reduce(
      (count, { comments }) => count + comments.totalCount - comments.nodes.length,
      0,
    );
  return { entries, omitted: Math.max(0, omitted) };
};

/**
 * Returns the stored Item as a view with the page of its entries from `cursor`. A page holds as
 * many whole or partial entries as fit `PAGE_BYTES` of JSON; an entry that doesn't fit is cut, and
 * `next` points into it.
 */
export const itemPage = (
  stored: ItemProjection,
  projected: ProjectedItem,
  cursor: ItemEntryCursor,
): ItemView => {
  const text = decodeItemText(stored.payload);
  const { entries, omitted } = Option.match(text, {
    onNone: () => ({ entries: [], omitted: 0 }),
    onSome: entriesOf,
  });
  const view = (page: ReadonlyArray<ItemEntryView>, next: ItemEntryCursor | null) =>
    ItemView.make({
      itemKey: projected.itemKey,
      repository: stored.repository,
      kind: projected.kind,
      number: projected.number,
      title: projected.title,
      url: projected.url,
      state: projected.state,
      labels: projected.labels,
      author: Option.match(text, { onNone: () => null, onSome: ({ author }) => login(author) }),
      entries: page,
      entriesTotal: entries.length,
      omitted,
      next,
    });
  const widest = ItemEntryCursor.make({
    entry: entries.length,
    offset: Math.max(0, ...entries.map(({ text }) => text.length)),
  });
  const filled = fillText(
    entries.slice(cursor.entry).map((entry, index) => ({
      text: entry.text,
      view: (part: string, offset: number) =>
        ItemEntryView.make({
          entry: cursor.entry + index,
          ...entry,
          text: part,
          offset,
          length: entry.text.length,
        }),
    })),
    cursor.offset,
    jsonBytes(view([], widest)),
    false,
  );
  return view(
    filled.views,
    filled.next === null
      ? null
      : ItemEntryCursor.make({
          entry: cursor.entry + filled.next.index,
          offset: filled.next.offset,
        }),
  );
};
