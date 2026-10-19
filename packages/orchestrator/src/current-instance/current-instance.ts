import type { FactoryConfigError } from "@usine/config/file";
import { InstanceFolder } from "@usine/config/instance-folder";
import type { LoadedInstance } from "@usine/config/instance";
import { AgentName } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { ExecutorError } from "@usine/executor";
import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from "effect";
import {
  agentsWithNewBrains,
  changedRestartBlocks,
  InstanceReload,
  instanceReload,
  RestartBlock,
} from "./changes.ts";

/** A reload found a restart-only block of `usine.yaml` changed, so the running instance stays. */
export class RestartRequiredError extends Schema.TaggedError<RestartRequiredError>(
  "@usine/orchestrator/RestartRequiredError",
)("RestartRequiredError", {
  blocks: Schema.NonEmptyArray(RestartBlock),
  message: Schema.NonEmptyString,
}) {}

/** A reload adds brains that failed Worker preflight, so the running instance stays. */
export class ReloadPreflightError extends Schema.TaggedError<ReloadPreflightError>(
  "@usine/orchestrator/ReloadPreflightError",
)("ReloadPreflightError", {
  /** The reloaded Agents whose brains no running Agent has; preflight checked their brains together. */
  agents: Schema.NonEmptyArray(AgentName),
  /** A summary for operators: the Agents, the failed Worker check, and that the running configuration is kept. */
  message: Schema.NonEmptyString,
  /** The Worker preflight failure the executor reported. */
  cause: ExecutorError,
}) {}

/** Why a reload kept the running instance. */
export type InstanceReloadError = FactoryConfigError | RestartRequiredError | ReloadPreflightError;

/**
 * Verifies `brains` on every Worker that runs Attempts, with the verify-only
 * preflight `usine up` runs at startup, and fails with the first Worker's error.
 */
export type WorkerPreflight = (
  brains: EffectArray.NonEmptyReadonlyArray<BrainSpec>,
) => Effect.Effect<void, ExecutorError>;

const restartMessage = (blocks: EffectArray.NonEmptyReadonlyArray<RestartBlock>): string =>
  `The ${blocks.join(" and ")} ${blocks.length === 1 ? "block" : "blocks"} of usine.yaml changed, and ${blocks.length === 1 ? "it applies" : "they apply"} only when usine up restarts. The running configuration is unchanged; restart usine up to apply the change.`;

const preflightMessage = (
  agents: EffectArray.NonEmptyReadonlyArray<AgentName>,
  error: ExecutorError,
): string => {
  const detail =
    error._tag === "WorkerCapabilityError"
      ? `Worker ${error.worker}: ${error.message}`
      : error.message;
  return `Worker preflight failed for ${agents.length === 1 ? "Agent" : "Agents"} ${agents.join(", ")}. ${detail.replace(/\.$/u, "")}. The running configuration is unchanged; fix the Worker or the Agent file, then reload again.`;
};

const rejectionLogFields = (error: InstanceReloadError) =>
  Match.valueTags(error, {
    FactoryConfigError: ({ _tag, file, stage, message }) => ({
      errorTag: _tag,
      file,
      stage,
      message,
    }),
    RestartRequiredError: ({ _tag, blocks, message }) => ({ errorTag: _tag, blocks, message }),
    ReloadPreflightError: ({ _tag, agents, message, cause }) => ({
      errorTag: _tag,
      agents,
      causeTag: cause._tag,
      message,
    }),
  });

/**
 * The instance folder the orchestrator runs, as one snapshot that a reload
 * replaces. Polling, schedules, queued-Event checks, GitHub App project
 * discovery, Attempt settings, and the operator surface read it each time
 * they act, so a reload applies from their next cycle, check, or Attempt.
 * A Run keeps the Agent, task, and parent model it was opened with.
 */
export class CurrentInstance extends Context.Service<
  CurrentInstance,
  {
    /** The snapshot that new work reads. */
    readonly get: Effect.Effect<LoadedInstance>;
    /** The snapshot that new work reads, then each snapshot an accepted reload puts in its place. */
    readonly changes: Stream.Stream<LoadedInstance>;
    /**
     * Loads the instance folder again with the startup loader and its
     * per-file quarantine, then replaces the snapshot and reports what
     * changed. An invalid `usine.yaml`, or a `workers` or `webhooks` block
     * that differs from the running one, rejects the reload and keeps the
     * running snapshot. When the reloaded Agents have brains that no running
     * Agent has, the registered Worker preflight checks them first, and a
     * failure rejects the reload with `ReloadPreflightError`. Reloads run one
     * at a time, and each outcome is logged.
     */
    readonly reload: Effect.Effect<InstanceReload, InstanceReloadError>;
    /**
     * Makes each reload, until the scope closes, check the brains it adds
     * with `preflight`. Before a registration, as in setup mode where no
     * Worker runs Attempts, a reload checks no brain.
     */
    readonly registerPreflight: (
      preflight: WorkerPreflight,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/orchestrator/CurrentInstance") {
  /** Starts from `initial`, the folder `usine up` loaded at startup, and reloads `directory`. */
  static readonly layer = (
    directory: InstanceDirectory,
    initial: LoadedInstance,
  ): Layer.Layer<CurrentInstance, never, InstanceFolder> =>
    Layer.effect(
      CurrentInstance,
      Effect.gen(function* () {
        const folder = yield* InstanceFolder;
        const current = yield* SubscriptionRef.make(initial);
        const registered = yield* Ref.make(Option.none<WorkerPreflight>());
        const reloading = yield* Semaphore.make(1);

        const preflightNewBrains = Effect.fn("CurrentInstance.preflightNewBrains")(function* (
          running: LoadedInstance,
          loaded: LoadedInstance,
        ) {
          const added = agentsWithNewBrains(running, loaded);
          if (!EffectArray.isReadonlyArrayNonEmpty(added)) {
            yield* Effect.logDebug("The reload adds no brain, so it runs no Worker preflight");
            return;
          }
          const agents = EffectArray.map(added, ({ name }) => name);
          const brains = EffectArray.dedupe(EffectArray.map(added, ({ agent }) => agent.brain));
          yield* Effect.annotateCurrentSpan({ agents });
          const preflight = yield* Ref.get(registered);
          if (Option.isNone(preflight)) {
            yield* Effect.logInfo(
              "The reload adds brains before the Workers start; their startup preflight checks them",
              { agents },
            );
            return;
          }
          yield* Effect.logInfo("Preflighting the brains the reload adds on every Worker", {
            agents,
            brains: brains.map(({ harness, model, effort }) => `${harness}/${model}/${effort}`),
          });
          yield* preflight.value(brains).pipe(
            Effect.mapError(
              (cause) =>
                new ReloadPreflightError({
                  agents,
                  message: preflightMessage(agents, cause),
                  cause,
                }),
            ),
          );
        });

        const reload = Effect.gen(function* () {
          const running = yield* SubscriptionRef.get(current);
          const loaded = yield* folder.load(directory);
          const blocks = changedRestartBlocks(running, loaded);
          if (EffectArray.isReadonlyArrayNonEmpty(blocks)) {
            return yield* new RestartRequiredError({ blocks, message: restartMessage(blocks) });
          }
          yield* preflightNewBrains(running, loaded);
          const changes = instanceReload(running, loaded);
          yield* SubscriptionRef.set(current, loaded);
          yield* Effect.logInfo("Instance folder reloaded; new Runs use the new configuration", {
            loopsAdded: changes.loops.added,
            loopsRemoved: changes.loops.removed,
            loopsChanged: changes.loops.changed,
            agentsAdded: changes.agents.added,
            agentsRemoved: changes.agents.removed,
            agentsChanged: changes.agents.changed,
            labelsAdded: changes.labels.added,
            labelsRemoved: changes.labels.removed,
            labelsChanged: changes.labels.changed,
            reposAdded: changes.repos.added,
            reposRemoved: changes.repos.removed,
            reposChanged: changes.repos.changed,
            settingsChanged: changes.settingsChanged,
            operatorChanged: changes.operatorChanged,
            quarantinedLoops: changes.quarantinedLoops.map(({ file }) => file),
            invalidAgents: changes.invalidAgents.map(({ file }) => file),
          });
          return changes;
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Instance folder reload rejected; the running configuration is unchanged",
              rejectionLogFields(error),
            ),
          ),
          reloading.withPermits(1),
          Effect.withSpan("CurrentInstance.reload", { attributes: { directory } }),
        );

        const registerPreflight = (preflight: WorkerPreflight) =>
          Effect.acquireRelease(Ref.set(registered, Option.some(preflight)), () =>
            Ref.set(registered, Option.none()),
          );

        return {
          get: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current),
          reload,
          registerPreflight,
        };
      }),
    );
}

export { InstanceReload, RestartBlock } from "./changes.ts";
