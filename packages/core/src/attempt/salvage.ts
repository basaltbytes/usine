import { type Effect, Schema } from "effect";
import type { LoopPermissions } from "../loop.ts";
import { CommitSha, safeSegment, type RepositoryName } from "../repository.ts";
import type { RunId } from "../run/run.ts";
import type { Comment } from "../step/result.ts";
import type { WorkerName } from "../worker.ts";
import type { AttemptId, AttemptNumber, AttemptWindow } from "./attempt.ts";

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

/** Identifies a persisted Attempt whose Worker may still hold a checkout. */
export interface AttemptRecovery {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly repository: RepositoryName;
  readonly ref: SalvageRef;
  /** The permission level of the Attempt's Loop; a `read` Attempt's leftover checkout is removed rather than salvaged. */
  readonly permissions: LoopPermissions;
  /** The Attempt delivered its result, so a leftover checkout is removed rather than salvaged. */
  readonly succeeded: boolean;
  /** The Attempt has no outcome yet: an orchestrator restart may reattach it if its parent task is still live. */
  readonly open: boolean;
}

/**
 * Where startup reconciliation records what a persisted Attempt left:
 * `salvage` records what the executor preserved of its checkout, and
 * `comments` the comments and reviews it posted on its Run's Item when its
 * parent task failed and the orchestrator stopped before recording them.
 * `overlapping` reads the windows of the other Attempts of its Agent that
 * overlap its own on that Item: the harvest of those comments reads them once
 * GitHub has listed the comments, and leaves out one posted in such a window.
 */
export interface RecoverySink<E> {
  readonly salvage: (salvage: AttemptSalvage) => Effect.Effect<void, E>;
  readonly comments: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, E>;
  readonly overlapping: Effect.Effect<ReadonlyArray<AttemptWindow>, E>;
}
