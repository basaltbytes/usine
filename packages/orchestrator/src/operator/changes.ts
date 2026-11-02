import { Schema } from "effect";

/** The read projection affected by a change. IDs identify entities, never their contents. */
export const ChangeTarget = Schema.Struct({
  kind: Schema.Literals([
    "project",
    "item",
    "run",
    "attempt",
    "worker",
    "configuration",
    "attention",
    "activity",
    "navigation",
  ]),
  id: Schema.String,
});
export type ChangeTarget = typeof ChangeTarget.Type;

/** A replayable invalidation notice. A reset requests a fresh read after a replay gap. */
export class ChangeNotice extends Schema.Class<ChangeNotice>("@usine/orchestrator/ChangeNotice")({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reset: Schema.Boolean,
  changes: Schema.Array(ChangeTarget),
}) {}
