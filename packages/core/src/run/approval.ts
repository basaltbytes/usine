import { Schema } from "effect";
import { closedStruct } from "../closed-struct.ts";
import { OperatorLogin } from "../operator.ts";

/** The approval channel for authenticated operator actions. */
export const APPROVAL_CHANNELS = ["ui"] as const;
export const ApprovalChannel = Schema.Literals(APPROVAL_CHANNELS);
export type ApprovalChannel = typeof ApprovalChannel.Type;

/** Older approvals can have no recorded approver. */
export class ApprovalSource extends Schema.Class<ApprovalSource>("ApprovalSource")(
  closedStruct({ channel: ApprovalChannel, approver: Schema.OptionFromNullOr(OperatorLogin) }),
) {}

/**
 * A Run's approval. `approvedAt` is when the approval Event arrived, and `source` is `None` for
 * older records.
 */
export class RunApproval extends Schema.Class<RunApproval>("RunApproval")({
  approvedAt: Schema.DateTimeUtc,
  source: Schema.Option(ApprovalSource),
}) {}
