import { Schema } from "effect";
import { closedStruct } from "../closed-struct.ts";
import { OperatorLogin } from "../operator.ts";

/** The approval channel for authenticated operator actions. */
export const APPROVAL_CHANNELS = ["ui"] as const;
/** The authenticated web UI channel through which an operator approves a run. */
export const ApprovalChannel = Schema.Literals(APPROVAL_CHANNELS);
export type ApprovalChannel = typeof ApprovalChannel.Type;

/** Older approvals can have no recorded approver. */
export class ApprovalSource extends Schema.Class<ApprovalSource>("ApprovalSource")(
  closedStruct({
    /** The authenticated channel through which approval arrived. */
    channel: ApprovalChannel,
    /** The approving operator's login, or `None` for older approvals without attribution. */
    approver: Schema.OptionFromNullOr(OperatorLogin),
  }),
) {}

/**
 * A Run's approval. `approvedAt` is when the approval Event arrived, and `source` is `None` for
 * older records.
 */
export class RunApproval extends Schema.Class<RunApproval>("RunApproval")({
  /** The time the approval event arrived. */
  approvedAt: Schema.DateTimeUtc,
  /** The approval channel and operator, or `None` for older records. */
  source: Schema.Option(ApprovalSource),
}) {}
