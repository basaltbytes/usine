import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { Attempt, AttemptTask } from "@usine/core/attempt";
import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run } from "@usine/core/run";
import { Step } from "@usine/core/step";
import { Schema } from "effect";

/** The full durable view of one Run. */
export class RunSnapshot extends Schema.Class<RunSnapshot>("@usine/engine/RunSnapshot")({
  event: Event,
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

/** The lighter view used when listing Runs for operators. */
export class RunSummary extends Schema.Class<RunSummary>("@usine/engine/RunSummary")({
  itemKey: ItemKey,
  run: Run,
  step: Step,
  attempts: Schema.Array(Attempt),
  repository: RepositoryName,
  task: AttemptTask,
  agent: Agent,
}) {}

/** Monotonic version of the operator projection. */
export const ProjectionRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ProjectionRevision"),
);

export type ProjectionRevision = typeof ProjectionRevision.Type;
