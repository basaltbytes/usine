import { Schema } from "effect";

/**
 * Loop identity — the loop file's name in the instance repo. Filename is
 * identity — renaming the file retires one loop and creates another
 * (ADR 0001).
 */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));

export type LoopName = typeof LoopName.Type;

/**
 * Whether a loop parks new runs until an approval Event arrives (ADR 0004's
 * `approval:` field, default none). One owner for the literal set the config
 * parser accepts and the engine routes on.
 */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;
