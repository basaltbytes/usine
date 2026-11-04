import { RunId } from "@usine/core/run";
import { ReleaseVersion } from "@usine/core/upgrade";
import { type Brand, Schema } from "effect";

/** An idle upgrade that defers new attempts until restart or cancellation. */
export class UpgradeWait extends Schema.Class<
  UpgradeWait,
  Brand.Brand<"@usine/engine/engine/upgrade/UpgradeWait">
>("@usine/engine/UpgradeWait")({
  target: ReleaseVersion,
  since: Schema.DateTimeUtcFromString,
}) {}

/** The upgrade wait and the runs currently deferred by attempt admission. */
export class UpgradeDrain extends Schema.Class<
  UpgradeDrain,
  Brand.Brand<"@usine/engine/engine/upgrade/UpgradeDrain">
>("@usine/engine/UpgradeDrain")({
  wait: UpgradeWait,
  runIds: Schema.Array(RunId),
}) {}
