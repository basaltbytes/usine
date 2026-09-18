import { Schema } from "effect";
import { CommitSha, safeSegment, type RepositoryName } from "../repository.ts";
import type { RunId } from "../run/run.ts";
import type { WorkerName } from "../worker.ts";
import type { AttemptId, AttemptNumber } from "./attempt.ts";

/** The remote branch name that holds one Attempt's unfinished work, `usine/salvage/<run>/<attempt>`. */
export const SalvageRef = Schema.NonEmptyString.pipe(Schema.brand("SalvageRef"));
export type SalvageRef = typeof SalvageRef.Type;

/** The salvage branch an Attempt pushes to when it ends without success. */
export const salvageRefFor = (runId: RunId, number: AttemptNumber): SalvageRef =>
  SalvageRef.make(`usine/salvage/${safeSegment(runId)}/${number}`);

/** The Attempt's unfinished work was committed and pushed to `ref`; `commit` is the pushed head. */
export class SalvagePushed extends Schema.TaggedClass<SalvagePushed>("AttemptSalvage/Pushed")(
  "Pushed",
  {
    ref: SalvageRef,
    commit: CommitSha,
  },
) {}

/** Salvage failed; `path` stays on the Worker for reconciliation. `commit` is the last known commit, or absent when inspection failed. */
export class SalvageRetained extends Schema.TaggedClass<SalvageRetained>("AttemptSalvage/Retained")(
  "Retained",
  {
    path: Schema.NonEmptyString,
    commit: Schema.OptionFromNullOr(CommitSha),
    message: Schema.String,
  },
) {}

/** What the executor preserved of an Attempt's workspace when the Attempt ended without a `Succeeded` outcome. */
export const AttemptSalvage = Schema.Union([SalvagePushed, SalvageRetained]);
export type AttemptSalvage = typeof AttemptSalvage.Type;

/** Identifies a persisted Attempt whose Worker may still hold unpublished work. */
export interface AttemptRecovery {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly repository: RepositoryName;
  readonly ref: SalvageRef;
}
