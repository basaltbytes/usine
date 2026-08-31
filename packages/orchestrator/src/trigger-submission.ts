import type { LoopFile, ManagedRepo } from "@usine/config";
import { AttemptChannel, Event, Item, Repository } from "@usine/core";
import { Submission, type SubmissionResult } from "@usine/engine";
import type { DateTime, Schema } from "effect";

/**
 * The worker fetch target until per-loop revisions exist: `git fetch origin
 * HEAD` resolves the remote's current default branch at prepare time.
 */
const DEFAULT_BRANCH_REVISION = Repository.Revision.make("HEAD");

export const repositoryContext = (repository: ManagedRepo): Schema.JsonObject => {
  const { owner } = Repository.parts(repository.name);
  return {
    name: repository.name,
    owner,
    url: `https://github.com/${repository.name}`,
  };
};

interface TriggerSubmissionOptions {
  readonly dedupKey: Event.DedupKey;
  readonly itemKey: Item.ItemKey;
  readonly loop: LoopFile;
  readonly payload: Schema.Json;
  readonly receivedAt: DateTime.Utc;
  readonly repository: ManagedRepo;
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
    // Interpolation is a later ticket; until then the authored loop body is
    // the rendered task the run host hands the agent.
    task: AttemptChannel.Task.make(options.loop.body),
  });

export const submissionRunId = (submission: SubmissionResult): string =>
  submission._tag === "Claimed" ? submission.runId : "";
