import { Schema } from "effect";

/**
 * Whether a loop parks new runs until an approval Event arrives (ADR 0004's
 * `approval:` field, default none). One owner for the literal set the config
 * parser accepts and the engine routes on.
 */
export const APPROVAL_REQUIREMENTS = ["none", "required"] as const;
export const ApprovalRequirement = Schema.Literals(APPROVAL_REQUIREMENTS);
export type ApprovalRequirement = typeof ApprovalRequirement.Type;
