import type { RepositoryName } from "@usine/core/repository";

export const taskNotFound = "Task not found";
export const taskNotFoundDescription = (repository: RepositoryName, number: string): string =>
  `#${number} is not among the newest items on the ${repository} board`;
export const backToBoard = "Back to the board";

export const loadingRuns = "Loading runs…";
export const retryRuns = "Could not load runs. Retry";

export const changesTitle = "Changes";
export const changesFor = (number: number) => `Changes for pull request #${number}`;
export const compareChanges = "Compare";
export const wholePullRequest = "Whole pull request";
export const attemptChangesLabel = (loop: string, number: number, head: string) =>
  `${loop} · attempt ${number} · ${head.slice(0, 7)}`;
export const loadingChanges = "Loading changes…";
export const changesFailed = "Could not load changes";
export const retryChanges = "Retry";
export const noChangedFiles = "No files changed in this comparison";
export const truncatedFiles =
  "GitHub limited this file list. Open the pull request on GitHub for the full list.";
export const noRecordedAttempts = "No attempt commits recorded for this pull request";
export const noRecordedHead = "Changes are available after the pull request head is recorded";
export const checksState = (state: string | null) =>
  `Checks: ${state === "SUCCESS" ? "passed" : state === "FAILURE" || state === "ERROR" ? "failed" : state === "PENDING" || state === "EXPECTED" ? "pending" : "unavailable"}`;
export const reviewState = (state: string | null) =>
  `Review: ${state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes requested" : state === "REVIEW_REQUIRED" ? "required" : "no decision"}`;
