import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { gitHubItemKey } from "../../src/polling/repository-sync.ts";

const repository = RepositoryName.make("basaltbytes/usine");

export const issue = (number: number, pullRequests: ReadonlyArray<number>) =>
  ItemProjection.make({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://github.com/basaltbytes/usine/issues/${number}`,
      state: "CLOSED",
      stateReason: null,
      createdAt: "2026-10-19T10:00:00Z",
      updatedAt: "2026-10-22T08:00:00Z",
      closedAt: "2026-10-22T08:00:00Z",
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: 0, nodes: [] },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: {
        totalCount: pullRequests.length,
        nodes: pullRequests.map((pr) => ({
          number: pr,
          state: "MERGED",
          isDraft: false,
          url: `https://github.com/basaltbytes/usine/pull/${pr}`,
        })),
      },
    },
  });
export const mergedPullRequest = (number: number, mergedAt: string) =>
  ItemProjection.make({
    itemKey: gitHubItemKey(repository, number),
    repository,
    source: ItemProjectionSource.make("pr"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`pr-${number}`),
    payload: {
      number,
      title: `Pull request ${number}`,
      body: "",
      url: `https://github.com/basaltbytes/usine/pull/${number}`,
      state: "MERGED",
      isDraft: false,
      merged: true,
      createdAt: "2026-10-20T09:00:00Z",
      updatedAt: mergedAt,
      mergedAt,
      author: { login: "usine-bot" },
      baseRefName: "main",
      headRefName: `fix/${number}`,
      headRefOid: "410607d",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewDecision: null,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      statusCheckRollup: null,
      labels: { totalCount: 0, nodes: [] },
      reviewRequests: { totalCount: 0, nodes: [] },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closingIssuesReferences: { totalCount: 0, nodes: [] },
    },
  });
