import { Schema } from "effect";

/** The Loop file name. Renaming the file creates a new Loop and retires the old one (ADR 0001). */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));

export type LoopName = typeof LoopName.Type;

/** The approval modes; with `required`, new Runs wait for an approval Event. */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
/** Whether a new run must wait for an operator approval before starting an attempt. */
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;

/**
 * The repository access modes. With `write`, Attempts can push and merge. With `read`, they can
 * read code and post reviews and comments but can't push; a Worker kind that can't issue such a
 * token rejects the Attempt (ADR 0011).
 */
export const LOOP_PERMISSIONS = ["write", "read"] as const;
/** The repository access granted to attempts: `read` allows comments and reviews, while `write` also allows pushes and merges (ADR 0011). */
export const LoopPermissions = Schema.Literals(LOOP_PERMISSIONS);
export type LoopPermissions = typeof LoopPermissions.Type;
