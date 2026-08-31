import {
  type ConfigFileError,
  type LoadedInstance,
  type LoopFile,
  type ManagedRepo,
} from "@usine/config";
import { Agent, AttemptChannel, Event, Item, Loop, Repository } from "@usine/core";
import { Submission, type SubmissionResult } from "@usine/engine";
import { type DateTime, Effect, Match, Option, Schema } from "effect";

/**
 * The worker fetch target until per-loop revisions exist: `git fetch origin
 * HEAD` resolves the remote's current default branch at prepare time.
 */
const DEFAULT_BRANCH_REVISION = Repository.Revision.make("HEAD");

export interface ResolvedLoop {
  readonly agent: Agent.Agent;
  readonly loop: LoopFile;
  readonly parentModel: Option.Option<Agent.ModelId>;
}

/** A loaded loop lost the roster member its authored agent name refers to. */
export class LoopAgentResolutionError extends Schema.TaggedError<LoopAgentResolutionError>(
  "@usine/orchestrator/LoopAgentResolutionError",
)("LoopAgentResolutionError", {
  loop: Loop.LoopName,
  agent: Agent.Name,
  message: Schema.NonEmptyString,
}) {}

/** Snapshot one authored loop's roster member and effective parent model. */
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
  const agent = new Agent.Agent({
    name: loaded.name,
    brain: new Agent.BrainSpec({
      harness: loaded.harness,
      model: loaded.model,
      effort: loaded.effort,
    }),
    parentModel: loaded.parentModel,
    persona: loaded.persona,
  });
  return {
    agent,
    loop,
    parentModel: Agent.resolveParentModel(agent, instance.config.settings.parentModel),
  } satisfies ResolvedLoop;
});

/** Snapshot the validated instance roster; a mismatch here is a violated invariant. */
export const resolveTriggerLoops = Effect.fn("TriggerRouting.resolveLoops")(function* (
  instance: LoadedInstance,
) {
  return yield* Effect.forEach(instance.loops, (loop) =>
    resolveTriggerLoop(instance, loop).pipe(
      Effect.tapError((error) =>
        Effect.logError("Loaded loop lost its rostered Agent", {
          loop: error.loop,
          agent: error.agent,
          errorTag: error._tag,
          message: error.message,
        }),
      ),
      Effect.orDie,
    ),
  );
});

interface TriggerSubmissionOptions {
  readonly agent: Agent.Agent;
  readonly dedupKey: Event.DedupKey;
  readonly itemKey: Item.ItemKey;
  readonly loop: LoopFile;
  readonly payload: Schema.Json;
  readonly receivedAt: DateTime.Utc;
  readonly repository: ManagedRepo;
  readonly task: AttemptChannel.Task;
  readonly parentModel: Option.Option<Agent.ModelId>;
}

/** The one routing contract shared by every trigger stream. */
export const triggerSubmission = (options: TriggerSubmissionOptions): Submission =>
  new Submission({
    event: new Event.Event({
      id: Event.EventId.make(options.dedupKey),
      dedupKey: options.dedupKey,
      payload: options.payload,
      receivedAt: options.receivedAt,
    }),
    itemKey: options.itemKey,
    loop: options.loop.name,
    step: options.loop.step,
    approval: options.loop.approval,
    repository: options.repository.name,
    revision: DEFAULT_BRANCH_REVISION,
    task: options.task,
    agent: options.agent,
    parentModel: options.parentModel,
  });

/**
 * What each submission outcome contributes to its log line: the run for a
 * claim, the ignore reason for a superseded or revoked Event — never a
 * sentinel value.
 */
export const submissionLogFields = (submission: SubmissionResult): Record<string, string> =>
  Match.valueTags(submission, {
    Claimed: ({ runId }) => ({ runId }),
    Queued: () => ({}),
    Ignored: ({ reason }) => ({ reason }),
  });

/** Safe structured context for a config-owned trigger failure. */
export const configFileErrorLogFields = (error: ConfigFileError) =>
  Option.match(error.expression, {
    onNone: () => ({ configFile: error.file, configStage: error.stage }),
    onSome: (expression) => ({
      configFile: error.file,
      configStage: error.stage,
      expression,
    }),
  });
