import { AttemptId } from "@usine/core/attempt";
import { ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepOutput, StepOutputName, StepOutputRef, StepOutputType } from "@usine/core/step/output";
import { type Brand, Context, type Effect, type Option, Schema } from "effect";
import { EnginePersistenceError } from "../engine/error.ts";

/** The attempt and item associated with a batch of outputs. */
export class StepOutputContext extends Schema.Class<
  StepOutputContext,
  Brand.Brand<"@usine/engine/step-outputs/store/StepOutputContext">
>("StepOutputContext")({
  attemptId: AttemptId,
  runId: RunId,
  stepName: StepName,
  repository: RepositoryName,
  /** Schedule runs have no item number. */
  itemNumber: Schema.OptionFromNullOr(ItemNumber),
}) {}

/** Output metadata returned without reading its body. */
export class StoredStepOutput extends StepOutputRef.extend<StoredStepOutput>("StoredStepOutput")({
  ...StepOutputContext.fields,
  createdAt: Schema.DateTimeUtcFromString,
}) {}

/** Stores output bodies independently from run snapshots (ADR 0034). */
export class StepOutputStore extends Context.Service<
  StepOutputStore,
  {
    /** Rewrites the same `(attemptId, name)` keys, preserving their creation times. */
    readonly write: (
      context: StepOutputContext,
      outputs: ReadonlyArray<StepOutput>,
    ) => Effect.Effect<void, EnginePersistenceError>;
    /** Lists refs from succeeded attempts for an item, optionally restricted to an opaque type. */
    readonly list: (
      repository: RepositoryName,
      itemNumber: ItemNumber,
      type: Option.Option<StepOutputType>,
    ) => Effect.Effect<ReadonlyArray<StoredStepOutput>, EnginePersistenceError>;
    /** Reads an output body only if its attempt succeeded. */
    readonly read: (
      attemptId: AttemptId,
      name: StepOutputName,
    ) => Effect.Effect<Option.Option<StepOutput>, EnginePersistenceError>;
  }
>()("@usine/engine/step-outputs/store/StepOutputStore") {}
