import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { Effect, Option, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { GitHubItemNotFoundError } from "../error.ts";
import type { GitHubApp } from "../github-app.ts";
import { queryGraphql } from "../graphql.ts";
import { invalidResponse } from "../http.ts";
import { LabelEvent } from "./payload.ts";
import { LABEL_EVENTS_QUERY } from "./queries.ts";

const MAX_LABEL_EVENT_PAGES = 10;

export const LabelTimeline = Schema.Struct({
  pageInfo: Schema.Struct({
    hasPreviousPage: Schema.Boolean,
    startCursor: Schema.NullOr(Schema.NonEmptyString),
  }),
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        ...LabelEvent.fields,
        label: Schema.Struct({ name: Schema.NonEmptyString }),
      }),
    ),
  ),
});

const LabelTimelineData = Schema.Struct({
  repository: Schema.OptionFromNullOr(
    Schema.Struct({
      issueOrPullRequest: Schema.OptionFromNullOr(Schema.Struct({ timelineItems: LabelTimeline })),
    }),
  ),
});

export const readLabelEvents = Effect.fn("GitHubPolling.labelEvents")(function* (
  services: {
    readonly http: HttpClient.HttpClient;
    readonly app: Pick<GitHubApp["Service"], "installationToken">;
  },
  repository: RepositoryName,
  number: number,
  labels: ReadonlyArray<{ readonly name: string }>,
  initial: typeof LabelTimeline.Type,
) {
  yield* Effect.annotateCurrentSpan({ repository, item: number });
  const missing = new Set(labels.map(({ name }) => name));
  const events = new Map<string, typeof LabelEvent.Type>();
  let page = initial;
  let pages = 1;
  while (true) {
    // GitHub returns each page oldest first, even with last/before pagination.
    for (const node of [...page.nodes].reverse()) {
      if (node !== null && missing.delete(node.label.name)) {
        events.set(node.label.name, { actor: node.actor, createdAt: node.createdAt });
      }
    }
    if (missing.size === 0 || !page.pageInfo.hasPreviousPage) break;
    if (pages >= MAX_LABEL_EVENT_PAGES || page.pageInfo.startCursor === null) {
      yield* Effect.logWarning("Cannot complete current label provenance", {
        repository,
        item: number,
        pages,
        missingLabels: [...missing],
      });
      return yield* invalidResponse(
        "fetch-item-timeline",
        page.pageInfo.startCursor === null
          ? "GitHub returned hasPreviousPage for label events without a startCursor"
          : `current label provenance requires more than ${MAX_LABEL_EVENT_PAGES} timeline pages`,
      );
    }
    yield* Effect.logDebug("Reading older events for current labels", {
      repository,
      item: number,
      pages,
      missingLabels: [...missing],
    });
    const token = yield* services.app.installationToken();
    const { owner, name } = splitRepositoryName(repository);
    const data = yield* queryGraphql(
      services.http,
      token,
      "fetch-item-timeline",
      LABEL_EVENTS_QUERY,
      { owner, name, number, before: page.pageInfo.startCursor },
      LabelTimelineData,
    );
    if (Option.isNone(data.repository)) {
      return yield* invalidResponse("fetch-item-timeline", `repository "${repository}" is null`);
    }
    const item = data.repository.value.issueOrPullRequest;
    if (Option.isNone(item)) {
      return yield* new GitHubItemNotFoundError({
        operation: "fetch-item-timeline",
        item: number,
        message: `GitHub item ${repository}#${number} was not found while reading label events`,
      });
    }
    page = item.value.timelineItems;
    pages += 1;
  }
  if (missing.size > 0) {
    yield* Effect.logWarning("GitHub has no label event for some current labels", {
      repository,
      item: number,
      missingLabels: [...missing],
    });
  }
  yield* Effect.logDebug("Read current label provenance", {
    repository,
    item: number,
    pages,
    labels: events.size,
  });
  return Object.fromEntries(events);
});
