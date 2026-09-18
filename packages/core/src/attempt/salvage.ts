import { Schema } from "effect";
import { CommitSha } from "../repository.ts";
import type { RunId } from "../run/run.ts";
import type { AttemptNumber } from "./attempt.ts";

/** The remote branch name that holds one Attempt's unfinished work, `usine/salvage/<run>/<attempt>`. */
export const SalvageRef = Schema.NonEmptyString.pipe(Schema.brand("SalvageRef"));
export type SalvageRef = typeof SalvageRef.Type;

const refSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

/** The salvage branch an Attempt pushes to when it ends without success. */
export const salvageRefFor = (runId: RunId, number: AttemptNumber): SalvageRef =>
  SalvageRef.make(`usine/salvage/${refSegment(runId)}/${number}`);

/** The Attempt's unfinished work was committed and pushed to `ref`; `commit` is the pushed head. */
export class SalvagePushed extends Schema.TaggedClass<SalvagePushed>("AttemptSalvage/Pushed")(
  "Pushed",
  {
    ref: SalvageRef,
    commit: CommitSha,
  },
) {}

/** The push failed, so the worktree stays on the Worker at `path` until an operator recovers it. */
export class SalvageRetained extends Schema.TaggedClass<SalvageRetained>("AttemptSalvage/Retained")(
  "Retained",
  {
    path: Schema.NonEmptyString,
    commit: CommitSha,
    message: Schema.String,
  },
) {}

/** What the executor preserved of an Attempt's workspace when the Attempt ended without a `Succeeded` outcome. */
export const AttemptSalvage = Schema.Union([SalvagePushed, SalvageRetained]);
export type AttemptSalvage = typeof AttemptSalvage.Type;
