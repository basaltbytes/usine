import type { UpgradeDrain } from "@usine/engine/engine";
import type { AttentionAcknowledgements } from "@usine/engine/attention";
import { partitionNeeds } from "./attention.ts";
import { UpgradeDrainNeed } from "./need.ts";
import { ReadyOverview } from "./overview.ts";
import {
  ReleaseVersion,
  UpgradeChannel,
  UpgradeMode,
  UpgradeRecord,
  UpgradeTiming,
} from "@usine/core/upgrade";
import { DateTime, Effect, Schema } from "effect";

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
  /** The requested version, including versions selected explicitly by the operator. */
  target: Schema.NullOr(ReleaseVersion).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The upgrade progress or failure detail, or null without a message. */
  message: Schema.NullOr(Schema.String),
  /** The last recorded upgrade result, or null before any result. */
  outcome: Schema.NullOr(UpgradeRecord),
}) {}

export const upgradeAttentionFor = (
  read: Effect.Effect<UpgradeDrain | null>,
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
) =>
  Effect.fn("Operator.upgradeAttention")(function* (overview: ReadyOverview) {
    const drain = yield* read;
    if (drain === null || drain.runIds.length === 0) return overview;
    const now = yield* DateTime.now;
    if (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(drain.wait.since) < 10 * 60_000)
      return overview;
    yield* Effect.annotateCurrentSpan({
      target: drain.wait.target,
      deferredRuns: drain.runIds.length,
    });
    const need = new UpgradeDrainNeed({
      id: "upgrade-drain",
      wait: drain.wait,
      deferredRuns: drain.runIds.length,
    });
    const { needsYou, dismissedNeeds } = partitionNeeds([need], yield* acknowledgements.list());
    return new ReadyOverview({
      ...overview,
      needsYou: [...overview.needsYou, ...needsYou],
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
