import { isSettledItemState } from "@usine/config/board";
import type { ItemKey } from "@usine/core/item";
import type { LoopName } from "@usine/core/loop";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { Array as EffectArray, Option, Order, Schema } from "effect";
import { BoardItemLink, BoardPullRequestView, BoardTaskView } from "../operator/board.ts";
import type { RunView } from "../operator/run.ts";
import { type RunUsageView, taskUsage } from "../operator/usage.ts";
import { type ProjectedItem, runNeedsAttention } from "./items.ts";

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString);

// Each node links directly to its Runs and to the other known Items, so traversal needs no second
// key lookup.
interface TaskItem {
  readonly item: ProjectedItem;
  readonly runs: ReadonlyArray<RunView>;
  readonly related: Set<TaskItem>;
}

/** A Task card and the running Run that sets its lane. */
export interface TaskCard {
  readonly view: BoardTaskView;
  /** The Task's newest open Run once an Attempt has started, on the card's current Item. */
  readonly running: RunView | undefined;
}

const itemLink = (item: ProjectedItem) =>
  new BoardItemLink({
    itemKey: item.itemKey,
    kind: item.kind,
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
  });

/**
 * Joins explicit issue and pull request relationships into Task cards, without stored Task
 * identities (ADR 0024). Each card includes its running Run, which sets its Board lane.
 */
export const taskCards = (
  repository: RepositoryName,
  items: ReadonlyArray<ProjectedItem>,
  runs: ReadonlyArray<RunView>,
  cycleBlockedItems: ReadonlyArray<ItemKey>,
  itemLoops: ReadonlyMap<ItemKey, ReadonlyArray<LoopName>>,
  runUsage: ReadonlyMap<RunId, RunUsageView>,
): ReadonlyArray<TaskCard> => {
  const runsByItem = EffectArray.groupBy(runs, ({ itemKey }) => itemKey);
  const nodes = items.map((item): TaskItem => ({
    item,
    runs: runsByItem[item.itemKey] ?? [],
    related: new Set(),
  }));
  const repositoryPath = `/${canonicalRepositoryName(repository)}/pull/`;
  const pullRequests = new Map(
    nodes
      .filter(({ item }) => item.kind === "pr")
      .map((node) => [`${repositoryPath}${node.item.number}`, node]),
  );
  const blocked = new Set(cycleBlockedItems);
  for (const node of nodes) {
    if (node.item.kind !== "issue") continue;
    const urls = [
      ...node.item.linkedPullRequests,
      ...node.runs.flatMap(({ pullRequestUrl }) =>
        pullRequestUrl === null ? [] : [pullRequestUrl],
      ),
    ];
    for (const value of urls) {
      const url = decodeUrl(value);
      if (Option.isNone(url) || url.value.protocol !== "https:" || url.value.host !== "github.com")
        continue;
      // Match the canonical PR path, not a numeric coercion of its last segment.
      // Number-only payload references can point to another repository.
      const pr = pullRequests.get(url.value.pathname.toLowerCase());
      if (pr === undefined) continue;
      node.related.add(pr);
      pr.related.add(node);
    }
  }

  const visited = new Set<TaskItem>();
  const cards: Array<TaskCard> = [];
  for (const seed of nodes) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    const members: EffectArray.NonEmptyArray<TaskItem> = [seed];
    for (const member of members) {
      for (const related of member.related) {
        if (visited.has(related)) continue;
        visited.add(related);
        members.push(related);
      }
    }
    const ordered = EffectArray.sort(
      members,
      ({ item: a }: TaskItem, { item: b }: TaskItem) =>
        (a.kind === b.kind ? 0 : a.kind === "issue" ? -1 : 1) || Order.Number(a.number, b.number),
    );
    const origin = ordered[0];
    const history = members
      .flatMap(({ item, runs }) => runs.map((run) => ({ item, run })))
      .sort(
        ({ run: a }, { run: b }) =>
          b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id),
      );
    const active = history.find(({ run }) => run.canCancel);
    const prs = members
      .filter(({ item }) => item.kind === "pr")
      .sort(
        ({ item: a }, { item: b }) =>
          Number(b.state === "pr-open") - Number(a.state === "pr-open") || b.number - a.number,
      );
    // An open Run controls the lane. Between stages, a PR takes over from its issue.
    const current = active?.item ?? prs[0]?.item ?? origin.item;
    // Open pull requests sort first, so the first open or merged one is the open one or, without
    // one, the newest merged one.
    const [pullRequest = null] = prs.flatMap(({ item: { number, url, state } }) =>
      state === "pr-open" || state === "pr-merged"
        ? [new BoardPullRequestView({ number, url, state })]
        : [],
    );
    const preferred =
      history.find(({ item, run }) => runNeedsAttention(run, isSettledItemState(item.state))) ??
      active ??
      history[0];
    const runs = history.map(({ run }) => run).reverse();
    const view = new BoardTaskView({
      ...itemLink(current),
      repository,
      title: origin.item.title,
      labels: current.labels,
      items: ordered.map(({ item }) => itemLink(item)),
      pullRequest,
      runs,
      run: preferred?.run ?? null,
      needsYou:
        history.some(({ item, run }) => runNeedsAttention(run, isSettledItemState(item.state))) ||
        members.some(({ item }) => blocked.has(item.itemKey)),
      conflicting: current.conflicting,
      loops: [...new Set(ordered.flatMap(({ item }) => itemLoops.get(item.itemKey) ?? []))],
      usage: taskUsage(runs, runUsage),
    });
    cards.push({ view, running: active?.run.state === "Running" ? active.run : undefined });
  }
  return cards;
};
