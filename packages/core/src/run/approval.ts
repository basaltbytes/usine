import { Option, Schema } from "effect";
import { OperatorLogin } from "../operator.ts";

/** The approval channels: `ui` for the web UI's Approve action and `github-ask` for a 👍 on the GitHub Ask (ADR 0017). */
export const APPROVAL_CHANNELS = ["ui", "github-ask"] as const;
export const ApprovalChannel = Schema.Literals(APPROVAL_CHANNELS);
export type ApprovalChannel = typeof ApprovalChannel.Type;

/**
 * The approver and channel, recorded when the approval takes effect. A `ui` approval has no
 * `approver` if `usine.yaml` sets no operator login; a `github-ask` approval always has one.
 */
export class ApprovalSource extends Schema.Class<ApprovalSource>("ApprovalSource")(
  Schema.Struct({
    channel: ApprovalChannel,
    approver: Schema.OptionFromNullOr(OperatorLogin),
  })
    .check(
      Schema.makeFilter(
        ({ channel, approver }) => channel !== "github-ask" || Option.isSome(approver),
        { message: "Expected an approver for a GitHub ask approval" },
      ),
    )
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}

/**
 * A Run's approval. `approvedAt` is when the approval Event arrived, and `source` is `None` for
 * older records.
 */
export class RunApproval extends Schema.Class<RunApproval>("RunApproval")({
  approvedAt: Schema.DateTimeUtc,
  source: Schema.Option(ApprovalSource),
}) {}
