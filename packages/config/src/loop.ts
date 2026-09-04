import { AgentName } from "@usine/core/agent";
import { LoopName, ApprovalRequirement } from "@usine/core/loop";
import { StepName } from "@usine/core/step";
import { Schema } from "effect";
import { InstancePath, ConfigFileError } from "./file.ts";
import { nonBlankString } from "./checks.ts";
import { ValidSelector } from "./selector.ts";
import { Trigger } from "./trigger.ts";

const KebabCase = Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a kebab-case filename identity",
});

const LoopFileName = LoopName.check(KebabCase);

export const PromptTemplate = nonBlankString("Expected a non-blank Markdown prompt").pipe(
  Schema.brand("PromptTemplate"),
);

export type PromptTemplate = typeof PromptTemplate.Type;

export class LoopFile extends Schema.Class<LoopFile>("@usine/config/LoopFile")({
  name: LoopFileName,
  trigger: Trigger,
  selector: Schema.Option(ValidSelector),
  approval: ApprovalRequirement,
  step: StepName,
  agent: AgentName,
  body: PromptTemplate,
}) {}

export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("@usine/config/QuarantinedLoop")(
  {
    file: InstancePath,
    error: ConfigFileError,
  },
) {}

/** The file a loop name refers to. */
export const loopPath = (name: LoopName): InstancePath => InstancePath.make(`loops/${name}.md`);
