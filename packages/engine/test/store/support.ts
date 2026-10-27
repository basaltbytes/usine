import { NodeServices } from "@effect/platform-node";

import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";

import { AttemptTask } from "@usine/core/attempt";

import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";

import { StepName } from "@usine/core/step";

import { DateTime, Effect, FileSystem, Option } from "effect";
import { SqlClient } from "effect/sql";

import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

import { Submission } from "../../src/engine/submission.ts";

import { InstanceDirectory } from "@usine/core/instance";

import { RunStore } from "../../src/store/store.ts";

export const testAgent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

export const lifecycleSubmission = new Submission({
  event: new Event({
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

export const withRunStore = <A, E>(effect: Effect.Effect<A, E, RunStore | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-lifecycle-" }),
    );
    return yield* effect.pipe(
      Effect.provide(RunStore.layer),
      Effect.provide(localSqliteLayer(directory)),
    );
  }).pipe(Effect.provide(NodeServices.layer));
