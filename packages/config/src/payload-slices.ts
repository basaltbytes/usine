import { splitRepositoryName } from "@usine/core/repository";
import {
  Environment,
  ObjectField,
  ObjectType,
  TypeReference,
  Variable,
} from "@usine/expression/model";
import { Schema } from "effect";
import type { ManagedRepo } from "./factory.ts";
import type { Stream } from "./trigger.ts";

const reference = Schema.decodeUnknownSync(TypeReference);

type FieldDeclaration = readonly [name: string, type: string];

const objectType = (name: string, fields: ReadonlyArray<FieldDeclaration>): ObjectType =>
  new ObjectType({
    name,
    fields: fields.map(
      ([fieldName, fieldType]) => new ObjectField({ name: fieldName, type: reference(fieldType) }),
    ),
  });

const actor = objectType("Actor", [["login", "string"]]);
const label = objectType("Label", [["name", "string"]]);
const milestone = objectType("Milestone", [["title", "string"]]);
const issueType = objectType("IssueType", [["name", "string"]]);
const commit = objectType("Commit", [["oid", "string"]]);
const repo = objectType("RepoContext", [
  ["name", "string"],
  ["owner", "string"],
  ["url", "string"],
]);

const labels = objectType("Labels", [
  ["totalCount", "int"],
  ["nodes", "list<Label>"],
]);
const assignees = objectType("Assignees", [
  ["totalCount", "int"],
  ["nodes", "list<Actor>"],
]);
const issueComment = objectType("IssueComment", [
  ["author", "Actor"],
  ["body", "string"],
  ["createdAt", "string"],
]);
const issueComments = objectType("IssueComments", [
  ["totalCount", "int"],
  ["nodes", "list<IssueComment>"],
]);
const pullRequestReference = objectType("PullRequestReference", [
  ["number", "int"],
  ["state", "string"],
  ["isDraft", "bool"],
  ["url", "string"],
]);
const pullRequestReferences = objectType("PullRequestReferences", [
  ["totalCount", "int"],
  ["nodes", "list<PullRequestReference>"],
]);
const issue = objectType("IssuePayload", [
  ["number", "int"],
  ["title", "string"],
  ["body", "string"],
  ["url", "string"],
  ["state", "string"],
  ["stateReason", "string"],
  ["createdAt", "string"],
  ["updatedAt", "string"],
  ["closedAt", "string"],
  ["author", "Actor"],
  ["issueType", "IssueType"],
  ["milestone", "Milestone"],
  ["labels", "Labels"],
  ["assignees", "Assignees"],
  ["comments", "IssueComments"],
  ["closedByPullRequestsReferences", "PullRequestReferences"],
]);

const requestedReviewer = objectType("RequestedReviewer", [["login", "string"]]);
const reviewRequest = objectType("ReviewRequest", [["requestedReviewer", "RequestedReviewer"]]);
const reviewRequests = objectType("ReviewRequests", [
  ["totalCount", "int"],
  ["nodes", "list<ReviewRequest>"],
]);
const review = objectType("Review", [
  ["author", "Actor"],
  ["state", "string"],
  ["body", "string"],
  ["submittedAt", "string"],
  ["commit", "Commit"],
]);
const reviews = objectType("Reviews", [
  ["totalCount", "int"],
  ["nodes", "list<Review>"],
]);
const reviewThreadComment = objectType("ReviewThreadComment", [
  ["author", "Actor"],
  ["body", "string"],
]);
const reviewThreadComments = objectType("ReviewThreadComments", [
  ["totalCount", "int"],
  ["nodes", "list<ReviewThreadComment>"],
]);
const reviewThread = objectType("ReviewThread", [
  ["isResolved", "bool"],
  ["isOutdated", "bool"],
  ["path", "string"],
  ["comments", "ReviewThreadComments"],
]);
const reviewThreads = objectType("ReviewThreads", [
  ["totalCount", "int"],
  ["nodes", "list<ReviewThread>"],
]);
const pullRequestComment = objectType("PullRequestComment", [
  ["author", "Actor"],
  ["body", "string"],
  ["createdAt", "string"],
]);
const pullRequestComments = objectType("PullRequestComments", [
  ["totalCount", "int"],
  ["nodes", "list<PullRequestComment>"],
]);
const closingIssueReference = objectType("ClosingIssueReference", [
  ["number", "int"],
  ["state", "string"],
]);
const closingIssueReferences = objectType("ClosingIssueReferences", [
  ["totalCount", "int"],
  ["nodes", "list<ClosingIssueReference>"],
]);
const statusCheckRollup = objectType("StatusCheckRollup", [["state", "string"]]);
const pullRequest = objectType("PullRequestPayload", [
  ["number", "int"],
  ["title", "string"],
  ["body", "string"],
  ["url", "string"],
  ["state", "string"],
  ["isDraft", "bool"],
  ["merged", "bool"],
  ["createdAt", "string"],
  ["updatedAt", "string"],
  ["mergedAt", "string"],
  ["author", "Actor"],
  ["baseRefName", "string"],
  ["headRefName", "string"],
  ["headRefOid", "string"],
  ["additions", "int"],
  ["deletions", "int"],
  ["changedFiles", "int"],
  ["reviewDecision", "string"],
  ["statusCheckRollup", "StatusCheckRollup"],
  ["labels", "Labels"],
  ["reviewRequests", "ReviewRequests"],
  ["reviews", "Reviews"],
  ["reviewThreads", "ReviewThreads"],
  ["comments", "PullRequestComments"],
  ["closingIssuesReferences", "ClosingIssueReferences"],
]);

const tick = objectType("Tick", [
  ["scheduledAt", "string"],
  ["scheduledAtLocal", "string"],
  ["cron", "string"],
  ["tz", "string"],
]);
const schedule = objectType("SchedulePayload", [["tick", "Tick"]]);

const environment = (types: ReadonlyArray<ObjectType>, itemType: string): Environment =>
  new Environment({
    types: [repo, ...types],
    variables: [
      new Variable({ name: "repo", type: reference("RepoContext") }),
      new Variable({ name: "item", type: reference(itemType) }),
    ],
  });

/** Exact v1 issue payload slice descriptor recorded by issue #11. */
export const issueEnvironment = environment(
  [
    actor,
    label,
    milestone,
    issueType,
    labels,
    assignees,
    issueComment,
    issueComments,
    pullRequestReference,
    pullRequestReferences,
    issue,
  ],
  "IssuePayload",
);

/** Exact v1 pull-request payload slice descriptor recorded by issue #11. */
export const pullRequestEnvironment = environment(
  [
    actor,
    label,
    commit,
    labels,
    requestedReviewer,
    reviewRequest,
    reviewRequests,
    review,
    reviews,
    reviewThreadComment,
    reviewThreadComments,
    reviewThread,
    reviewThreads,
    pullRequestComment,
    pullRequestComments,
    closingIssueReference,
    closingIssueReferences,
    statusCheckRollup,
    pullRequest,
  ],
  "PullRequestPayload",
);

/** Schedule payload slice: item.tick = { scheduledAt, scheduledAtLocal, cron, tz }. */
export const scheduleEnvironment = environment([tick, schedule], "SchedulePayload");

export const environmentFor = (stream: Stream): Environment => {
  switch (stream) {
    case "issue":
      return issueEnvironment;
    case "pr":
      return pullRequestEnvironment;
    case "schedule":
      return scheduleEnvironment;
  }
};

/**
 * The CEL `repo` variable, built beside the `RepoContext` type it must match —
 * a field added to one belongs in the other.
 */
export const repositoryContext = (repository: ManagedRepo): Schema.JsonObject => {
  const { owner } = splitRepositoryName(repository.name);
  return {
    name: repository.name,
    owner,
    url: `https://github.com/${repository.name}`,
  };
};
