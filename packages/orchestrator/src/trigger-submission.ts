import type { ConfigFileError } from "@usine/config/file";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import type { ManagedRepo } from "@usine/config/factory";
import { Agent, resolveParentModel, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { CycleGeneration } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryRevision } from "@usine/core/repository";
import { Submission, type SubmissionResult } from "@usine/engine/engine";
import { type DateTime, Effect, Match, Option, Result, Schema } from "effect";

/** Issue and schedule Attempts resolve the remote's default branch at prepare time. */
export const DEFAULT_BRANCH_REVISION = RepositoryRevision.make("HEAD");

export interface ResolvedLoop {
  readonly agent: Agent;
  readonly loop: LoopFile;
  readonly parentModel: Option.Option<ModelId>;
}

/** The agent a loaded loop names is no longer in the roster. */
export class LoopAgentResolutionError extends Schema.TaggedError<LoopAgentResolutionError>(
  "@usine/orchestrator/LoopAgentResolutionError",
)("LoopAgentResolutionError", {
  loop: LoopName,
  agent: AgentName,
  message: Schema.NonEmptyString,
}) {}

/** Resolves one loop's roster agent and effective parent model. */
export const resolveTriggerLoop = Effect.fn("TriggerRouting.resolveLoop")(function* (
  instance: LoadedInstance,
  loop: LoopFile,
) {
  yield* Effect.annotateCurrentSpan({ loop: loop.name, agent: loop.agent });
  const roster = new Map(instance.agents.map((agent) => [agent.name, agent]));
  const loaded = roster.get(loop.agent);
  if (loaded === undefined) {
    return yield* new LoopAgentResolutionError({
      loop: loop.name,
      agent: loop.agent,
      message: `Loop ${loop.name} references missing Agent ${loop.agent}`,
    });
  }
  const agent = new Agent({
    name: loaded.name,
    brain: new BrainSpec({
      harness: loaded.harness,
      model: loaded.model,
      effort: loaded.effort,
    }),
    parentModel: loaded.parentModel,
    parentEffort: loaded.parentEffort,
    persona: loaded.persona,
  });
  return {
    agent,
    loop,
    parentModel: resolveParentModel(agent, instance.config.settings.parentModel),
  } satisfies ResolvedLoop;
});

/**
 * Resolves every loaded loop's agent. `InstanceFolder.load` already quarantines
 * loops that name unknown agents, so a miss here means a hand-assembled
 * instance drifted: the loop is skipped with a log each cycle and its siblings
 * keep running.
 */
export const resolveTriggerLoops = Effect.fn("TriggerRouting.resolveLoops")(function* (
  instance: LoadedInstance,
) {
  const resolved: Array<ResolvedLoop> = [];
  for (const loop of instance.loops) {
    const result = yield* Effect.result(resolveTriggerLoop(instance, loop));
    if (Result.isSuccess(result)) {
      resolved.push(result.success);
      continue;
    }
    yield* Effect.logError("Loaded loop lost its rostered Agent; skipping the loop", {
      loop: result.failure.loop,
      agent: result.failure.agent,
      errorTag: result.failure._tag,
      message: result.failure.message,
    });
  }
  return resolved;
});

interface TriggerSubmissionOptions {
  readonly agent: Agent;
  readonly dedupKey: DedupKey;
  readonly cycleGeneration: CycleGeneration;
  readonly itemKey: ItemKey;
  readonly loop: LoopFile;
  readonly payload: Schema.Json;
  readonly receivedAt: DateTime.Utc;
  readonly repository: ManagedRepo;
  readonly revision: RepositoryRevision;
  readonly task: AttemptTask;
  readonly parentModel: Option.Option<ModelId>;
}

/** Builds the Submission every trigger stream hands to the engine. */
export const triggerSubmission = (options: TriggerSubmissionOptions): Submission =>
  new Submission({
    event: new Event({
      id: EventId.make(options.dedupKey),
      dedupKey: options.dedupKey,
      payload: options.payload,
      receivedAt: options.receivedAt,
    }),
    itemKey: options.itemKey,
    cycleGeneration: options.cycleGeneration,
    loop: options.loop.name,
    step: options.loop.step,
    approval: options.loop.approval,
    cycleLimit:
      options.loop.trigger.on === "schedule" ? Option.none() : Option.some(options.loop.maxCycles),
    repository: options.repository.name,
    revision: options.revision,
    task: options.task,
    agent: options.agent,
    parentModel: options.parentModel,
  });

/** The log fields for a submission outcome: the run id for a claim, the reason for an ignore. */
export const submissionLogFields = (submission: SubmissionResult): Record<string, string> =>
  Match.valueTags(submission, {
    Claimed: ({ runId }) => ({ runId }),
    Queued: () => ({}),
    Ignored: ({ reason }) => ({ reason }),
    CycleBlocked: ({ ask }) => ({ askId: ask.id, reason: "cycle-budget-exhausted" }),
  });

/** Log fields for a config failure met while triggering. */
export const configFileErrorLogFields = (error: ConfigFileError) =>
  Option.match(error.expression, {
    onNone: () => ({ configFile: error.file, configStage: error.stage }),
    onSome: (expression) => ({
      configFile: error.file,
      configStage: error.stage,
      expression,
    }),
  });
