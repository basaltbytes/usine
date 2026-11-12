import type { ExpressionEngine } from "@usine/expression/expression-engine";
import { approvalFor } from "./approval.ts";
import type { ConfigFileError } from "@usine/config/file";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import type { ManagedRepo } from "@usine/config/factory";
import { Agent, resolveParentModel, AgentName } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import type { CiPolicy } from "@usine/core/ci";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { CycleGeneration, type CycleLimit } from "@usine/core/cycle-budget";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryRevision } from "@usine/core/repository";
import { Submission, type SubmissionResult } from "@usine/engine/engine";
import { type Brand, type DateTime, Effect, Match, Option, Result, Schema } from "effect";

/**
 * The revision for issue and schedule Attempts, which resolve the remote's default branch at
 * prepare time.
 */
export const DEFAULT_BRANCH_REVISION = RepositoryRevision.make("HEAD");

export interface ResolvedLoop {
  readonly agent: Agent;
  readonly loop: LoopFile;
  readonly parentModel: Option.Option<ModelId>;
}

/** The Agent of a loaded Loop is no longer in the roster. */
export class LoopAgentResolutionError extends Schema.TaggedError<
  LoopAgentResolutionError,
  Brand.Brand<"@usine/orchestrator/trigger-submission/LoopAgentResolutionError">
>("@usine/orchestrator/LoopAgentResolutionError")("LoopAgentResolutionError", {
  loop: LoopName,
  agent: AgentName,
  message: Schema.NonEmptyString,
}) {}

/** Resolves one Loop's roster Agent and effective parent model. */
export const resolveTriggerLoop = Effect.fn("TriggerRouting.resolveLoop")(function* (
  instance: LoadedInstance,
  loop: LoopFile,
) {
  yield* Effect.annotateCurrentSpan({ loop: loop.name, agent: loop.agent });
  const roster = new Map(instance.agents.map((agent) => [agent.name, agent]));
  const loaded = roster.get(loop.agent);
  if (loaded === undefined) {
    return yield* LoopAgentResolutionError.make({
      loop: loop.name,
      agent: loop.agent,
      message: `Loop "${loop.name}" references agent "${loop.agent}", which is not in the roster`,
    });
  }
  const agent = loaded.agent;
  return {
    agent,
    loop,
    parentModel: resolveParentModel(agent, instance.config.settings.parentModel),
  } satisfies ResolvedLoop;
});

/** Resolves every loaded Loop's Agent, skipping and logging each Loop whose Agent is missing. */
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

interface TriggerSubmissionOptions extends ResolvedLoop {
  readonly dedupKey: DedupKey;
  readonly cycleGeneration: CycleGeneration;
  readonly itemKey: ItemKey;
  readonly payload: Schema.Json;
  readonly receivedAt: DateTime.Utc;
  readonly repository: ManagedRepo;
  readonly revision: RepositoryRevision;
  readonly task: AttemptTask;
}

/** Returns the Loop's `max_cycles`, or `None` for a schedule Loop, whose Runs no budget counts. */
export const cycleLimitOf = (loop: LoopFile): Option.Option<CycleLimit> =>
  loop.trigger.on === "schedule" ? Option.none() : Option.some(loop.maxCycles);

/**
 * Returns the Submission settings that come from the Loop and its Agent: approval, evaluated
 * against `payload`, permissions, CI policy, outcome labels, cycle limit, Agent, and parent model.
 */
export const loopSettings = Effect.fn("TriggerRouting.loopSettings")(function* (
  expressions: ExpressionEngine["Service"],
  { agent, loop, parentModel }: ResolvedLoop,
  repository: Pick<ManagedRepo, "name">,
  payload: Schema.Json,
) {
  const decision = yield* approvalFor(expressions, loop, repository, payload);
  return {
    ...decision,
    permissions: loop.permissions,
    ciPolicy: loop.ci,
    outcomeLabels: loop.outcomeLabels,
    cycleLimit: cycleLimitOf(loop),
    agent,
    parentModel,
  };
});

const ciInstructions = (policy: CiPolicy) =>
  Schema.NonEmptyString.make(
    `\n\nAfter pushing, end with [usine:awaiting-ci] followed by a JSON object with pull_request, head, fix_loop ("${policy.fixLoop}"), timeout_seconds (${policy.timeoutSeconds}), and on_green (an array of {item, add, remove} label changes to apply after CI passes). Do not apply completion labels or wait for CI in the agent session. Relay this handoff unchanged from a child. usine verifies CI before completing the run.`,
  );

/** Returns `prompt` followed by the CI handoff instructions of `policy`, and those instructions. */
export const withCiInstructions = (prompt: string, policy: Option.Option<CiPolicy>) => {
  const instructions = Option.map(policy, ciInstructions);
  return {
    task: AttemptTask.make(`${prompt}${Option.getOrElse(instructions, () => "")}`),
    ciInstructions: instructions,
  };
};

/**
 * The CI handoff instructions that `recordedPrompt` removed: the ones recorded with the Event, the
 * ones its CI policy generates now for an Event recorded without them, or none.
 */
type RemovedCiInstructions = "recorded" | "current-wording" | "none";

interface RecordedSuffix {
  readonly instructions: string;
  readonly removed: Exclude<RemovedCiInstructions, "none">;
}

/**
 * Returns the prompt of a recorded Submission: its task without the CI handoff instructions
 * recorded with it. For an Event recorded before the instructions were stored, it removes the
 * instructions that the Event's CI policy generates now, if the task ends with them. `removed`
 * states which instructions it removed; with `none`, the task is returned unchanged.
 */
export const recordedPrompt = (
  submission: Pick<Submission, "task" | "ciInstructions" | "ciPolicy">,
): { readonly prompt: string; readonly removed: RemovedCiInstructions } => {
  const suffix = Option.match(submission.ciInstructions, {
    onSome: (instructions) => Option.some<RecordedSuffix>({ instructions, removed: "recorded" }),
    onNone: () =>
      Option.map(submission.ciPolicy, (policy): RecordedSuffix => ({
        instructions: ciInstructions(policy),
        removed: "current-wording",
      })),
  });
  return Option.match(
    Option.filter(suffix, ({ instructions }) => submission.task.endsWith(instructions)),
    {
      onNone: () => ({ prompt: submission.task, removed: "none" }),
      onSome: ({ instructions, removed }) => ({
        prompt: submission.task.slice(0, -instructions.length),
        removed,
      }),
    },
  );
};

/** Builds the Submission that every trigger stream sends to the engine. */
export const triggerSubmission = Effect.fn("TriggerRouting.submission")(function* (
  expressions: ExpressionEngine["Service"],
  options: TriggerSubmissionOptions,
) {
  yield* Effect.annotateCurrentSpan({ eventId: options.dedupKey, itemKey: options.itemKey });
  const settings = yield* loopSettings(expressions, options, options.repository, options.payload);
  return Submission.make({
    event: Event.make({
      id: EventId.make(options.dedupKey),
      dedupKey: options.dedupKey,
      payload: options.payload,
      receivedAt: options.receivedAt,
    }),
    itemKey: options.itemKey,
    cycleGeneration: options.cycleGeneration,
    loop: options.loop.name,
    step: options.loop.step,
    ...settings,
    repository: options.repository.name,
    revision: options.revision,
    ...withCiInstructions(options.task, options.loop.ci),
  });
});

/**
 * Returns the log fields for a submission outcome: the Run ID for a claim or suppression, the
 * reason for an ignore.
 */
export const submissionLogFields = (submission: SubmissionResult): Record<string, string> =>
  Match.valueTags(submission, {
    Claimed: ({ runId }) => ({ runId }),
    Queued: () => ({}),
    Suppressed: ({ runId }) => ({ suppressedBy: runId }),
    Ignored: ({ reason }) => ({ reason }),
    CycleBlocked: ({ ask }) => ({ askId: ask.id, reason: "cycle-budget-exhausted" }),
  });

/** Returns the log fields for a config failure during triggering. */
export const configFileErrorLogFields = (error: ConfigFileError) =>
  Option.match(error.expression, {
    onNone: () => ({ configFile: error.file, configStage: error.stage }),
    onSome: (expression) => ({
      configFile: error.file,
      configStage: error.stage,
      expression,
    }),
  });
