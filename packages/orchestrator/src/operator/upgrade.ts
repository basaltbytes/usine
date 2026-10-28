import {
  ReleaseVersion,
  UpgradeChannel,
  UpgradeMode,
  UpgradeRecord,
  UpgradeTiming,
} from "@usine/core/upgrade";
import { Schema } from "effect";

export class UpgradeRequest extends Schema.Class<UpgradeRequest>(
  "@usine/orchestrator/UpgradeRequest",
)({
  timing: UpgradeTiming,
  version: Schema.OptionFromOptionalKey(ReleaseVersion),
}) {}

export class UpgradeView extends Schema.Class<UpgradeView>("@usine/orchestrator/UpgradeView")({
  running: Schema.String,
  channel: UpgradeChannel,
  mode: UpgradeMode,
  supported: Schema.Boolean,
  available: Schema.NullOr(ReleaseVersion),
  phase: Schema.Literals(["idle", "waiting", "installing", "failed"]),
  message: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(UpgradeRecord),
}) {}
