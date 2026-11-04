import { type Brand, Schema } from "effect";

import { ChangeTarget } from "@usine/core/changes";

export { ChangeTarget } from "@usine/core/changes";

/** A replayable invalidation notice. A reset requests a fresh read after a replay gap. */
export class ChangeNotice extends Schema.Class<
  ChangeNotice,
  Brand.Brand<"@usine/orchestrator/operator/changes/ChangeNotice">
>("@usine/orchestrator/ChangeNotice")({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reset: Schema.Boolean,
  changes: Schema.Array(ChangeTarget),
}) {}
