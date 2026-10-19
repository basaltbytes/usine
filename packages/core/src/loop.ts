import { Schema } from "effect";

/** The loop file's name. Renaming the file retires one loop and creates another (ADR 0001). */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));

export type LoopName = typeof LoopName.Type;

/** Whether a loop parks new runs until an approval Event arrives. The default is `none`. */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;

/**
 * What a Loop's Attempts may do to their repository. With `write`, the
 * default, they can push and merge. With `read`, their GitHub token can read
 * the code and post reviews and comments but cannot push, and a Worker kind
 * that cannot give them such a token refuses them (ADR 0011).
 */
export const LOOP_PERMISSIONS = ["write", "read"] as const;
export const LoopPermissions = Schema.Literals(LOOP_PERMISSIONS);
export type LoopPermissions = typeof LoopPermissions.Type;
