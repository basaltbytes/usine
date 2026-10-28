import { Effect, Schema } from "effect";

export const UpgradeChannel = Schema.Literals(["latest", "next"]);
export type UpgradeChannel = typeof UpgradeChannel.Type;

export const UpgradeMode = Schema.Literals(["off", "propose", "automatic"]);
export type UpgradeMode = typeof UpgradeMode.Type;

export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  ),
).pipe(Schema.brand("ReleaseVersion"));
export type ReleaseVersion = typeof ReleaseVersion.Type;

export const UpgradeTiming = Schema.Literals(["idle", "now"]);
export type UpgradeTiming = typeof UpgradeTiming.Type;

const versions = { previous: ReleaseVersion, target: ReleaseVersion };

class Installing extends Schema.Class<Installing>("@usine/core/UpgradeInstalling")({
  ...versions,
  status: Schema.Literal("installing"),
}) {}
class Good extends Schema.Class<Good>("@usine/core/UpgradeGood")({
  ...versions,
  status: Schema.Literal("good"),
}) {}
class RolledBack extends Schema.Class<RolledBack>("@usine/core/UpgradeRolledBack")({
  ...versions,
  status: Schema.Literal("rolled-back"),
  reason: Schema.NonEmptyString,
  failureStage: Schema.Literals(["install", "health-check", "unknown"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("unknown")),
  ),
}) {}
class Failed extends Schema.Class<Failed>("@usine/core/UpgradeFailed")({
  ...versions,
  status: Schema.Literal("failed"),
  reason: Schema.NonEmptyString,
}) {}

/** The durable result written by the upgrade helper, including an unfinished installation. */
export const UpgradeRecord = Schema.Union([Installing, Good, RolledBack, Failed]);
export type UpgradeRecord = typeof UpgradeRecord.Type;
