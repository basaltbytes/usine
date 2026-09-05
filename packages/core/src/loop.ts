import { Schema } from "effect";

/** The loop file's name. Renaming the file retires one loop and creates another (ADR 0001). */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));

export type LoopName = typeof LoopName.Type;

/** Whether a loop parks new runs until an approval Event arrives. The default is `none`. */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;
