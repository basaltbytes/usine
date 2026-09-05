import { ItemKey, ItemNumber } from "@usine/core/item";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import { Option, Schema } from "effect";
import { BoardItemLink, BoardTaskView } from "../operator/board.ts";
import type { RunView } from "../operator/run.ts";
import type { ProjectedItem } from "./items.ts";

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString);
const decodeNumber = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(ItemNumber)),
);

// Only explicit PR URLs in this Project can join Items. Number-only references
// on PR payloads can point to another repository, so they are not evidence here.
const pullRequestNumber = (repository: RepositoryName, value: string): Option.Option<ItemNumber> =>
  Option.flatMap(decodeUrl(value), (url) => {
    const prefix = `/${canonicalRepositoryName(repository)}/pull/`;
    const path = url.pathname.toLowerCase();
    return url.protocol === "https:" && url.host === "github.com" && path.startsWith(prefix)
      ? decodeNumber(path.slice(prefix.length))
      : Option.none();
  });

const itemLink = (item: ProjectedItem) =>
  new BoardItemLink({
    itemKey: item.itemKey,
    kind: item.kind,
    number: item.number,
    title: item.title,
    url: item.url,
  });

const newestFirst = (left: RunView, right: RunView) =>
  right.openedAt.localeCompare(left.openedAt) || right.id.localeCompare(left.id);

/** Joins explicit issue/PR relationships into Task cards without creating stored Task identities (ADR 0024). */
export const taskCards = (
  repository: RepositoryName,
  items: ReadonlyArray<ProjectedItem>,
  runs: ReadonlyArray<RunView>,
  cycleBlockedItems: ReadonlyArray<ItemKey>,
): ReadonlyArray<BoardTaskView> => {
  const byKey = new Map(items.map((item) => [item.itemKey, item]));
  const pullRequests = new Map(
    items.filter(({ kind }) => kind === "pr").map((item) => [item.number, item]),
  );
  const edges = new Map(items.map(({ itemKey }) => [itemKey, new Set<ItemKey>()]));
  const connect = (issue: ProjectedItem, url: string) => {
    const number = pullRequestNumber(repository, url);
    const pr = Option.isSome(number) ? pullRequests.get(number.value) : undefined;
    if (pr === undefined) return;
    edges.get(issue.itemKey)?.add(pr.itemKey);
    edges.get(pr.itemKey)?.add(issue.itemKey);
  };
  for (const item of items) {
    if (item.kind === "issue") for (const url of item.linkedPullRequests) connect(item, url);
  }
  const runsByItem = new Map<ItemKey, Array<RunView>>();
  for (const run of runs) {
    const grouped = runsByItem.get(run.itemKey) ?? [];
    grouped.push(run);
    runsByItem.set(run.itemKey, grouped);
    const item = byKey.get(run.itemKey);
    if (item?.kind === "issue" && run.pullRequestUrl !== null) connect(item, run.pullRequestUrl);
  }

  const visited = new Set<ItemKey>();
  const cards: Array<BoardTaskView> = [];
  for (const seed of items) {
    if (visited.has(seed.itemKey)) continue;
    visited.add(seed.itemKey);
    const members: [ProjectedItem, ...ProjectedItem[]] = [seed];
    for (const member of members) {
      for (const linked of edges.get(member.itemKey) ?? []) {
        const item = byKey.get(linked);
        if (item === undefined || visited.has(linked)) continue;
        visited.add(linked);
        members.push(item);
      }
    }
    const ordered = [...members].sort(
      (a, b) => (a.kind === b.kind ? 0 : a.kind === "issue" ? -1 : 1) || a.number - b.number,
    );
    const title = ordered[0]?.title ?? seed.title;
    const history = members
      .flatMap(({ itemKey }) => runsByItem.get(itemKey) ?? [])
      .sort(newestFirst);
    // An open Run controls the lane. Between stages, an open PR takes over from
    // its issue; merged/closed PRs then determine the completed lane.
    const active = history.find((run) => run.canCancel);
    const prs = members
      .filter(({ kind }) => kind === "pr")
      .sort(
        (a, b) =>
          Number(b.state === "pr-open") - Number(a.state === "pr-open") || b.number - a.number,
      );
    const current =
      (active === undefined ? undefined : byKey.get(active.itemKey)) ??
      prs[0] ??
      ordered[0] ??
      seed;
    const preferred =
      history.find((run) => run.canApprove || run.canRetry) ?? active ?? history[0] ?? null;
    cards.push(
      new BoardTaskView({
        ...itemLink(current),
        title,
        state: current.state,
        labels: current.labels,
        items: ordered.map(itemLink),
        runs: history.reverse(),
        run: preferred,
        needsYou:
          history.some((run) => run.canApprove || run.canRetry) ||
          members.some(({ itemKey }) => cycleBlockedItems.includes(itemKey)),
      }),
    );
  }
  return cards;
};
