import type { FactoryOverview, RunView } from "@usine/orchestrator/operator";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Option, Schema } from "effect";

/** The GitHub Item of a Run; `title` is `None` if neither the Board nor the Event has it. */
export interface RunItem {
  readonly number: number;
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
    const carded = overview?.projects
      .flatMap(({ board }) => board.lanes)
      .flatMap(({ items }) => items)
      .flatMap(({ items }) => items)
      .find(({ itemKey }) => itemKey === run.itemKey);
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

export const pullRequestNumber = (url: string): Option.Option<string> =>
  Option.fromNullishOr(/\/pull\/(\d+)/u.exec(url)?.[1]);
