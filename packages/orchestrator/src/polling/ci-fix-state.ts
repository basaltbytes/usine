import { PullRequestPayload } from "@usine/github/polling";
import { Schema } from "effect";

/** The pull request fields that decide whether its current head still needs a CI fix. */
export const CiFixState = Schema.Struct({
  state: PullRequestPayload.fields.state,
  merged: PullRequestPayload.fields.merged,
  mergeable: PullRequestPayload.fields.mergeable,
  statusCheckRollup: PullRequestPayload.fields.statusCheckRollup,
});

export type CiFixState = typeof CiFixState.Type;

/**
 * Returns whether an open pull request's current head still needs a CI fix: its checks fail, or
 * it has no checks while GitHub reports the branch as conflicting or of unknown mergeability.
 */
export const needsCiFix = ({ state, merged, mergeable, statusCheckRollup }: CiFixState) =>
  state === "OPEN" &&
  !merged &&
  (statusCheckRollup === null
    ? mergeable === "CONFLICTING" || mergeable === "UNKNOWN"
    : statusCheckRollup.state === "FAILURE" || statusCheckRollup.state === "ERROR");
