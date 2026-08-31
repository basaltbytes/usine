import type { LoopFile, ManagedRepo } from "@usine/config";
import { AttemptChannel, Event, Item, Repository } from "@usine/core";
import { Submission, type SubmissionResult } from "@usine/engine";
import { type DateTime, Match, type Schema } from "effect";

/**
 * The worker fetch target until per-loop revisions exist: `git fetch origin
 * HEAD` resolves the remote's current default branch at prepare time.
 */
const DEFAULT_BRANCH_REVISION = Repository.Revision.make("HEAD");

interface TriggerSubmissionOptions {
  readonly dedupKey: Event.DedupKey;
  readonly itemKey: Item.ItemKey;
  readonly loop: LoopFile;
  readonly payload: Schema.Json;
  readonly receivedAt: DateTime.Utc;
  readonly repository: ManagedRepo;
  readonly task: AttemptChannel.Task;
}

/** The one routing contract shared by every trigger stream. */
export const triggerSubmission = (options: TriggerSubmissionOptions): Submission =>
  new Submission({
    event: new Event.Event({
      id: Event.EventId.make(options.dedupKey),
      dedupKey: options.dedupKey,
      payload: options.payload,
      receivedAt: options.receivedAt,
    }),
    itemKey: options.itemKey,
    loop: options.loop.name,
    step: options.loop.step,
    approval: options.loop.approval,
    repository: options.repository.name,
    revision: DEFAULT_BRANCH_REVISION,
    task: options.task,
  });

/**
 * What each submission outcome contributes to its log line: the run for a
 * claim, the ignore reason for a superseded or revoked Event — never a
 * sentinel value.
 */
export const submissionLogFields = (submission: SubmissionResult): Record<string, string> =>
  Match.valueTags(submission, {
    Claimed: ({ runId }) => ({ runId }),
    Queued: () => ({}),
    Ignored: ({ reason }) => ({ reason }),
  });
