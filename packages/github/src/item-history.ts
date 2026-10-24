import { ItemNumber } from "@usine/core/item";
import { RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { GitHubItemNotFoundError, type GitHubAppError } from "./error.ts";
import { GitHubApp } from "./github-app.ts";
import { queryGraphql } from "./graphql.ts";
import { invalidResponse } from "./http.ts";
import type { AppSlug } from "./installation.ts";
import { RepositoryLabel, RepositoryLabelColor, RepositoryLabelName } from "./polling/labels.ts";

/** The maximum timeline pages per walk; more changes since `since` fail instead of returning partial results. */
const MAX_TIMELINE_PAGES = 10;

/** A label the App added to the Item; `label` is its current GitHub definition. */
export class LabelAdded extends Schema.TaggedClass<LabelAdded>("@usine/github/LabelAdded")(
  "LabelAdded",
  { at: Schema.DateTimeUtc, label: RepositoryLabel },
) {}

/** A label the App removed from the Item; `label` is its current GitHub definition. */
export class LabelRemoved extends Schema.TaggedClass<LabelRemoved>("@usine/github/LabelRemoved")(
  "LabelRemoved",
  { at: Schema.DateTimeUtc, label: RepositoryLabel },
) {}

/** A comment the App posted on the Item; `url` links to it. */
export class Commented extends Schema.TaggedClass<Commented>("@usine/github/Commented")(
  "Commented",
  { at: Schema.DateTimeUtc, url: Schema.NonEmptyString },
) {}

/** The state of a submitted pull request review. */
export const ReviewState = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
]);
export type ReviewState = typeof ReviewState.Type;

/** A review the App submitted on the pull request; `url` links to it. */
export class Reviewed extends Schema.TaggedClass<Reviewed>("@usine/github/Reviewed")("Reviewed", {
  at: Schema.DateTimeUtc,
  url: Schema.NonEmptyString,
  state: ReviewState,
}) {}

/** A change the App made on an issue or pull request, with GitHub's timestamp. */
export const ItemChange = Schema.Union([LabelAdded, LabelRemoved, Commented, Reviewed]);
export type ItemChange = typeof ItemChange.Type;

const LABEL_AND_COMMENT_NODES = `
      __typename
      ... on LabeledEvent { createdAt actor { __typename login } label { name color description } }
      ... on UnlabeledEvent { createdAt actor { __typename login } label { name color description } }
      ... on IssueComment { createdAt url author { __typename login } }`;

const ITEM_TIMELINE_QUERY = `
  query UsineItemTimeline($owner: String!, $name: String!, $number: Int!, $since: DateTime!, $after: String) {
    repository(owner: $owner, name: $name) {
      issueOrPullRequest(number: $number) {
        ... on Issue {
          timelineItems(first: 100, after: $after, since: $since, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT]) {
            pageInfo { hasNextPage endCursor }
            nodes {${LABEL_AND_COMMENT_NODES}
            }
          }
        }
        ... on PullRequest {
          timelineItems(first: 100, after: $after, since: $since, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT, PULL_REQUEST_REVIEW]) {
            pageInfo { hasNextPage endCursor }
            nodes {${LABEL_AND_COMMENT_NODES}
              ... on PullRequestReview { createdAt submittedAt url state author { __typename login } }
            }
          }
        }
      }
    }
  }
`;

const Actor = Schema.NullOr(Schema.Struct({ __typename: Schema.String, login: Schema.String }));
const TimelineLabel = Schema.Struct({
  name: RepositoryLabelName,
  color: RepositoryLabelColor,
  description: Schema.NullOr(Schema.String),
});
const LabelEventNode = <Tag extends "LabeledEvent" | "UnlabeledEvent">(tag: Tag) =>
  Schema.Struct({
    __typename: Schema.Literal(tag),
    createdAt: Schema.DateTimeUtcFromString,
    actor: Actor,
    label: TimelineLabel,
  });
const TimelineNode = Schema.Union([
  LabelEventNode("LabeledEvent"),
  LabelEventNode("UnlabeledEvent"),
  Schema.Struct({
    __typename: Schema.Literal("IssueComment"),
    createdAt: Schema.DateTimeUtcFromString,
    url: Schema.NonEmptyString,
    author: Actor,
  }),
  Schema.Struct({
    __typename: Schema.Literal("PullRequestReview"),
    createdAt: Schema.DateTimeUtcFromString,
    submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    url: Schema.NonEmptyString,
    state: Schema.Literals([...ReviewState.literals, "PENDING"]),
    author: Actor,
  }),
]);
type TimelineNode = typeof TimelineNode.Type;

const TimelineData = Schema.Struct({
  repository: Schema.OptionFromNullOr(
    Schema.Struct({
      issueOrPullRequest: Schema.OptionFromNullOr(
        Schema.Struct({
          timelineItems: Schema.Struct({
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(Schema.NullOr(TimelineNode)),
          }),
        }),
      ),
    }),
  ),
});

const appChange = (slug: AppSlug, node: TimelineNode): ReadonlyArray<ItemChange> => {
  const byApp = (actor: typeof Actor.Type) =>
    actor !== null && actor.__typename === "Bot" && actor.login === slug;
  const label = (from: typeof TimelineLabel.Type) =>
    new RepositoryLabel({
      name: from.name,
      color: from.color,
      description: Option.fromNullishOr(from.description),
    });
  switch (node.__typename) {
    case "LabeledEvent":
      return byApp(node.actor)
        ? [new LabelAdded({ at: node.createdAt, label: label(node.label) })]
        : [];
    case "UnlabeledEvent":
      return byApp(node.actor)
        ? [new LabelRemoved({ at: node.createdAt, label: label(node.label) })]
        : [];
    case "IssueComment":
      return byApp(node.author) ? [new Commented({ at: node.createdAt, url: node.url })] : [];
    case "PullRequestReview": {
      const state = node.state;
      // A pending review is a draft visible only to its author and hasn't changed anything on GitHub.
      if (!byApp(node.author) || state === "PENDING") return [];
      return [new Reviewed({ at: node.submittedAt ?? node.createdAt, url: node.url, state })];
    }
  }
};

/** The App's changes on an Item, read from the Item's GitHub timeline. */
export class GitHubItemHistory extends Context.Service<
  GitHubItemHistory,
  {
    /**
     * Returns the labels the App added or removed, its comments, and its submitted reviews on one
     * issue or pull request at or after `since`, oldest first. Labels have their current name,
     * color, and description. Fails with `GitHubItemNotFoundError` if the repository responds but
     * has no such Item.
     */
    readonly appChanges: (
      repository: RepositoryName,
      item: ItemNumber,
      since: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<ItemChange>, GitHubAppError | GitHubItemNotFoundError>;
  }
>()("@usine/github/GitHubItemHistory") {
  static readonly layer: Layer.Layer<GitHubItemHistory, never, GitHubApp | HttpClient.HttpClient> =
    Layer.effect(
      GitHubItemHistory,
      Effect.gen(function* () {
        const app = yield* GitHubApp;
        const http = yield* HttpClient.HttpClient;

        const timelinePage = Effect.fn("GitHubItemHistory.timelinePage")(function* (
          repository: RepositoryName,
          item: ItemNumber,
          since: string,
          after: string | null,
        ) {
          const token = yield* app.installationToken();
          const { name, owner } = splitRepositoryName(repository);
          const data = yield* queryGraphql(
            http,
            token,
            "fetch-item-timeline",
            ITEM_TIMELINE_QUERY,
            { owner, name, number: item, since, after },
            TimelineData,
          );
          if (Option.isNone(data.repository))
            return yield* invalidResponse(
              "fetch-item-timeline",
              `repository "${repository}" is null: deleted, renamed, or no longer accessible`,
            );
          const found = data.repository.value.issueOrPullRequest;
          if (Option.isNone(found))
            return yield* new GitHubItemNotFoundError({
              operation: "fetch-item-timeline",
              item,
              message: `Issue or pull request ${repository}#${item} was not found on GitHub. It was deleted or transferred, or the GitHub App can no longer read it.`,
            });
          const { pageInfo, nodes } = found.value.timelineItems;
          if (!pageInfo.hasNextPage) return { nodes, next: Option.none<string>() };
          if (pageInfo.endCursor === null)
            return yield* invalidResponse(
              "fetch-item-timeline",
              "GitHub returned hasNextPage for the timeline without an endCursor",
            );
          return { nodes, next: Option.some(pageInfo.endCursor) };
        });

        const appChanges = Effect.fn("GitHubItemHistory.appChanges")(function* (
          repository: RepositoryName,
          item: ItemNumber,
          since: DateTime.Utc,
        ) {
          yield* Effect.annotateCurrentSpan({ repository, item });
          const { appSlug } = yield* app.installation();
          const sinceIso = DateTime.formatIso(since);
          const nodes: Array<TimelineNode | null> = [];
          let next = Option.none<string>();
          let pages = 0;
          do {
            const page = yield* timelinePage(repository, item, sinceIso, Option.getOrNull(next));
            nodes.push(...page.nodes);
            next = page.next;
            pages += 1;
          } while (Option.isSome(next) && pages < MAX_TIMELINE_PAGES);
          if (Option.isSome(next))
            return yield* invalidResponse(
              "fetch-item-timeline",
              `the timeline of ${repository}#${item} since ${sinceIso} has more than ${MAX_TIMELINE_PAGES} pages`,
            );
          const changes = nodes.flatMap((node) => (node === null ? [] : appChange(appSlug, node)));
          yield* Effect.logDebug("Read the App's changes from an Item timeline", {
            repository,
            item,
            since: sinceIso,
            pages,
            timelineItems: nodes.length,
            appChanges: changes.length,
          });
          return changes;
        });

        return { appChanges };
      }),
    );
}

export { GitHubItemNotFoundError } from "./error.ts";
