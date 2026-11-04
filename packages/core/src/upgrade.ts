import { type Brand, Effect, Schema } from "effect";

/** The npm release tag to check: `latest` for stable releases or `next` for prereleases. */
export const UpgradeChannel = Schema.Literals(["latest", "next"]);
export type UpgradeChannel = typeof UpgradeChannel.Type;

/** The upgrade policy: `off` disables checks, `propose` reports available versions for an operator request, and `automatic` applies eligible upgrades. */
export const UpgradeMode = Schema.Literals(["off", "propose", "automatic"]);
export type UpgradeMode = typeof UpgradeMode.Type;

/** A semantic version without a leading `v`, including optional prerelease and build identifiers. */
export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  ),
).pipe(Schema.brand("ReleaseVersion"));
export type ReleaseVersion = typeof ReleaseVersion.Type;

/** When to request installation: after draining attempts (`idle`) or without a pre-installation drain (`now`). */
export const UpgradeTiming = Schema.Literals(["idle", "now"]);
export type UpgradeTiming = typeof UpgradeTiming.Type;

const versions = {
  /** The installed version before the upgrade began. */
  previous: ReleaseVersion,
  /** The version the helper attempted to install. */
  target: ReleaseVersion,
};

class Installing extends Schema.Class<Installing, Brand.Brand<"@usine/core/upgrade/Installing">>(
  "@usine/core/UpgradeInstalling",
)({
  ...versions,
  /** Installation began but the helper has not recorded a terminal outcome. */
  status: Schema.Literal("installing"),
}) {}
class Good extends Schema.Class<Good, Brand.Brand<"@usine/core/upgrade/Good">>(
  "@usine/core/UpgradeGood",
)({
  ...versions,
  /** The target version passed the post-installation health check. */
  status: Schema.Literal("good"),
}) {}
class RolledBack extends Schema.Class<RolledBack, Brand.Brand<"@usine/core/upgrade/RolledBack">>(
  "@usine/core/UpgradeRolledBack",
)({
  ...versions,
  /** The helper restored the previous version after the upgrade failed. */
  status: Schema.Literal("rolled-back"),
  /** The diagnostic explaining why the helper rolled back. */
  reason: Schema.NonEmptyString,
  /** Whether installation or the health check failed; `unknown` for older records. */
  failureStage: Schema.Literals(["install", "health-check", "unknown"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("unknown")),
  ),
}) {}
class Failed extends Schema.Class<Failed, Brand.Brand<"@usine/core/upgrade/Failed">>(
  "@usine/core/UpgradeFailed",
)({
  ...versions,
  /** The helper recorded an unrecovered upgrade failure. */
  status: Schema.Literal("failed"),
  /** The diagnostic explaining why installation or recovery failed. */
  reason: Schema.NonEmptyString,
}) {}

/** The durable result written by the upgrade helper, including an unfinished installation. */
const upgradeRecord = Schema.Union([Installing, Good, RolledBack, Failed]);
export const UpgradeRecord: Schema.Codec<
  Installing | Good | RolledBack | Failed,
  typeof upgradeRecord.Encoded
> = upgradeRecord;
export type UpgradeRecord = typeof UpgradeRecord.Type;
