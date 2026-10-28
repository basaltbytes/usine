import type { Settings } from "@usine/config/factory";
import { ReleaseVersion, type UpgradeChannel, type UpgradeRecord } from "@usine/core/upgrade";
import { UpgradeRequest, UpgradeView } from "@usine/orchestrator/operator/http";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { compareVersions } from "../instance/manifest.ts";

export class UpgradeError extends Schema.TaggedError<UpgradeError>("@usine/server/UpgradeError")(
  "UpgradeError",
  { message: Schema.String },
) {}

export interface UpgradePlatform {
  readonly lookup: (channel: UpgradeChannel) => Effect.Effect<ReleaseVersion, UpgradeError>;
  readonly preflight: Effect.Effect<void, UpgradeError>;
  readonly launch: (target: ReleaseVersion) => Effect.Effect<void, UpgradeError>;
  readonly outcome: Effect.Effect<Option.Option<UpgradeRecord>, UpgradeError>;
}

interface UpgradeOptions {
  readonly running: string;
  readonly settings: Effect.Effect<Pick<Settings, "upgradeChannel" | "upgradeMode">>;
  readonly platform: Option.Option<UpgradePlatform>;
  readonly drain: Effect.Effect<void>;
}

export class ServerUpgrades extends Context.Service<
  ServerUpgrades,
  {
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
  | { readonly phase: "waiting" | "installing"; readonly target: ReleaseVersion }
  | { readonly phase: "failed"; readonly message: string };

export const makeUpgrades = Effect.fn("Server.makeUpgrades")(function* (options: UpgradeOptions) {
  const scope = yield* Effect.scope;
  const available = yield* Ref.make(Option.none<ReleaseVersion>());
  const progress = yield* Ref.make<Progress>({ phase: "idle" });
  const checkError = yield* Ref.make(Option.none<string>());
  const outcome = Option.match(options.platform, {
    onNone: () => Effect.succeed(Option.none<UpgradeRecord>()),
    onSome: (platform) => platform.outcome,
  });
  const status = Effect.gen(function* () {
    const settings = yield* options.settings;
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
    return new UpgradeView({
      running: options.running,
      channel: settings.upgradeChannel,
      mode: settings.upgradeMode,
      supported: Option.isSome(options.platform),
      available:
        settings.upgradeMode === "off" ? null : Option.getOrNull(yield* Ref.get(available)),
      phase: Option.exists(result, (record) => record.status === "installing")
        ? "installing"
        : state.phase,
      message:
        state.phase === "failed" ? state.message : Option.getOrNull(yield* Ref.get(checkError)),
      outcome: Option.getOrNull(result),
    });
  });

  const request = Effect.fn("Server.requestUpgrade")(function* (input: UpgradeRequest) {
    if (Option.isNone(options.platform)) {
      return yield* new UpgradeError({
        message: "App upgrades require a global npm install managed by systemd.",
      });
    }
    const platform = options.platform.value;
    const latest = yield* Ref.get(available);
    const target = Option.orElse(input.version, () => latest);
    if (Option.isNone(target))
      return yield* new UpgradeError({ message: "No newer version is available." });
    yield* Effect.annotateCurrentSpan({
      previous: options.running,
      target: target.value,
      timing: input.timing,
    });
    const result = yield* outcome;
    if (Option.exists(result, (record) => record.status === "installing")) {
      return yield* new UpgradeError({ message: "An upgrade is already in progress." });
    }
    const claimed = yield* Ref.modify(progress, (state) =>
      state.phase === "idle"
        ? ([true, { phase: "waiting", target: target.value } satisfies Progress] as const)
        : ([false, state] as const),
    );
    if (!claimed)
      return yield* new UpgradeError({
        message: "An upgrade was already requested. Restart the service if it failed.",
      });
    yield* platform.preflight.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Upgrade preflight failed before draining", {
          previous: options.running,
          target: target.value,
          reason: error.message,
        }).pipe(Effect.andThen(Ref.set(progress, { phase: "idle" }))),
      ),
    );
    const work = Effect.gen(function* () {
      yield* Effect.logInfo("Server upgrade requested", {
        previous: options.running,
        target: target.value,
        timing: input.timing,
      });
      if (input.timing === "idle") yield* options.drain;
      yield* Ref.set(progress, { phase: "installing", target: target.value });
      yield* platform.launch(target.value);
    }).pipe(
      Effect.catchTag("UpgradeError", (error) =>
        Effect.gen(function* () {
          yield* Ref.set(progress, {
            phase: "failed",
            message: `${error.message} Restart the service to resume attempt admission.`,
          });
          yield* Effect.logError("Server upgrade failed", {
            previous: options.running,
            target: target.value,
            reason: error.message,
          });
        }),
      ),
    );
    yield* work.pipe(Effect.forkIn(scope));
  }, Effect.uninterruptible);

  const check = Effect.fn("Server.checkUpgrade")(function* () {
    const settings = yield* options.settings;
    if (settings.upgradeMode === "off" || Option.isNone(options.platform)) {
      yield* Ref.set(available, Option.none());
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
    yield* Ref.set(checkError, Option.none());
    const newer = compareVersions(target, options.running) > 0;
    yield* Ref.set(available, newer ? Option.some(target) : Option.none());
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
        record.status === "installing" || (record.target === target && record.status !== "good"),
    );
    if (
      newer &&
      settings.upgradeMode === "automatic" &&
      (yield* Ref.get(progress)).phase === "idle" &&
      !blocked
    ) {
      yield* request(new UpgradeRequest({ timing: "idle", version: Option.some(target) }));
    } else if (newer && blocked) {
      yield* Effect.logInfo("Automatic upgrade skipped after an unfinished or failed upgrade", {
        previous: options.running,
        target,
        outcome: result,
      });
    }
  });
  const polling = check().pipe(
    Effect.catchTag("UpgradeError", (error) =>
      Effect.gen(function* () {
        yield* Ref.set(checkError, Option.some(error.message));
        yield* Effect.logWarning("Server upgrade check failed", {
          previous: options.running,
          reason: error.message,
        });
      }),
    ),
    Effect.andThen(Effect.sleep("5 minutes")),
    Effect.forever,
  );
  return { status, request, check, polling };
});
