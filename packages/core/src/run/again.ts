import { Schema } from "effect";
import { OperatorLogin } from "../operator.ts";
import { RunId } from "./run.ts";

/**
 * The origin of a Run created by running a succeeded or canceled Run again (ADR 0002).
 * `requestedBy` is the operator login from `usine.yaml`, or `None` if none is configured.
 */
export class RunAgain extends Schema.Class<RunAgain>("RunAgain")(
  Schema.Struct({
    from: RunId,
    requestedBy: Schema.OptionFromNullOr(OperatorLogin),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
) {}
