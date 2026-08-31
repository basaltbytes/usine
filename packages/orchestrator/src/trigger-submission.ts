import type { LoadedInstance, LoopFile, ManagedRepo } from "@usine/config";
import { Agent, AttemptChannel, Event, Item, Repository } from "@usine/core";
import { Submission, type SubmissionResult } from "@usine/engine";
import { type DateTime, Effect, Match, type Option, type Schema } from "effect";

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

/** Snapshot every authored loop's roster member and effective parent model. */
export const resolveTriggerLoops = Effect.fn("TriggerRouting.resolveLoops")(function* (
  instance: LoadedInstance,
) {
  const roster = new Map(instance.agents.map((agent) => [agent.name, agent]));
  return yield* Effect.forEach(instance.loops, (loop) =>
    Effect.gen(function* () {
      const loaded = roster.get(loop.agent);
      if (loaded === undefined) {
        return yield* Effect.die(
          new Error(`Loaded loop ${loop.name} has no rostered Agent ${loop.agent}`),
        );
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
    }),
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
