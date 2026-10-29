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

/** Returns the salvage branch for `runId` and the attempt's 1-based `number`, replacing unsafe characters in the run ID with underscores. */
export const salvageRefFor = (runId: RunId, number: AttemptNumber): SalvageRef =>
  SalvageRef.make(`usine/salvage/${safeSegment(runId)}/${number}`);

/** Unfinished work committed and pushed to `ref`; `commit` is the pushed head. */
export class SalvagePushed extends Schema.TaggedClass<SalvagePushed>("AttemptSalvage/Pushed")(
  "Pushed",
  {
    /** The remote branch containing the unfinished work. */
    ref: SalvageRef,
    /** The head commit successfully pushed to the remote branch. */
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
  /** The remote branch containing the files that could be pushed. */
  ref: SalvageRef,
  /** The head commit successfully pushed to the remote branch. */
  commit: CommitSha,
  /** The retained checkout on the worker, including files excluded from the push. */
  path: Schema.NonEmptyString,
  /** The diagnostic identifying files excluded from the push. */
  message: Schema.String,
}) {}

/** A failed salvage that left the workspace at `path` on the Worker. `commit` is `None` if inspection failed. */
export class SalvageRetained extends Schema.TaggedClass<SalvageRetained>("AttemptSalvage/Retained")(
  "Retained",
  {
    /** The checkout retained on the worker after salvage failed. */
    path: Schema.NonEmptyString,
    /** The checkout's head commit, or `None` if inspection failed. */
    commit: Schema.OptionFromNullOr(CommitSha),
    /** The diagnostic explaining why the checkout could not be salvaged. */
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
    /** The checkout retained on the worker after the remote refused the push. */
    path: Schema.NonEmptyString,
    /** The rejected head commit, which recovery must not push again. */
    commit: CommitSha,
    /** The remote refusal that requires intervention before another push. */
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
  /** The persisted attempt whose checkout recovery inspects. */
  readonly attemptId: AttemptId;
  /** The worker on which the checkout may remain. */
  readonly worker: WorkerName;
  /** The managed repo to which recovery would push salvage. */
  readonly repository: RepositoryName;
  /** The remote branch to use when salvage is permitted. */
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
  /** Records the recovery result for this attempt; fails with `E` if storage fails. */
  readonly salvage: (salvage: AttemptSalvage) => Effect.Effect<void, E>;
  /** Records the comments and reviews attributed to this attempt during recovery; fails with `E` if storage fails. */
  readonly comments: (comments: ReadonlyArray<Comment>) => Effect.Effect<void, E>;
  /** Reads this attempt's window and the same agent's overlapping windows on its item; fails with `E` if storage fails. */
  readonly windows: Effect.Effect<AttemptWindows, E>;
}
