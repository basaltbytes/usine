import type { FactoryConfigError } from "@usine/config/file";
import { InstanceFolder } from "@usine/config/instance-folder";
import type { LoadedInstance } from "@usine/config/instance";
import { AgentName } from "@usine/core/agent";
import type { InstanceDirectory } from "@usine/core/instance";
import { WorkerName } from "@usine/core/worker";
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
  InstanceReload,
  instanceReload,
  RestartBlock,
  type RestartChange,
  restartChanges,
} from "./changes.ts";

/** A reload changed `usine.yaml` in a way that needs a restart, so the running instance is kept. */
export class RestartRequiredError extends Schema.TaggedError<RestartRequiredError>(
  "@usine/orchestrator/RestartRequiredError",
)("RestartRequiredError", {
  blocks: Schema.NonEmptyArray(RestartBlock),
  /**
   * The changed fields as paths into `usine.yaml`, such as `webhooks` or
   * `workers.build-1.destination`.
   */
  fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** An operator summary of each change, stating that the running configuration is kept. */
  message: Schema.NonEmptyString,
}) {}

/** Returns the refusal for a reload that makes `changes`. */
export const restartRequired = (
  changes: EffectArray.NonEmptyReadonlyArray<RestartChange>,
): RestartRequiredError =>
  new RestartRequiredError({
    blocks: EffectArray.dedupe(EffectArray.map(changes, ({ block }) => block)),
    fields: EffectArray.map(changes, ({ field }) => field),
    message: `These usine.yaml changes require a restart: ${changes.map(({ reason }) => reason).join("; ")}. The running configuration is unchanged. Restart usine up to apply them.`,
  });

/**
 * A reload adds Workers, slots, or brains that failed Worker preflight, so the running instance is
 * kept.
 */
export class ReloadPreflightError extends Schema.TaggedError<ReloadPreflightError>(
  "@usine/orchestrator/ReloadPreflightError",
)("ReloadPreflightError", {
  /**
   * The reloaded Agents with brains that no running Agent has, which preflight checked on every
   * Worker.
   */
  agents: Schema.Array(AgentName),
  /**
   * The Workers added or given more slots by the reload, which preflight checked with every
   * rostered brain.
   */
  workers: Schema.Array(WorkerName),
  /**
   * An operator summary of the additions and the failed check, stating that the running
   * configuration is kept.
   */
  message: Schema.NonEmptyString,
  cause: ExecutorError,
}) {}

/**
 * Returns the refusal for a reload whose preflight of `agents` and `workers` failed with `cause`.
 */
export const reloadPreflightFailed = (
  agents: ReadonlyArray<AgentName>,
  workers: ReadonlyArray<WorkerName>,
  cause: ExecutorError,
): ReloadPreflightError => {
  const quoted = (names: ReadonlyArray<string>) => names.map((name) => `"${name}"`).join(", ");
  const subjects = [
    ...(agents.length === 0
      ? []
      : [`${agents.length === 1 ? "agent" : "agents"} ${quoted(agents)}`]),
    ...(workers.length === 0
      ? []
      : [
          `${workers.length === 1 ? "worker" : "workers"} ${quoted(workers)} (added or given more slots by the reload)`,
        ]),
  ];
  const detail =
    cause._tag === "WorkerCapabilityError"
      ? `Worker "${cause.worker}": ${cause.message}`
      : cause.message;
  const sentence = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`.replace(/\.$/u, "");
  return new ReloadPreflightError({
    agents,
    workers,
    message: `Worker preflight failed for ${subjects.join(" and ")}. ${sentence}. The running configuration is unchanged. Fix the worker, usine.yaml, or the agent file, then reload again.`,
    cause,
  });
};

/** The reason a reload kept the running instance. */
export type InstanceReloadError = FactoryConfigError | RestartRequiredError | ReloadPreflightError;

/**
 * Checks a reload from `running` to `loaded` without changing anything, and returns the effect that
 * applies `loaded`'s `workers` block. Fails on an unsupported `workers` change or a failed
 * preflight.
 */
export type WorkerReload = (
  running: LoadedInstance,
  loaded: LoadedInstance,
) => Effect.Effect<Effect.Effect<void>, RestartRequiredError | ReloadPreflightError>;

const rejectionLogFields = (error: InstanceReloadError) =>
  Match.valueTags(error, {
    FactoryConfigError: ({ _tag, file, stage, message }) => ({
      errorTag: _tag,
      file,
      stage,
      message,
    }),
    RestartRequiredError: ({ _tag, blocks, fields, message }) => ({
      errorTag: _tag,
      blocks,
      fields,
      message,
    }),
    ReloadPreflightError: ({ _tag, agents, workers, message, cause }) => ({
      errorTag: _tag,
      agents,
      workers,
      causeTag: cause._tag,
      message,
    }),
  });

/**
 * The instance folder snapshot that the orchestrator runs, replaced by each reload. Consumers read
 * it each time they act; a Run keeps the Agent, task, and parent model it opened with.
 */
export class CurrentInstance extends Context.Service<
  CurrentInstance,
  {
    /** The snapshot that new work reads. */
    readonly get: Effect.Effect<LoadedInstance>;
    /** The current snapshot, then each snapshot an accepted reload installs. */
    readonly changes: Stream.Stream<LoadedInstance>;
    /**
     * Reloads the instance folder, one reload at a time, and returns what changed. Fails and keeps
     * the running snapshot on an invalid `usine.yaml`, a changed `webhooks` or `tracing` block, or
     * a rejected `workers` change.
     */
    readonly reload: Effect.Effect<InstanceReload, InstanceReloadError>;
    /**
     * Routes each reload through `workers` until the scope closes. Without a registration, as in
     * setup mode, a reload rejects any `workers` change.
     */
    readonly registerWorkers: (workers: WorkerReload) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/orchestrator/CurrentInstance") {
  /**
   * Starts from `initial`, the folder that `usine up` loaded at startup, and reloads `directory`.
   */
  static readonly layer = (
    directory: InstanceDirectory,
    initial: LoadedInstance,
  ): Layer.Layer<CurrentInstance, never, InstanceFolder> =>
    Layer.effect(
      CurrentInstance,
      Effect.gen(function* () {
        const folder = yield* InstanceFolder;
        const current = yield* SubscriptionRef.make(initial);
        const registered = yield* Ref.make(Option.none<WorkerReload>());
        const reloading = yield* Semaphore.make(1);

        const beforeWorkersStart = Effect.fn("CurrentInstance.beforeWorkersStart")(function* (
          running: LoadedInstance,
          loaded: LoadedInstance,
        ) {
          const agents = agentsWithNewBrains(running, loaded).map(({ name }) => name);
          if (agents.length > 0) {
            yield* Effect.logInfo(
              "The reload adds brains before the Workers start; their startup preflight checks them",
              { agents },
            );
          }
          return Effect.void;
        });

        // Once the Workers have prepared the reload, it runs to completion, so their additions are
        // applied.
        const reload = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const running = yield* SubscriptionRef.get(current);
            const loaded = yield* restore(folder.load(directory));
            const workers = yield* Ref.get(registered);
            const restart = restartChanges(running, loaded, Option.isSome(workers));
            if (EffectArray.isReadonlyArrayNonEmpty(restart)) {
              return yield* restartRequired(restart);
            }
            const applyWorkers = yield* restore(
              Option.isSome(workers)
                ? workers.value(running, loaded)
                : beforeWorkersStart(running, loaded),
            );
            const changes = instanceReload(running, loaded);
            yield* SubscriptionRef.set(current, loaded).pipe(Effect.andThen(applyWorkers));
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
              workersAdded: changes.workers.added,
              workersRemoved: changes.workers.removed,
              workersChanged: changes.workers.changed,
              settingsChanged: changes.settingsChanged,
              operatorChanged: changes.operatorChanged,
              quarantinedLoops: changes.quarantinedLoops.map(({ file }) => file),
              invalidAgents: changes.invalidAgents.map(({ file }) => file),
            });
            return changes;
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Instance folder reload rejected; the running configuration is unchanged",
              rejectionLogFields(error),
            ),
          ),
          reloading.withPermits(1),
          Effect.withSpan("CurrentInstance.reload", { attributes: { directory } }),
        );

        const registerWorkers = (workers: WorkerReload) =>
          Effect.acquireRelease(Ref.set(registered, Option.some(workers)), () =>
            Ref.set(registered, Option.none()),
          );

        return {
          get: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current),
          reload,
          registerWorkers,
        };
      }),
    );
}

export { InstanceReload, RestartBlock } from "./changes.ts";
