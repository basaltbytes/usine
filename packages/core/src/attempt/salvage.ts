import { Effect, Option, Schema } from "effect";
import { GitHubPushFailure } from "./failure.ts";
import type { LoopPermissions } from "../loop.ts";
import { CommitSha, safeSegment, type RepositoryName } from "../repository.ts";
import type { RunId } from "../run/run.ts";
import type { Comment } from "../step/result.ts";
import type { WorkerName } from "../worker.ts";
import type { AttemptId, AttemptNumber, AttemptWindows } from "./attempt.ts";

/** The remote branch `usine/salvage/<run>/<attempt>` with an Attempt's unfinished work. */
export const SalvageRef = Schema.NonEmptyString.pipe(Schema.brand("SalvageRef"));
export type SalvageRef = typeof SalvageRef.Type;

export const salvageRefFor = (runId: RunId, number: AttemptNumber): SalvageRef =>
  SalvageRef.make(`usine/salvage/${safeSegment(runId)}/${number}`);

/** Unfinished work committed and pushed to `ref`; `commit` is the pushed head. */
export class SalvagePushed extends Schema.TaggedClass<SalvagePushed>("AttemptSalvage/Pushed")(
  "Pushed",
  {
    ref: SalvageRef,
    commit: CommitSha,
  },
) {}

/**
 * Unfinished work pushed to `ref` at `commit`, without files that the salvage can't push, such as
 * a file over GitHub's size limit. The workspace at `path` on the Worker keeps their only copy,
 * and `message` names them.
 */
export class SalvagePartlyPushed extends Schema.TaggedClass<SalvagePartlyPushed>(
  "AttemptSalvage/PartlyPushed",
)("PartlyPushed", {
  ref: SalvageRef,
  commit: CommitSha,
  path: Schema.NonEmptyString,
  message: Schema.String,
}) {}

/** A failed salvage that left the workspace at `path` on the Worker. `commit` is `None` if inspection failed. */
export class SalvageRetained extends Schema.TaggedClass<SalvageRetained>("AttemptSalvage/Retained")(
  "Retained",
  {
    path: Schema.NonEmptyString,
    commit: Schema.OptionFromNullOr(CommitSha),
    message: Schema.String,
    /** A push refusal that also fails the attempt; absent on older salvage records. */
    pushFailure: Schema.OptionFromNullOr(GitHubPushFailure).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
      Schema.withConstructorDefault(Effect.succeed(Option.none<GitHubPushFailure>())),
    ),
  },
) {}

/**
 * A salvage whose push the remote refused for a reason that pushing again can't fix, such as a
 * file over GitHub's size limit. It left the workspace at `path` on the Worker, and recovery
 * doesn't push `commit` again.
 */
export class SalvageRejected extends Schema.TaggedClass<SalvageRejected>("AttemptSalvage/Rejected")(
  "Rejected",
  {
    path: Schema.NonEmptyString,
    commit: CommitSha,
    message: Schema.String,
  },
) {}

/** What the executor kept of the workspace of an unsuccessful Attempt. */
export const AttemptSalvage = Schema.Union([
  SalvagePushed,
  SalvagePartlyPushed,
  SalvageRetained,
  SalvageRejected,
]);
export type AttemptSalvage = typeof AttemptSalvage.Type;

/** A persisted Attempt whose checkout can still exist on its Worker. */
export interface AttemptRecovery {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly repository: RepositoryName;
  readonly ref: SalvageRef;
  /** The Loop permissions; a leftover checkout of a `read` Attempt is removed, not salvaged. */
  readonly permissions: LoopPermissions;
  /** Whether the Attempt succeeded, in which case a leftover checkout is removed, not salvaged. */
  readonly succeeded: boolean;
  /** Whether the Attempt has no outcome yet, so a restart can reattach it if its parent task runs. */
  readonly open: boolean;
  /** The recorded salvage that the remote rejected, whose commit recovery doesn't push again. */
  readonly rejected: Option.Option<SalvageRejected>;
}

/** The storage that startup reconciliation uses for a persisted Attempt's salvage, comments, and windows. */
export interface RecoverySink<E> {
  readonly salvage: (salvage: AttemptSalvage) => Effect.Effect<void, E>;
  readonly comments: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, E>;
  readonly windows: Effect.Effect<AttemptWindows, E>;
}
