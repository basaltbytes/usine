import {
  ReleaseVersion,
  UpgradeChannel,
  UpgradeMode,
  UpgradeRecord,
  UpgradeTiming,
} from "@usine/core/upgrade";
import { Schema } from "effect";

/** An operator request to install a release immediately or after attempts finish. */
export class UpgradeRequest extends Schema.Class<UpgradeRequest>(
  "@usine/orchestrator/UpgradeRequest",
)({
  /** Whether to install immediately or wait until attempts finish. */
  timing: UpgradeTiming,
  /** The requested release version, or `None` to select the available release. */
  version: Schema.OptionFromOptionalKey(ReleaseVersion),
}) {}

/** The running release and the availability, progress, and last result of an upgrade. */
export class UpgradeView extends Schema.Class<UpgradeView>("@usine/orchestrator/UpgradeView")({
  /** The version string of the running server. */
  running: Schema.String,
  /** The selected release channel. */
  channel: UpgradeChannel,
  /** The upgrade policy: off, propose, or automatic. */
  mode: UpgradeMode,
  /** Whether this installation supports managed upgrades. */
  supported: Schema.Boolean,
  /** The release offered by the selected channel, or null without one. */
  available: Schema.NullOr(ReleaseVersion),
  /** The current upgrade state: idle, waiting for attempts, installing, or failed. */
  phase: Schema.Literals(["idle", "waiting", "installing", "failed"]),
  /** The upgrade progress or failure detail, or null without a message. */
  message: Schema.NullOr(Schema.String),
  /** The last recorded upgrade result, or null before any result. */
  outcome: Schema.NullOr(UpgradeRecord),
}) {}
