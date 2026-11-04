import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { DateTime, Option } from "effect";

import { Submission } from "../../src/engine/submission.ts";

export const testAgent = Agent.make({
  name: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

export const lifecycleSubmission = Submission.make({
  event: Event.make({
    id: EventId.make("lifecycle-event"),
    dedupKey: DedupKey.make("lifecycle/event/revision"),
    payload: {},
    receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
  }),
  itemKey: ItemKey.make("lifecycle-item"),
  loop: LoopName.make("lifecycle-loop"),
  step: StepName.make("lifecycle-step"),
  approval: "none",
  repository: RepositoryName.make("basaltbytes/usine"),
  revision: RepositoryRevision.make("lifecycle-revision"),
  task: AttemptTask.make("Exercise the Run lifecycle"),
  agent: testAgent,
  parentModel: Option.none(),
});
