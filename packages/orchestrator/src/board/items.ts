import { GitHubLabelName } from "@usine/config/label";
import type { LaneItemState } from "@usine/config/board";
import { ItemKey, ItemNumber } from "@usine/core/item";
import type { ItemProjection } from "@usine/engine/item-projection";
import { IssuePayload, PullRequestPayload } from "@usine/github/polling";
import { Effect, Option, Schema } from "effect";
import { BoardProjectionError } from "../operator/board.ts";

export interface ProjectedItem {
  readonly itemKey: ItemKey;
  readonly kind: "issue" | "pr";
  readonly number: ItemNumber;
  readonly title: string;
  readonly url: string;
  readonly state: LaneItemState;
  readonly linkedPullRequests: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<GitHubLabelName>;
  /** True when GitHub reports the pull request branch as conflicting with its base. */
  readonly conflicting: boolean;
}

const labelsFrom = Schema.decodeUnknownEffect(Schema.Array(GitHubLabelName));

const projectionError = (item: ItemProjection, message: string) =>
  new BoardProjectionError({
    repository: item.repository,
    itemKey: item.itemKey,
    message,
  });

/**
 * The Board's view of one stored Item. An Item GitHub no longer has counts as
 * closed, so its card leaves the open lanes.
 */
export const projectedItem = (
  item: ItemProjection,
): Effect.Effect<ProjectedItem, BoardProjectionError> =>
  Effect.gen(function* () {
    const gone = Option.isSome(item.goneAt);
    if (item.source === "issue") {
      const payload = yield* Schema.decodeUnknownEffect(IssuePayload)(item.payload).pipe(
        Effect.mapError((error) => projectionError(item, error.message)),
      );
      return {
        itemKey: item.itemKey,
        kind: "issue",
        number: ItemNumber.make(item.number),
        title: payload.title,
        url: payload.url,
        state: payload.state === "OPEN" && !gone ? "issue-open" : "issue-closed",
        linkedPullRequests: payload.closedByPullRequestsReferences.nodes.map(({ url }) => url),
        labels: yield* labelsFrom(payload.labels.nodes.map(({ name }) => name)).pipe(
          Effect.mapError((error) => projectionError(item, error.message)),
        ),
        conflicting: false,
      };
    }
    if (item.source === "pr") {
      const payload = yield* Schema.decodeUnknownEffect(PullRequestPayload)(item.payload).pipe(
        Effect.mapError((error) => projectionError(item, error.message)),
      );
      const state: LaneItemState = payload.merged
        ? "pr-merged"
        : payload.state === "OPEN" && !gone
          ? "pr-open"
          : "pr-closed";
      return {
        itemKey: item.itemKey,
        kind: "pr",
        number: ItemNumber.make(item.number),
        title: payload.title,
        url: payload.url,
        state,
        linkedPullRequests: [],
        labels: yield* labelsFrom(payload.labels.nodes.map(({ name }) => name)).pipe(
          Effect.mapError((error) => projectionError(item, error.message)),
        ),
        conflicting: state === "pr-open" && payload.mergeable === "CONFLICTING",
      };
    }
    return yield* projectionError(item, `Unsupported Item projection source: ${item.source}`);
  });
