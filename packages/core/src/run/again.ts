import { Schema } from "effect";
import { OperatorLogin } from "../operator.ts";
import { RunId } from "./run.ts";

/**
 * How a Run was opened by the operator running an earlier Run again: `from` is
 * the succeeded or canceled Run whose Item state it runs again, and
 * `requestedBy` the operator login that asked. The web UI has no sign-in and
 * acts as the login `usine.yaml` names, so a Run run again while it names none
 * has no requester. The Run opened at the time of the request (ADR 0002).
 */
export class RunAgain extends Schema.Class<RunAgain>("RunAgain")(
  Schema.Struct({
    from: RunId,
    requestedBy: Schema.OptionFromNullOr(OperatorLogin),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}
