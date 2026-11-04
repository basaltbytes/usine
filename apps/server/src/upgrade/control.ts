import { ChangeBus } from "@usine/core/changes";
import type { Settings } from "@usine/config/factory";
import { ReleaseVersion, UpgradeChannel, type UpgradeRecord } from "@usine/core/upgrade";
import { UpgradeRequest, UpgradeView } from "@usine/orchestrator/operator/http";
import { Context, Effect, Equal, Fiber, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { compareVersions } from "../instance/manifest.ts";

export class UpgradeError extends Schema.TaggedError<UpgradeError>("@usine/server/UpgradeError")(
  "UpgradeError",
  { message: Schema.String },
) {}

export interface UpgradePlatform {
  readonly lookup: (channel: UpgradeChannel) => Effect.Effect<ReleaseVersion, UpgradeError>;
  readonly checkDependencies: (target: ReleaseVersion) => Effect.Effect<void, UpgradeError>;
  readonly preflight: Effect.Effect<void, UpgradeError>;
  readonly launch: (target: ReleaseVersion) => Effect.Effect<void, UpgradeError>;
  readonly outcome: Effect.Effect<Option.Option<UpgradeRecord>, UpgradeError>;
}

interface UpgradeOptions {
  readonly running: string;
  readonly settings: Effect.Effect<Pick<Settings, "upgradeChannel" | "upgradeMode">>;
  readonly platform: Option.Option<UpgradePlatform>;
  readonly drain: (target: ReleaseVersion) => Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
}

export class ServerUpgrades extends Context.Service<
  ServerUpgrades,
  {
    readonly cancel: Effect.Effect<void, UpgradeError>;
    readonly polling: Effect.Effect<never>;
    readonly status: Effect.Effect<UpgradeView, UpgradeError>;
    readonly request: (request: UpgradeRequest) => Effect.Effect<void, UpgradeError>;
  }
>()("@usine/server/ServerUpgrades") {
  static readonly layer = (options: UpgradeOptions) =>
    Layer.effect(ServerUpgrades, makeUpgrades(options));
}

type Progress =
  | { readonly phase: "idle" }
  | {
      readonly phase: "waiting";
      readonly target: ReleaseVersion;
      readonly fiber: Fiber.Fiber<void>;
    }
  | { readonly phase: "installing"; readonly target: ReleaseVersion }
  | { readonly phase: "failed"; readonly message: string };

class UpgradeCandidate extends Schema.Class<UpgradeCandidate>("@usine/server/UpgradeCandidate")({
  channel: UpgradeChannel,
  version: ReleaseVersion,
}) {}

export const makeUpgrades = Effect.fn("Server.makeUpgrades")(function* (options: UpgradeOptions) {
  const bus = yield* ChangeBus;
  const changed = bus.publish([
    { audience: { _tag: "Instance" }, target: { kind: "configuration", id: "instance" } },
  ]);
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const canceled = yield* Ref.make(Option.none<ReleaseVersion>());
  const available = yield* Ref.make(Option.none<UpgradeCandidate>());
  const availableFor = (channel: UpgradeChannel) =>
    Ref.get(available).pipe(
      Effect.map((candidate) =>
        candidate.pipe(
          Option.filter((checked) => checked.channel === channel),
          Option.map((checked) => checked.version),
        ),
      ),
    );
  const progress = yield* Ref.make<Progress>({ phase: "idle" });
  const outcome = Option.match(options.platform, {
    onNone: () => Effect.succeed(Option.none<UpgradeRecord>()),
    onSome: (platform) => platform.outcome,
  });
  const status = Effect.fn("Server.upgradeStatus")(function* () {
    const settings = yield* options.settings;
    yield* Effect.annotateCurrentSpan({
      running: options.running,
      channel: settings.upgradeChannel,
      mode: settings.upgradeMode,
    });
    const current = yield* Ref.get(progress);
    const result = yield* outcome;
    const state =
      current.phase === "installing" &&
      Option.exists(
        result,
        (record) => record.target === current.target && record.status === "failed",
      )
        ? {
            phase: "failed" as const,
            message: "The upgrade helper failed. Restart the service to resume attempt admission.",
          }
        : current;
    const availableVersion =
      settings.upgradeMode === "off" ? Option.none() : yield* availableFor(settings.upgradeChannel);
    return UpgradeView.make({
      running: options.running,
      channel: settings.upgradeChannel,
      mode: settings.upgradeMode,
      supported: Option.isSome(options.platform),
      available: Option.getOrNull(availableVersion),
      phase: Option.exists(result, (record) => record.status === "installing")
        ? "installing"
        : state.phase,
      target: state.phase === "waiting" || state.phase === "installing" ? state.target : null,
      message:
        state.phase === "failed"
          ? state.message
          : state.phase === "waiting"
            ? `Waiting for admitted attempts to finish before upgrading to ${state.target}. New attempts are deferred and worker slots stay free. Cancel the pending upgrade to resume them.`
            : null,
      outcome: Option.getOrNull(result),
    });
  });

  const request = Effect.fn("Server.requestUpgrade")(
    function* (input: UpgradeRequest) {
      if (Option.isNone(options.platform)) {
        return yield* UpgradeError.make({
          message: "App upgrades require a global npm install managed by systemd.",
        });
      }
      const platform = options.platform.value;
      const settings = yield* options.settings;
      const latest = yield* availableFor(settings.upgradeChannel);
      const target = Option.orElse(input.version, () => latest);
      if (Option.isNone(target)) {
        yield* Effect.logInfo(
          "Server upgrade request rejected without a current channel candidate",
          {
            previous: options.running,
            channel: settings.upgradeChannel,
            timing: input.timing,
          },
        );
        return yield* UpgradeError.make({ message: "No newer version is available." });
      }
      yield* Effect.annotateCurrentSpan({
        previous: options.running,
        target: target.value,
        timing: input.timing,
      });
      const result = yield* outcome;
      if (Option.exists(result, (record) => record.status === "installing")) {
        return yield* UpgradeError.make({ message: "An upgrade is already in progress." });
      }
      if ((yield* Ref.get(progress)).phase !== "idle")
        return yield* UpgradeError.make({
          message:
            "An upgrade was already requested. Cancel it in Settings or with DELETE /api/upgrade while it is waiting.",
        });
      yield* platform.preflight.pipe(
        Effect.andThen(platform.checkDependencies(target.value)),
        Effect.tapError((error) =>
          Effect.logWarning("Upgrade preflight failed before draining", {
            previous: options.running,
            target: target.value,
            reason: error.message,
          }),
        ),
      );
      const work = Effect.gen(function* () {
        yield* Effect.logInfo("Server upgrade requested", {
          previous: options.running,
          target: target.value,
          timing: input.timing,
        });
        if (input.timing === "idle") yield* options.drain(target.value);
        yield* lock.withPermit(
          Effect.gen(function* () {
            yield* Ref.set(progress, { phase: "installing", target: target.value });
            yield* changed;
            yield* platform.launch(target.value);
          }),
        );
      }).pipe(
        Effect.catchTag("UpgradeError", (error) =>
          Effect.gen(function* () {
            yield* Ref.set(progress, {
              phase: "failed",
              message: `${error.message} Restart the service to resume attempt admission.`,
            });
            yield* changed;
            yield* Effect.logError("Server upgrade failed", {
              previous: options.running,
              target: target.value,
              reason: error.message,
            });
          }),
        ),
      );
      const fiber = yield* work.pipe(Effect.interruptible, Effect.forkIn(scope));
      yield* Ref.set(progress, { phase: "waiting", target: target.value, fiber });
      yield* changed;
    },
    (effect) => lock.withPermit(Effect.uninterruptible(effect)),
  );

  const cancel = Effect.fn("Server.cancelUpgrade")(
    function* () {
      const current = yield* Ref.get(progress);
      if (current.phase !== "waiting") {
        yield* Effect.logInfo("Upgrade cancellation rejected", { phase: current.phase });
        return yield* UpgradeError.make({
          message: "Only a waiting upgrade can be canceled. Installation may already have started.",
        });
      }
      yield* Effect.annotateCurrentSpan({ target: current.target });
      yield* Fiber.interrupt(current.fiber);
      yield* options.resume;
      yield* Ref.set(canceled, Option.some(current.target));
      yield* Ref.set(progress, { phase: "idle" });
      yield* changed;
      yield* Effect.logInfo("Pending server upgrade canceled; deferred runs can resume", {
        target: current.target,
      });
    },
    (effect) => lock.withPermit(Effect.uninterruptible(effect)),
  );

  const check = Effect.fn("Server.checkUpgrade")(function* () {
    const settings = yield* options.settings;
    if (settings.upgradeMode === "off" || Option.isNone(options.platform)) {
      const previous = yield* Ref.getAndSet(available, Option.none());
      if (Option.isSome(previous)) yield* changed;
      yield* Effect.logDebug("Server upgrade check skipped", {
        running: options.running,
        mode: settings.upgradeMode,
        supported: Option.isSome(options.platform),
      });
      return;
    }
    const target = yield* options.platform.value.lookup(settings.upgradeChannel);
    yield* Effect.annotateCurrentSpan({
      previous: options.running,
      target,
      channel: settings.upgradeChannel,
    });
    const newer = compareVersions(target, options.running) > 0;
    if (newer) yield* options.platform.value.checkDependencies(target);
    const candidate = newer
      ? Option.some(UpgradeCandidate.make({ channel: settings.upgradeChannel, version: target }))
      : Option.none();
    const previous = yield* Ref.getAndSet(available, candidate);
    if (!Equal.equals(previous, candidate)) yield* changed;
    yield* Effect.logInfo("Server upgrade check completed", {
      previous: options.running,
      target,
      channel: settings.upgradeChannel,
      newer,
    });
    const result = yield* outcome;
    const blocked = Option.exists(
      result,
      (record) =>
        record.status === "installing" ||
        (record.target === target &&
          (record.status === "failed" ||
            (record.status === "rolled-back" && record.failureStage !== "install"))),
    );
    const currentSettings = yield* options.settings;
    if (!newer) return;
    if (
      currentSettings.upgradeMode === "automatic" &&
      (yield* Ref.get(progress)).phase === "idle" &&
      !blocked
    ) {
      const canceledVersion = yield* Ref.get(canceled);
      if (!Option.contains(canceledVersion, target)) {
        yield* Effect.logInfo("Automatic server upgrade requested", {
          previous: options.running,
          target,
          outcome: result,
        });
        yield* request(UpgradeRequest.make({ timing: "idle", version: Option.none() }));
        return;
      }
    }
    const canceledVersion = yield* Ref.get(canceled);
    if (Option.contains(canceledVersion, target)) {
      yield* Effect.logInfo("Automatic upgrade skipped after operator cancellation", { target });
    } else if (blocked) {
      yield* Effect.logInfo("Automatic upgrade skipped after an unfinished or failed upgrade", {
        previous: options.running,
        target,
        outcome: result,
      });
    } else if (currentSettings.upgradeMode !== "automatic") {
      yield* Effect.logInfo("Automatic upgrade skipped for the current mode", {
        previous: options.running,
        target,
        mode: currentSettings.upgradeMode,
      });
    }
  });
  const polling = check().pipe(
    Effect.catchTag("UpgradeError", (error) =>
      Effect.logWarning("Server upgrade check failed", {
        previous: options.running,
        reason: error.message,
      }),
    ),
    Effect.andThen(Effect.sleep("5 minutes")),
    Effect.forever,
  );
  return { status: status(), request, cancel: cancel(), check, polling };
});
