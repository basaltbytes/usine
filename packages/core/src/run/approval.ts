import { Option, Schema } from "effect";
import { OperatorLogin } from "../operator.ts";

/**
 * Where the operator approved a Run: `ui` is the web UI's Approve action, and
 * `github-ask` is a 👍 reaction on the factory's GitHub Ask (ADR 0017).
 */
export const APPROVAL_CHANNELS = ["ui", "github-ask"] as const;
export const ApprovalChannel = Schema.Literals(APPROVAL_CHANNELS);
export type ApprovalChannel = typeof ApprovalChannel.Type;

/**
 * Who approved a Run and through which channel, recorded once when the
 * approval takes effect. The web UI has no sign-in and acts as the operator
 * login `usine.yaml` names, so a UI approval has no approver while it names
 * none. A GitHub Ask answer counts only from that login, so it always has one.
 */
export class ApprovalSource extends Schema.Class<ApprovalSource>("ApprovalSource")(
  Schema.Struct({
    channel: ApprovalChannel,
    approver: Schema.OptionFromNullOr(OperatorLogin),
  })
    .check(
      Schema.makeFilter(
        ({ channel, approver }) => channel !== "github-ask" || Option.isSome(approver),
        { message: "Expected a GitHub Ask approval to name its approver" },
      ),
    )
    .annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}

/**
 * A Run's approval: when its approval Event arrived and who gave it through
 * which channel. Approvals given before usine recorded sources have none.
 */
export class RunApproval extends Schema.Class<RunApproval>("RunApproval")({
  approvedAt: Schema.DateTimeUtc,
  source: Schema.Option(ApprovalSource),
}) {}
