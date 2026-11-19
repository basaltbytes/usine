import { assert, describe, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/core/label";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import type { ProjectedItem } from "../src/board/items.ts";
import { ItemEntryCursor, itemPage, type ItemView } from "../src/operator/item.ts";
import { jsonBytes, PAGE_BYTES, pageOf } from "../src/operator/page.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const author = (login: string) => ({ login });

const stored = (payload: ItemProjection["payload"]) =>
  ItemProjection.make({
    itemKey: gitHubItemKey(repository, 7),
    repository,
    source: ItemProjectionSource.make("pr"),
    number: ItemNumber.make(7),
    contentHash: ItemContentHash.make("hash"),
    payload,
  });

const projected: ProjectedItem = {
  itemKey: gitHubItemKey(repository, 7),
  kind: "pr",
  number: ItemNumber.make(7),
  title: "Fix the retry path",
  url: "https://github.com/basaltbytes/usine/pull/7",
  state: "pr-open",
  linkedPullRequests: [],
  labels: [GitHubLabelName.make("ready-for-review")],
  conflicting: false,
};

/** Reads every page from the start and returns them with each entry's text joined. */
const readAll = (item: ItemProjection) => {
  const pages: Array<ItemView> = [];
  let cursor: ItemEntryCursor | null = ItemEntryCursor.make({ entry: 0, offset: 0 });
  while (cursor !== null) {
    const page: ItemView = itemPage(item, projected, cursor);
    pages.push(page);
    cursor = page.next;
  }
  const texts: Array<string> = [];
  for (const page of pages)
    for (const entry of page.entries) texts[entry.entry] = (texts[entry.entry] ?? "") + entry.text;
  return { pages, texts };
};

describe("item page", () => {
  it("pages long text without losing or repeating a character, and each page fits", () => {
    const body =
      `Quotes " and \\ backslashes\n\ttabs, \u0001 controls, and 🧪 emoji, 合成. `.repeat(1_500);
    const comments = Array.from({ length: 20 }, (_, index) => ({
      author: author(`reviewer-${index}`),
      body: `Comment ${index}: ${"Check the retry path again. ".repeat(index * 40)}`,
      createdAt: `2026-11-01T10:${String(index).padStart(2, "0")}:00Z`,
    }));
    const item = stored({ body, comments: { totalCount: 20, nodes: comments } });
    const { pages, texts } = readAll(item);
    assert.deepStrictEqual(texts, [body, ...comments.map(({ body }) => body)]);
    assert.isAbove(pages.length, 4);
    for (const page of pages) {
      assert.isAtMost(jsonBytes(page), PAGE_BYTES);
      for (const { text } of page.entries) {
        assert.notMatch(text, /^[\uDC00-\uDFFF]/u);
        assert.notMatch(text, /[\uD800-\uDBFF]$/u);
      }
    }
    // A page ends inside the body, and the next starts where it ended.
    const [first, second] = pages;
    assert.strictEqual(first?.next?.entry, 0);
    assert.strictEqual(second?.entries[0]?.offset, first?.next?.offset);
  });

  it("reads a payload slice stored without comments, and an empty page past the end", () => {
    const item = stored({ body: null });
    const page = itemPage(item, projected, ItemEntryCursor.make({ entry: 0, offset: 0 }));
    assert.deepStrictEqual(
      page.entries.map(({ kind, text, length }) => [kind, text, length]),
      [["body", "", 0]],
    );
    assert.isNull(page.author);
    assert.strictEqual(page.omitted, 0);
    const past = itemPage(item, projected, ItemEntryCursor.make({ entry: 5, offset: 0 }));
    assert.deepStrictEqual(past.entries, []);
    assert.isNull(past.next);
  });
});

describe("page of a list", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ index, text: "x".repeat(100) }));

  it("stops at the limit, then at the byte budget, and continues from the next offset", () => {
    assert.deepStrictEqual(pageOf(entries, 0, 3).nextOffset, 3);
    const size = jsonBytes(entries[0]);
    const budgeted = pageOf(entries, 2, 50, 3 * size + 5);
    assert.deepStrictEqual(
      budgeted.entries.map(({ index }) => index),
      [2, 3, 4],
    );
    assert.strictEqual(budgeted.nextOffset, 5);
    assert.strictEqual(budgeted.total, 10);
    assert.isNull(pageOf(entries, 8, 50).nextOffset);
    assert.deepStrictEqual(pageOf(entries, 12, 50).entries, []);
  });

  it("holds the first entry even when it alone passes the budget", () => {
    const page = pageOf(entries, 4, 50, 10);
    assert.deepStrictEqual(
      page.entries.map(({ index }) => index),
      [4],
    );
    assert.strictEqual(page.nextOffset, 5);
  });
});
