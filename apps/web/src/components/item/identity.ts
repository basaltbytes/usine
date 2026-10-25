import { useQuery } from "@tanstack/react-query";
import type { BoardTaskView, FactoryOverview } from "@usine/orchestrator/operator";
import { Array as EffectArray, Option } from "effect";
import { overviewQuery } from "../../overview.ts";
import type { ItemRef } from "./mark.tsx";

/** An item with its title, as Board cards and Task views list them. */
export interface TitledItem extends ItemRef {
  readonly title: string;
}

/** The item that names a Task, and the Task's other pull requests (ADR 0024). */
export interface TaskIdentity {
  /** The earliest issue, else the earliest pull request; its title is the Task's title. */
  readonly origin: TitledItem;
  /** The pull requests other than `origin`, by number. */
  readonly pullRequests: ReadonlyArray<TitledItem>;
}

const byNumber = (a: TitledItem, b: TitledItem) => a.number - b.number;

/** Returns the identity of a Task from its items, in any order. */
export const taskIdentity = (
  items: EffectArray.NonEmptyReadonlyArray<TitledItem>,
): TaskIdentity => {
  const sorted = [...items].sort(byNumber);
  const origin = sorted.find(({ kind }) => kind === "issue") ?? sorted[0] ?? items[0];
  return {
    origin,
    pullRequests: sorted.filter(({ kind, number }) => kind === "pr" && number !== origin.number),
  };
};

/** Returns the identity of a Board card's Task. */
export const cardIdentity = (card: BoardTaskView): TaskIdentity =>
  taskIdentity(EffectArray.isReadonlyArrayNonEmpty(card.items) ? card.items : [card]);

/** Returns the Board card of the Task that has the item `itemKey`, if the overview shows it. */
export const taskCard = (
  overview: FactoryOverview | undefined,
  itemKey: string,
): Option.Option<BoardTaskView> =>
  Option.fromNullishOr(
    overview?.projects
      .flatMap(({ board }) => board.lanes)
      .flatMap(({ items }) => items)
      .find((card) => card.items.some((member) => member.itemKey === itemKey)),
  );

/** Returns the identity of the Task that has `item`, from its Board card if the overview shows one, else of `item` alone. */
export const itemIdentity = (
  overview: FactoryOverview | undefined,
  item: TitledItem & { readonly itemKey: string },
): TaskIdentity =>
  Option.match(taskCard(overview, item.itemKey), {
    onNone: () => taskIdentity([item]),
    onSome: cardIdentity,
  });

/** Returns the overview, or `undefined` until it loads. */
export const useOverview = (): FactoryOverview | undefined => useQuery(overviewQuery()).data;

/** Returns the pull request number in a GitHub pull request URL. */
const pullRequestNumber = (url: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(/\/pull\/(\d+)/u.exec(url)?.[1]), Number);

/**
 * Returns the pull request at `url` with its kind and state from `members` if one has its number,
 * else with an unknown state.
 */
export const pullRequestAt = (
  url: string,
  members: ReadonlyArray<ItemRef>,
): Option.Option<ItemRef> =>
  Option.map(
    pullRequestNumber(url),
    (number): ItemRef =>
      members.find((member) => member.number === number) ?? {
        kind: "pr",
        number,
        url,
        state: null,
      },
  );
