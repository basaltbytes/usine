import { AgentName } from "@usine/core/agent";
import { CycleLimit, DEFAULT_CYCLE_LIMIT } from "@usine/core/cycle-budget";
import { LoopName, ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import { StepName } from "@usine/core/step";
import { Effect, Option, Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";
import { nonBlankString } from "./checks.ts";
import { ValidSelector } from "./selector.ts";
import { Trigger } from "./trigger.ts";

const KebabCase = Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a kebab-case file name",
});

const LoopFileName = LoopName.check(KebabCase);

/** The Loop's Markdown task template, with CEL expressions inside `{{ ... }}`. */
export const PromptTemplate = nonBlankString("Expected a non-blank Markdown prompt").pipe(
  Schema.brand("PromptTemplate"),
);

export type PromptTemplate = typeof PromptTemplate.Type;

/**
 * The rank of a Loop's queued Runs for a free Worker slot, a positive integer. Runs of Loops with a
 * priority go before Runs that lane order ranks, higher first.
 */
export const LoopPriority = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "Expected a priority of at least 1" }),
).pipe(Schema.brand("LoopPriority"));

export type LoopPriority = typeof LoopPriority.Type;

/** A Loop parsed from `loops/<name>.md`. */
export class LoopFile extends Schema.Class<LoopFile>("@usine/config/LoopFile")({
  name: LoopFileName,
  trigger: Trigger,
  selector: Schema.Option(ValidSelector),
  approval: ApprovalRequirement,
  maxCycles: CycleLimit.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
  ),
  /** The repository access of the Loop's Attempts. */
  permissions: LoopPermissions.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("write" as const)),
    Schema.withConstructorDefault(Effect.succeed("write" as const)),
  ),
  /** The Loop's queue priority, or `None` to rank its Runs by lane. */
  priority: Schema.Option(LoopPriority).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  step: StepName,
  agent: AgentName,
  body: PromptTemplate,
}) {}

/** A Loop that isn't run because its file failed to load or a reference didn't resolve. */
export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("@usine/config/QuarantinedLoop")(
  {
    file: InstancePath,
    error: ConfigFileError,
  },
) {}

export const loopPath = (name: LoopName): InstancePath => InstancePath.make(`loops/${name}.md`);
