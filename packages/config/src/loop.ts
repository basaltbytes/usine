import { AgentName } from "@usine/core/agent";
import { CycleLimit, DEFAULT_CYCLE_LIMIT } from "@usine/core/cycle-budget";
import { LoopName, ApprovalRequirement } from "@usine/core/loop";
import { StepName } from "@usine/core/step";
import { Effect, Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";
import { nonBlankString } from "./checks.ts";
import { ValidSelector } from "./selector.ts";
import { Trigger } from "./trigger.ts";

const KebabCase = Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a kebab-case filename identity",
});

const LoopFileName = LoopName.check(KebabCase);

/** The Loop's Markdown task template, with CEL expressions inside `{{ ... }}`. */
export const PromptTemplate = nonBlankString("Expected a non-blank Markdown prompt").pipe(
  Schema.brand("PromptTemplate"),
);

export type PromptTemplate = typeof PromptTemplate.Type;

/** A Loop parsed from `loops/<name>.md`; the filename defines its identity. */
export class LoopFile extends Schema.Class<LoopFile>("@usine/config/LoopFile")({
  name: LoopFileName,
  trigger: Trigger,
  selector: Schema.Option(ValidSelector),
  approval: ApprovalRequirement,
  maxCycles: CycleLimit.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
  ),
  step: StepName,
  agent: AgentName,
  body: PromptTemplate,
}) {}

/** A Loop excluded from execution because its file could not be loaded or its references resolved. */
export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("@usine/config/QuarantinedLoop")(
  {
    file: InstancePath,
    error: ConfigFileError,
  },
) {}

/** The file a loop name refers to. */
export const loopPath = (name: LoopName): InstancePath => InstancePath.make(`loops/${name}.md`);
