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

/** A reload changed `usine.yaml` in a way that only a restart applies, so the running instance stays. */
export class RestartRequiredError extends Schema.TaggedError<RestartRequiredError>(
  "@usine/orchestrator/RestartRequiredError",
)("RestartRequiredError", {
  blocks: Schema.NonEmptyArray(RestartBlock),
  /** The changed fields, as paths into `usine.yaml` such as `webhooks` or `workers.build-1.destination`. */
  fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** A summary for operators: each change, and that the running configuration is kept. */
  message: Schema.NonEmptyString,
}) {}

/** The refusal of a reload that makes `changes`. */
export const restartRequired = (
  changes: EffectArray.NonEmptyReadonlyArray<RestartChange>,
): RestartRequiredError =>
  new RestartRequiredError({
    blocks: EffectArray.dedupe(EffectArray.map(changes, ({ block }) => block)),
    fields: EffectArray.map(changes, ({ field }) => field),
    message: `usine.yaml changed in a way that applies only when usine up restarts: ${changes.map(({ reason }) => reason).join("; ")}. The running configuration is unchanged; restart usine up to apply the change.`,
  });

/** A reload adds Workers, slots, or brains that failed Worker preflight, so the running instance stays. */
export class ReloadPreflightError extends Schema.TaggedError<ReloadPreflightError>(
  "@usine/orchestrator/ReloadPreflightError",
)("ReloadPreflightError", {
  /** The reloaded Agents whose brains no running Agent has; preflight checked their brains on every Worker. */
  agents: Schema.Array(AgentName),
  /** The Workers the reload adds or gives more slots; preflight checked each with every rostered brain. */
  workers: Schema.Array(WorkerName),
  /** A summary for operators: what the reload adds, the failed Worker check, and that the running configuration is kept. */
  message: Schema.NonEmptyString,
  /** The Worker preflight failure the executor reported. */
  cause: ExecutorError,
}) {}

/** The refusal of a reload whose preflight of `agents` and `workers` failed with `cause`. */
export const reloadPreflightFailed = (
  agents: ReadonlyArray<AgentName>,
  workers: ReadonlyArray<WorkerName>,
  cause: ExecutorError,
): ReloadPreflightError => {
  const subjects = [
    ...(agents.length === 0
      ? []
      : [`${agents.length === 1 ? "Agent" : "Agents"} ${agents.join(", ")}`]),
    ...(workers.length === 0
      ? []
      : [
          `${workers.length === 1 ? "Worker" : "Workers"} ${workers.join(", ")}, which the reload adds or gives more slots`,
        ]),
  ];
  const detail =
    cause._tag === "WorkerCapabilityError"
      ? `Worker ${cause.worker}: ${cause.message}`
      : cause.message;
  return new ReloadPreflightError({
    agents,
    workers,
    message: `Worker preflight failed for ${subjects.join(" and ")}. ${detail.replace(/\.$/u, "")}. The running configuration is unchanged; fix the Worker, usine.yaml, or the Agent file, then reload again.`,
    cause,
  });
};

/** Why a reload kept the running instance. */
export type InstanceReloadError = FactoryConfigError | RestartRequiredError | ReloadPreflightError;

/**
 * How the Workers that run Attempts take a reload from `running` to `loaded`.
 * It refuses a `workers` change they cannot apply, and preflights the Workers,
 * slots, and brains the reload adds, without changing anything. It succeeds
 * with the effect that makes the Workers run `loaded`'s `workers` block, which
 * the reload runs once it has replaced the snapshot.
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
     * changed. An invalid `usine.yaml` or a changed `webhooks` block rejects
     * the reload and keeps the running snapshot. The registered Workers
     * decide which `workers` changes they take and preflight what the reload
     * adds; without them, any `workers` change rejects the reload. Reloads
     * run one at a time, and each outcome is logged.
     */
    readonly reload: Effect.Effect<InstanceReload, InstanceReloadError>;
    /**
     * Makes each reload, until the scope closes, go through `workers`. Before
     * a registration, as in setup mode where no Worker runs Attempts, a
     * reload refuses any `workers` change and checks no brain.
     */
    readonly registerWorkers: (workers: WorkerReload) => Effect.Effect<void, never, Scope.Scope>;
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

        // Once the Workers have prepared the reload, it runs to the end, so what they added is applied.
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
