import { splitRepositoryName } from "@usine/core/repository";
import {
  Environment,
  ObjectField,
  ObjectType,
  TypeReference,
  Variable,
} from "@usine/expression/expression-engine";
import { Schema } from "effect";
import type { ManagedRepo } from "./factory.ts";
import type { Stream } from "./trigger.ts";

const reference = Schema.decodeUnknownSync(TypeReference);

/**
 * A field name, its CEL type, and `nullable` if the GitHub payload can have `null` for the field
 * or omit it.
 */
type FieldDeclaration = readonly [name: string, type: string, nullability?: "nullable"];

const objectType = (name: string, fields: ReadonlyArray<FieldDeclaration>): ObjectType =>
  new ObjectType({
    name,
    fields: fields.map(
      ([fieldName, fieldType, nullability]) =>
        new ObjectField({
          name: fieldName,
          type: reference(fieldType),
          nullable: nullability === "nullable",
        }),
    ),
  });

const actor = objectType("Actor", [["login", "string"]]);
const labelActor = objectType("LabelActor", [
  ["login", "string"],
  ["type", "string"],
]);
const labelEvent = objectType("LabelEvent", [
  ["actor", "LabelActor", "nullable"],
  ["createdAt", "string"],
]);
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
  ["author", "Actor", "nullable"],
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
  ["stateReason", "string", "nullable"],
  ["createdAt", "string"],
  ["updatedAt", "string"],
  ["closedAt", "string", "nullable"],
  ["author", "Actor", "nullable"],
  ["issueType", "IssueType", "nullable"],
  ["milestone", "Milestone", "nullable"],
  ["labels", "Labels"],
  ["labelEvents", "map<string,LabelEvent>"],
  ["assignees", "Assignees"],
  ["comments", "IssueComments"],
  ["closedByPullRequestsReferences", "PullRequestReferences"],
]);

const requestedReviewer = objectType("RequestedReviewer", [["login", "string", "nullable"]]);
const reviewRequest = objectType("ReviewRequest", [
  ["requestedReviewer", "RequestedReviewer", "nullable"],
]);
const reviewRequests = objectType("ReviewRequests", [
  ["totalCount", "int"],
  ["nodes", "list<ReviewRequest>"],
]);
const review = objectType("Review", [
  ["author", "Actor", "nullable"],
  ["state", "string"],
  ["body", "string"],
  ["submittedAt", "string", "nullable"],
  ["commit", "Commit", "nullable"],
]);
const reviews = objectType("Reviews", [
  ["totalCount", "int"],
  ["nodes", "list<Review>"],
]);
const reviewThreadComment = objectType("ReviewThreadComment", [
  ["author", "Actor", "nullable"],
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
  ["author", "Actor", "nullable"],
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
  ["mergedAt", "string", "nullable"],
  ["author", "Actor", "nullable"],
  ["baseRefName", "string"],
  ["headRefName", "string"],
  ["headRefOid", "string"],
  ["additions", "int"],
  ["deletions", "int"],
  ["changedFiles", "int"],
  ["reviewDecision", "string", "nullable"],
  ["mergeable", "string"],
  ["mergeStateStatus", "string"],
  ["statusCheckRollup", "StatusCheckRollup", "nullable"],
  ["labels", "Labels"],
  ["labelEvents", "map<string,LabelEvent>"],
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

/** The CEL environment for issue triggers, with the issue payload slice as `item`. */
export const issueEnvironment = environment(
  [
    actor,
    labelActor,
    labelEvent,
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

/** The CEL environment for pull-request triggers, with the pull-request payload slice as `item`. */
export const pullRequestEnvironment = environment(
  [
    actor,
    labelActor,
    labelEvent,
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

/**
 * The CEL environment for schedule triggers; `item.tick` has `scheduledAt`, `scheduledAtLocal`,
 * `cron`, and `tz`.
 */
export const scheduleEnvironment = environment([tick, schedule], "SchedulePayload");

/**
 * Returns the CEL type environment for `stream`, including its `item` payload slice and the `repo`
 * variable.
 */
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

/** Returns the value of the CEL `repo` variable; its fields must match the `RepoContext` type. */
export const repositoryContext = (repository: Pick<ManagedRepo, "name">): Schema.JsonObject => {
  const { owner } = splitRepositoryName(repository.name);
  return {
    name: repository.name,
    owner,
    url: `https://github.com/${repository.name}`,
  };
};
