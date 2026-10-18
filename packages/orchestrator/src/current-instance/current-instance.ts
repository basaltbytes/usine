import type { FactoryConfigError } from "@usine/config/file";
import { InstanceFolder } from "@usine/config/instance-folder";
import type { LoadedInstance } from "@usine/config/instance";
import type { InstanceDirectory } from "@usine/core/instance";
import {
  Array as EffectArray,
  Context,
  Effect,
  Layer,
  Match,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import { changedRestartBlocks, InstanceReload, instanceReload, RestartBlock } from "./changes.ts";

/** A reload found a restart-only block of `usine.yaml` changed, so the running instance stays. */
export class RestartRequiredError extends Schema.TaggedError<RestartRequiredError>(
  "@usine/orchestrator/RestartRequiredError",
)("RestartRequiredError", {
  blocks: Schema.NonEmptyArray(RestartBlock),
  message: Schema.NonEmptyString,
}) {}

/** Why a reload kept the running instance. */
export type InstanceReloadError = FactoryConfigError | RestartRequiredError;

const restartMessage = (blocks: EffectArray.NonEmptyReadonlyArray<RestartBlock>): string =>
  `The ${blocks.join(" and ")} ${blocks.length === 1 ? "block" : "blocks"} of usine.yaml changed, and ${blocks.length === 1 ? "it applies" : "they apply"} only when usine up restarts. The running configuration is unchanged; restart usine up to apply the change.`;

const rejectionLogFields = (error: InstanceReloadError) =>
  Match.valueTags(error, {
    FactoryConfigError: ({ _tag, file, stage, message }) => ({
      errorTag: _tag,
      file,
      stage,
      message,
    }),
    RestartRequiredError: ({ _tag, blocks, message }) => ({ errorTag: _tag, blocks, message }),
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
    /**
     * Loads the instance folder again with the startup loader and its
     * per-file quarantine, then replaces the snapshot and reports what
     * changed. An invalid `usine.yaml`, or a `workers` or `webhooks` block
     * that differs from the running one, rejects the reload and keeps the
     * running snapshot. Reloads run one at a time, and each outcome is logged.
     */
    readonly reload: Effect.Effect<InstanceReload, InstanceReloadError>;
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
        const current = yield* Ref.make(initial);
        const reloading = yield* Semaphore.make(1);

        const reload = Effect.gen(function* () {
          const running = yield* Ref.get(current);
          const loaded = yield* folder.load(directory);
          const blocks = changedRestartBlocks(running, loaded);
          if (EffectArray.isReadonlyArrayNonEmpty(blocks)) {
            return yield* new RestartRequiredError({ blocks, message: restartMessage(blocks) });
          }
          const changes = instanceReload(running, loaded);
          yield* Ref.set(current, loaded);
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

        return { get: Ref.get(current), reload };
      }),
    );
}

export { InstanceReload, RestartBlock } from "./changes.ts";
