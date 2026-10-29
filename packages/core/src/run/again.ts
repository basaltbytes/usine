import { Schema } from "effect";
import { closedStruct } from "../closed-struct.ts";
import { OperatorLogin } from "../operator.ts";
import { RunId } from "./run.ts";

/**
 * The origin of a Run created by running a succeeded or canceled Run again (ADR 0002).
 * `requestedBy` is the recorded operator login, or `None` if unavailable.
 */
export class RunAgain extends Schema.Class<RunAgain>("RunAgain")(
  closedStruct({
    /** The succeeded or canceled run that the operator requested to run again. */
    from: RunId,
    /** The requesting operator's login, or `None` if none was recorded. */
    requestedBy: Schema.OptionFromNullOr(OperatorLogin),
  }),
) {}
