import { ChangeBus } from "@usine/core/changes";
import { ConfigParser } from "@usine/config/parser";
import { InvalidAgent } from "@usine/config/agent";
import { QuarantinedLoop, loopPath } from "@usine/config/loop";
import { ConfigFileError, FactoryConfigError, InstancePath } from "@usine/config/file";
import {
  Configuration,
  ConfigurationStore,
  commit,
  replay,
  type ConfigurationRevisionNumber,
  type ConfigurationCommit,
  type ConfigurationRevision,
  type ConfigurationInvalid,
  type ConfigurationStoreError,
  type StaleRevision,
} from "@usine/config/configuration";
import { LoadedInstance, logConfigWarnings } from "@usine/config/instance";
import { AgentName } from "@usine/core/agent";
import type { InstanceDirectory } from "@usine/core/instance";
import { WorkerName } from "@usine/core/worker";
import { ExecutorError } from "@usine/executor";
import {
  type Brand,
  Array as EffectArray,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  Stream,
  Schedule,
  SubscriptionRef,
} from "effect";
import {
  agentsWithNewBrains,
  reloadAudiences,
  InstanceReload,
  instanceReload,
  RestartBlock,
  type RestartChange,
  restartChanges,
} from "./changes.ts";
import { afterRunning, RevisionStep, timedStep } from "./steps.ts";

/** A reload changed `usine.yaml` in a way that needs a restart, so the running instance is kept. */
export class RestartRequiredError extends Schema.TaggedError<
  RestartRequiredError,
  Brand.Brand<"@usine/orchestrator/current-instance/current-instance/RestartRequiredError">
>("@usine/orchestrator/RestartRequiredError")("RestartRequiredError", {
  /** The configuration blocks whose changes require an orchestrator restart. */
  blocks: Schema.NonEmptyArray(RestartBlock),
  /**
   * The changed fields as paths into `usine.yaml`, such as `tracing` or
   * `workers.build-1.kind`.
   */
  fields: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** An operator summary of each change, stating that the running configuration is kept. */
  message: Schema.NonEmptyString,
}) {}

/** Returns the refusal for a reload that makes `changes`. */
export const restartRequired = (
  changes: EffectArray.NonEmptyReadonlyArray<RestartChange>,
): RestartRequiredError =>
  RestartRequiredError.make({
    blocks: EffectArray.dedupe(EffectArray.map(changes, ({ block }) => block)),
    fields: EffectArray.map(changes, ({ field }) => field),
    message: `These usine.yaml changes require a restart: ${changes.map(({ reason }) => reason).join("; ")}. The running configuration is unchanged. Restart usine up to apply them.`,
  });

/**
 * A reload adds workers or brains, or changes slots, that failed worker preflight, so the running instance is
 * kept.
 */
export class ReloadPreflightError extends Schema.TaggedError<
  ReloadPreflightError,
  Brand.Brand<"@usine/orchestrator/current-instance/current-instance/ReloadPreflightError">
>("@usine/orchestrator/ReloadPreflightError")("ReloadPreflightError", {
  /**
   * The reloaded Agents with brains that no running Agent has, which preflight checked on every
   * Worker.
   */
  agents: Schema.Array(AgentName),
  /**
   * The workers added or resized by the reload, which preflight checked with every
   * rostered brain.
   */
  workers: Schema.Array(WorkerName),
  /**
   * An operator summary of the additions and the failed check, stating that the running
   * configuration is kept.
   */
  message: Schema.NonEmptyString,
  /** The worker or credential failure that prevented the reload. */
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
  return ReloadPreflightError.make({
    agents,
    workers,
    message: `Worker preflight failed for ${subjects.join(" and ")}. ${sentence}. The running configuration is unchanged. Fix the worker, usine.yaml, or the agent file, then reload again.`,
    cause,
  });
};

/** The longest wait for the coordinator brain check before a save or reload is refused. */
export const coordinatorBrainTimeout = Duration.seconds(10);

/** A step of a save or reload didn't finish in time, so nothing was stored or applied. */
export class ValidationTimeoutError extends Schema.TaggedError<
  ValidationTimeoutError,
  Brand.Brand<"@usine/orchestrator/current-instance/current-instance/ValidationTimeoutError">
>("@usine/orchestrator/ValidationTimeoutError")("ValidationTimeoutError", {
  /** The step that ran out of time. */
  step: RevisionStep,
  /** An operator summary of the timeout, stating that the running configuration is kept. */
  message: Schema.NonEmptyString,
}) {}

/**
 * Runs `check` as the `coordinator-brains` step. Fails with `ValidationTimeoutError` when it runs
 * longer than `coordinatorBrainTimeout`, and with `refuse(problems)` when it refuses a brain, so
 * a refused brain logs the step as `failed`.
 */
export const checkCoordinatorBrains = <E, R, F>(
  check: Effect.Effect<ReadonlyArray<ConfigFileError>, E, R>,
  refuse: (problems: EffectArray.NonEmptyReadonlyArray<ConfigFileError>) => F,
): Effect.Effect<void, E | F | ValidationTimeoutError, R> =>
  timedStep(
    "coordinator-brains",
    check.pipe(
      Effect.timeoutOrElse({
        duration: coordinatorBrainTimeout,
        orElse: () =>
          Effect.fail(
            ValidationTimeoutError.make({
              step: "coordinator-brains",
              message: `The coordinator brain check didn't finish within ${Duration.toSeconds(coordinatorBrainTimeout)} seconds. The running configuration is unchanged. Check that the model provider responds, then try again.`,
            }),
          ),
      }),
      Effect.flatMap((problems) =>
        EffectArray.isReadonlyArrayNonEmpty(problems) ? Effect.fail(refuse(problems)) : Effect.void,
      ),
    ),
  );

/** The reason a reload kept the running instance. */
export type InstanceReloadError =
  | FactoryConfigError
  | RestartRequiredError
  | ReloadPreflightError
  | ValidationTimeoutError;

/**
 * Prepares a reload from `running` to `loaded` and returns the effect that applies its workers.
 * The caller must apply it within the scope; failure releases prepared workers.
 */
export type WorkerReload = (
  running: LoadedInstance,
  loaded: LoadedInstance,
) => Effect.Effect<Effect.Effect<void>, RestartRequiredError | ReloadPreflightError, Scope.Scope>;

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
    ValidationTimeoutError: ({ _tag, step, message }) => ({ errorTag: _tag, step, message }),
  });

/**
 * The stored configuration snapshot that the orchestrator runs, replaced by each reload. Consumers read
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
     * Re-reads the configuration store, one reload at a time, and returns what changed. Fails and keeps
     * the running snapshot on an unreadable store, a changed `tracing` or `auth` block, or
     * a rejected `workers` change.
     */
    readonly reload: Effect.Effect<InstanceReload, InstanceReloadError>;
    /** Checks runtime compatibility before storing and applying a revision. */
    readonly commit: (
      request: ConfigurationCommit,
    ) => Effect.Effect<
      ConfigurationRevision,
      InstanceReloadError | ConfigurationInvalid | ConfigurationStoreError | StaleRevision
    >;
    /**
     * Routes each reload through `workers` until the scope closes. Without a registration, as in
     * setup mode, a reload rejects any `workers` change.
     */
    readonly registerWorkers: (workers: WorkerReload) => Effect.Effect<void, never, Scope.Scope>;
    /** Quarantines startup refusals and checks later revisions until the scope closes. */
    readonly registerParentAdmission: (
      admit: (loaded: LoadedInstance) => Effect.Effect<ReadonlyArray<ConfigFileError>>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@usine/orchestrator/current-instance/current-instance/CurrentInstance") {
  /**
   * Starts from the imported or stored configuration and follows revisions after `after`.
   */
  static readonly layer = (
    directory: InstanceDirectory,
    initial: LoadedInstance,
    after: ConfigurationRevisionNumber,
  ): Layer.Layer<CurrentInstance, never, ConfigurationStore | ConfigParser> =>
    Layer.effect(
      CurrentInstance,
      Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const store = yield* ConfigurationStore;
        const parser = yield* ConfigParser;
        const observed = yield* Ref.make(
          Configuration.make({ number: after, instance: Option.some(initial) }),
        );
        const current = yield* SubscriptionRef.make(initial);
        const registered = yield* Ref.make(Option.none<WorkerReload>());
        const parentAdmission = yield* Ref.make<
          (loaded: LoadedInstance) => Effect.Effect<ReadonlyArray<ConfigFileError>>
        >(() => Effect.succeed([]));
        const reloading = yield* Semaphore.make(1);
        yield* logConfigWarnings(initial.warnings);

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
          // The caller applies this prepared reload after validation.
          // @effect-diagnostics-next-line returnEffectInGen:off
          return Effect.void;
        });

        const prepare = (snapshot: Configuration) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const running = yield* SubscriptionRef.get(current);
              if (Option.isNone(snapshot.instance))
                return yield* FactoryConfigError.make({
                  file: InstancePath.make(".usine/runtime.sqlite"),
                  stage: "read",
                  message: "The configuration store has not been initialized",
                });
              const loaded = snapshot.instance.value;
              yield* Effect.annotateCurrentSpan({ revision: snapshot.number });
              const workers = yield* Ref.get(registered);
              yield* timedStep(
                "restart",
                Effect.suspend(() => {
                  const restart = restartChanges(running, loaded, Option.isSome(workers));
                  return EffectArray.isReadonlyArrayNonEmpty(restart)
                    ? Effect.fail(restartRequired(restart))
                    : Effect.void;
                }),
              );
              const admit = yield* Ref.get(parentAdmission);
              yield* restore(
                checkCoordinatorBrains(admit(loaded), ([problem]) =>
                  FactoryConfigError.make({
                    file: problem.file,
                    stage: problem.stage,
                    message: `${problem.message}. The running configuration is unchanged.`,
                  }),
                ),
              );
              const applyWorkers = yield* timedStep(
                "worker-preflight",
                restore(
                  Option.isSome(workers)
                    ? workers.value(running, loaded)
                    : beforeWorkersStart(running, loaded),
                ),
              );
              const changes = instanceReload(running, loaded);
              // The caller applies this prepared reload after validation.
              // @effect-diagnostics-next-line returnEffectInGen:off
              return Effect.gen(function* () {
                yield* Ref.set(observed, snapshot);
                yield* SubscriptionRef.set(current, loaded).pipe(Effect.andThen(applyWorkers));
                yield* bus.publish(
                  reloadAudiences(changes).map((audience) => ({
                    audience,
                    target: { kind: "configuration", id: "instance" },
                  })),
                );
                yield* logConfigWarnings(loaded.warnings);
                yield* Effect.logInfo(
                  "Stored configuration applied; new runs use the new configuration",
                  {
                    loopsAdded: changes.loops.added,
                    loopsRemoved: changes.loops.removed,
                    loopsChanged: changes.loops.changed,
                    agentsAdded: changes.agents.added,
                    agentsRemoved: changes.agents.removed,
                    agentsChanged: changes.agents.changed,
                    labelsAdded: changes.labels.added,
                    labelsRemoved: changes.labels.removed,
                    labelsChanged: changes.labels.changed,
                    projectsAdded: changes.projects.added,
                    projectsRemoved: changes.projects.removed,
                    projectsChanged: changes.projects.changed,
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
                  },
                );
                return changes;
              });
            }),
          ).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Configuration revision could not be applied; the running configuration is unchanged",
                rejectionLogFields(error),
              ),
            ),
            Effect.withSpan("CurrentInstance.install", { attributes: { directory } }),
          );

        const install = (snapshot: Configuration) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* Ref.set(observed, snapshot);
              const apply = yield* restore(prepare(snapshot));
              return yield* timedStep("apply", apply);
            }),
          ).pipe(Effect.scoped);

        const commitRevision = Effect.fn("CurrentInstance.commit")(
          (request: ConfigurationCommit) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ expectedRevision: request.expected });
                const snapshot = yield* timedStep("read", store.read);
                const time = yield* DateTime.now;
                const candidate = yield* timedStep(
                  "parse",
                  commit(parser, snapshot, request.expected, request.changes, {
                    actor: request.actor,
                    message: request.message,
                    time,
                  }),
                );
                const apply = yield* restore(prepare(candidate.configuration));
                const revision = yield* timedStep("store", store.commit(request));
                yield* timedStep("apply", apply);
                return revision;
              }),
            ).pipe(Effect.scoped, afterRunning(reloading)),
          Effect.tapError((error) =>
            Effect.logWarning("Configuration write refused", {
              errorTag: error._tag,
            }),
          ),
        );

        const reload = store.read.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not re-read the configuration store", {
              operation: error.operation,
              cause: error.cause,
            }),
          ),
          Effect.mapError(() =>
            FactoryConfigError.make({
              file: InstancePath.make(".usine/runtime.sqlite"),
              stage: "read",
              message: "Could not read the configuration store",
            }),
          ),
          (read) => timedStep("read", read),
          Effect.flatMap(install),
          afterRunning(reloading),
          Effect.withSpan("CurrentInstance.reload", { attributes: { directory } }),
        );

        yield* store.changes(after).pipe(
          Stream.runForEach((revision) =>
            Effect.gen(function* () {
              const previous = yield* Ref.get(observed);
              if (revision.number <= previous.number) return;
              // The store accepted this revision, so replay it as stored.
              const next = yield* replay(
                parser,
                previous,
                previous.number,
                revision.changes,
                revision,
              );
              yield* install(next.configuration).pipe(
                Effect.catchTags({
                  FactoryConfigError: () => Effect.void,
                  RestartRequiredError: () => Effect.void,
                  ReloadPreflightError: () => Effect.void,
                  ValidationTimeoutError: () => Effect.void,
                }),
              );
            }).pipe(reloading.withPermits(1)),
          ),
          Effect.tapError((error) =>
            Effect.logWarning("Configuration revision stream failed; retrying", {
              errorTag: error._tag,
            }),
          ),
          Effect.retry(Schedule.spaced("1 second")),
          Effect.forkScoped,
        );

        const registerWorkers = (workers: WorkerReload) =>
          Effect.acquireRelease(Ref.set(registered, Option.some(workers)), () =>
            Ref.set(registered, Option.none()),
          );

        return {
          get: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current),
          reload,
          commit: commitRevision,
          registerWorkers,
          registerParentAdmission: Effect.fn("CurrentInstance.registerParentAdmission")(function* (
            admit: (loaded: LoadedInstance) => Effect.Effect<ReadonlyArray<ConfigFileError>>,
          ) {
            yield* Effect.annotateCurrentSpan({ directory });
            yield* Effect.acquireRelease(Ref.set(parentAdmission, admit), () =>
              Ref.set(parentAdmission, () => Effect.succeed([])),
            );
            yield* Effect.gen(function* () {
              const loaded = yield* SubscriptionRef.get(current);
              const problems = yield* timedStep("coordinator-brains", admit(loaded));
              if (problems.length === 0) return;
              const refused = new Set(problems.map(({ file }) => file));
              const agents = loaded.agents.filter(
                ({ name }) => !refused.has(InstancePath.make(`agents/${name}.md`)),
              );
              const names = new Set(agents.map(({ name }) => name));
              const loops = loaded.loops.filter((loop) => names.has(loop.agent));
              const quarantined = loaded.loops.filter((loop) => !names.has(loop.agent));
              yield* SubscriptionRef.set(
                current,
                LoadedInstance.make({
                  ...loaded,
                  agents,
                  loops,
                  invalidAgents: [
                    ...loaded.invalidAgents,
                    ...problems.map((error) => InvalidAgent.make({ file: error.file, error })),
                  ],
                  quarantinedLoops: [
                    ...loaded.quarantinedLoops,
                    ...quarantined.map((loop) => {
                      const file = loopPath(loop.name);
                      return QuarantinedLoop.make({
                        file,
                        error: ConfigFileError.make({
                          file,
                          stage: "reference",
                          expression: Option.none(),
                          message: `Agent "${loop.agent}" cannot run as coordinator. Correct its parent configuration and reload.`,
                        }),
                      });
                    }),
                  ],
                }),
              );
              yield* Effect.logWarning(
                "Coordinator admission quarantined agents and loops at startup",
                {
                  agents: problems.map(({ file }) => file),
                  loops: quarantined.map(({ name }) => name),
                },
              );
            }).pipe(reloading.withPermits(1));
          }),
        };
      }),
    );
}

export { InstanceReload, RestartBlock } from "./changes.ts";
