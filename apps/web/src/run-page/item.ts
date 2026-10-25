import type { LaneItemState, SettledItemState } from "@usine/config/board";
import type { ItemNumber } from "@usine/core/item";
import type { BoardTaskView, FactoryOverview, RunView } from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Option, Schema } from "effect";
import { cardIdentity, pullRequestAt, taskCard } from "@/components/item/identity";
import type { ItemRef } from "@/components/item/mark";

/** The GitHub Item of a Run; `title` is `None` if neither the Board nor the Event has it. */
export interface RunItem {
  readonly number: ItemNumber;
  readonly url: string;
  readonly title: Option.Option<string>;
  /** Whether the Item is a pull request; if so, it is shown as the Run's pull request when the Run opened none. */
  readonly pullRequest: boolean;
}

/** The issue or pull request snapshot in an Item trigger's Event payload; other fields are ignored. */
const ItemSnapshot = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  labels: Schema.optionalKey(
    Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  ),
});

/** The GitHub issue or pull request in a triggering Event. */
export interface EventItem {
  readonly kind: "Issue" | "Pull request";
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly author: Option.Option<string>;
  readonly labels: ReadonlyArray<string>;
  readonly body: Option.Option<string>;
}

const decodeItemKey = Schema.decodeOption(GitHubItemKey);
const decodeSnapshot = Schema.decodeUnknownOption(ItemSnapshot);

/** Decodes the GitHub Item in an Event payload. Returns `None` for schedule ticks and other payloads. */
export const eventItem = (payload: Schema.Json): Option.Option<EventItem> =>
  Option.map(decodeSnapshot(payload), (snapshot) => ({
    kind: snapshot.url.includes("/pull/") ? "Pull request" : "Issue",
    number: snapshot.number,
    title: snapshot.title,
    url: snapshot.url,
    state: snapshot.state.charAt(0) + snapshot.state.slice(1).toLowerCase(),
    author: Option.fromNullishOr(snapshot.author?.login),
    labels: snapshot.labels?.nodes.map(({ name }) => name) ?? [],
    body: Option.filter(Option.fromNullishOr(snapshot.body), (body) => body.trim() !== ""),
  }));

const eventStates = new Map<string, LaneItemState>([
  ["Issue Open", "issue-open"],
  ["Issue Closed", "issue-closed"],
  ["Pull request Open", "pr-open"],
  ["Pull request Closed", "pr-closed"],
  ["Pull request Merged", "pr-merged"],
]);

/** Returns the Event's item with its state when the Event was recorded, or an unknown state for an unrecognized one. */
export const eventItemRef = ({ kind, number, url, state }: EventItem): ItemRef => ({
  kind: kind === "Pull request" ? "pr" : "issue",
  number,
  url,
  state: eventStates.get(`${kind} ${state}`) ?? null,
});

/**
 * Returns the Run's Item, titled from the Board if it shows the Item, else from the Event; `None` for
 * schedule Runs. The fallback URL uses `/issues/N`, which GitHub redirects to `/pull/N`.
 */
export const runItem = (
  run: Pick<RunView, "itemKey">,
  overview: FactoryOverview | undefined,
  payload: Schema.Json | undefined,
): Option.Option<RunItem> =>
  Option.map(decodeItemKey(run.itemKey), ([, repository, number]) => {
    const carded = Option.getOrUndefined(
      Option.flatMap(taskCard(overview, run.itemKey), ({ items }) =>
        Option.fromNullishOr(items.find(({ itemKey }) => itemKey === run.itemKey)),
      ),
    );
    const event = Option.getOrUndefined(
      Option.filter(
        payload === undefined ? Option.none<EventItem>() : eventItem(payload),
        (snapshot) => snapshot.number === number,
      ),
    );
    return {
      number,
      url: carded?.url ?? event?.url ?? `https://github.com/${repository}/issues/${number}`,
      title: Option.fromNullishOr(carded?.title ?? event?.title),
      pullRequest: carded === undefined ? event?.kind === "Pull request" : carded.kind === "pr",
    };
  });

/** Returns two lines describing what started the Run. */
export const eventPreview = (loop: string, payload: Schema.Json): string =>
  Option.match(eventItem(payload), {
    onNone: () => `Opened by ${loop}`,
    onSome: ({ kind, number, state, labels }) =>
      `${loop} matched ${kind.toLowerCase()} #${number}: ${state.toLowerCase()}${
        labels.length === 0 ? "" : `, labeled ${labels.join(", ")}`
      }`,
  });

/** The item a Run header names and its title, and the Run's pull request if it is another item. */
export interface RunHeaderItems {
  /** The Task's originating item, else the Run's Item while the Board doesn't show the Task. */
  readonly heading: Option.Option<ItemRef>;
  /** The heading item's title, if known. */
  readonly title: Option.Option<string>;
  /** The pull request the Run opened, else the Run's Item if it is a pull request. */
  readonly pullRequest: Option.Option<ItemRef>;
}

/**
 * Returns the items of a Run header. States come from the Task's Board card; without one, the
 * Run's Item has the state `settled` and its pull request an unknown state.
 */
export const runHeaderItems = (
  run: Pick<RunView, "pullRequestUrl">,
  item: Option.Option<RunItem>,
  card: Option.Option<BoardTaskView>,
  settled: SettledItemState | null,
): RunHeaderItems => {
  const identity = Option.map(card, cardIdentity);
  const members: ReadonlyArray<ItemRef> = Option.match(card, {
    onNone: () => [],
    onSome: ({ items }) => items,
  });
  const opened = Option.flatMap(Option.fromNullishOr(run.pullRequestUrl), (url) =>
    pullRequestAt(url, members),
  );
  const own = Option.map(
    item,
    ({ number, url, pullRequest }): ItemRef =>
      members.find((member) => member.number === number) ?? {
        kind:
          settled === null
            ? pullRequest || Option.exists(opened, (pr) => pr.number === number)
              ? "pr"
              : "issue"
            : settled.startsWith("pr-")
              ? "pr"
              : "issue",
        number,
        url,
        state: settled,
      },
  );
  const heading = Option.match(identity, {
    onNone: () => own,
    onSome: ({ origin }) => Option.some<ItemRef>(origin),
  });
  return {
    heading,
    title: Option.map(identity, ({ origin }) => origin.title),
    pullRequest: Option.filter(
      Option.orElse(opened, () => Option.filter(own, ({ kind }) => kind === "pr")),
      (pr) => !Option.exists(heading, ({ number }) => number === pr.number),
    ),
  };
};
