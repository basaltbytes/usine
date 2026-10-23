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
  /** Whether GitHub reports the pull request branch as conflicting with its base. */
  readonly conflicting: boolean;
}

const labelsFrom = Schema.decodeUnknownEffect(Schema.Array(GitHubLabelName));

// Only the labels are read, so a payload stored before later fields were added still decodes.
const IssueLabels = Schema.Struct({ labels: IssuePayload.fields.labels });
const PullRequestLabels = Schema.Struct({ labels: PullRequestPayload.fields.labels });

/**
 * Returns the labels in an Item `payload` of `kind`, such as the payload of a Run's Event. Fails if
 * the payload has no labels of that shape.
 */
export const payloadLabels = (kind: ProjectedItem["kind"], payload: Schema.Json) =>
  Schema.decodeUnknownEffect(kind === "issue" ? IssueLabels : PullRequestLabels)(payload).pipe(
    Effect.flatMap(({ labels }) => labelsFrom(labels.nodes.map(({ name }) => name))),
  );

const projectionError = (item: ItemProjection, message: string) =>
  new BoardProjectionError({
    repository: item.repository,
    itemKey: item.itemKey,
    message,
  });

/** Returns the Board's view of one stored Item. An Item gone from GitHub counts as closed. */
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
