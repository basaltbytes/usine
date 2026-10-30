import { AgentName } from "@usine/core/agent";
import { CycleLimit, DEFAULT_CYCLE_LIMIT } from "@usine/core/cycle-budget";
import { LoopName, ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import { StepName } from "@usine/core/step";
import { Effect, Option, Predicate, Schema } from "effect";
import {
  ExpressionEngine,
  ExpressionEvaluationError,
  Source,
} from "@usine/expression/expression-engine";
import { environmentFor } from "./payload-slices.ts";
import { InstancePath, ConfigFileError } from "./file.ts";
import { nonBlankString } from "./checks.ts";
import { ValidSelector } from "./selector.ts";
import { Trigger } from "./trigger.ts";

const KebabCase = Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a loop name or project/loop identifier",
});

const LoopFileName = LoopName.check(KebabCase);

/** The loop's Markdown task template, with CEL expressions inside `{{ ... }}`. */
export const PromptTemplate = nonBlankString("Expected a non-blank Markdown prompt").pipe(
  Schema.brand("PromptTemplate"),
);

export type PromptTemplate = typeof PromptTemplate.Type;

/** A queue priority that can be represented exactly in JSON, higher first. */
export const PriorityValue = Schema.Int.pipe(Schema.brand("PriorityValue"));
export type PriorityValue = typeof PriorityValue.Type;

/** A literal queue priority or a CEL expression with an `int` result. */
export const LoopPriority = Schema.Union([PriorityValue, Source]);

export type LoopPriority = typeof LoopPriority.Type;

/** A fixed approval requirement or a CEL condition whose true result requires approval. */
export const LoopApproval = Schema.Union([ApprovalRequirement, Source]);
export type LoopApproval = typeof LoopApproval.Type;

/**
 * A parsed loop definition from `projects/<project>/loops/<loop>.md` or the legacy
 * `loops/<name>.md` format (ADR 0031).
 */
export class LoopFile extends Schema.Class<LoopFile>("@usine/config/LoopFile")({
  /** The loop identifier derived from its path; version 2 uses `project/loop`. */
  name: LoopFileName,
  /** The stream and condition checked before opening a run. */
  trigger: Trigger,
  /**
   * The repository names or tags that narrow project membership; `None` selects the whole project.
   */
  selector: Schema.Option(ValidSelector),
  /** Whether a run must wait for operator approval before its first attempt. */
  approval: LoopApproval,
  /**
   * The positive run limit per item between operator resets; defaults to 3 and does not limit
   * schedule loops.
   */
  maxCycles: CycleLimit.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
    Schema.withConstructorDefault(Effect.succeed(DEFAULT_CYCLE_LIMIT)),
  ),
  /** The repository access of the loop's attempts. */
  permissions: LoopPermissions.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("write" as const)),
    Schema.withConstructorDefault(Effect.succeed("write" as const)),
  ),
  /** The loop's queue priority; `None` evaluates to zero. */
  priority: Schema.Option(LoopPriority).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
  /** The name of the single step started by each run; file parsing defaults to `run`. */
  step: StepName,
  /** The rostered agent that runs the step. */
  agent: AgentName,
  /** The Markdown task template with scalar CEL interpolations in `{{ ... }}`. */
  body: PromptTemplate,
}) {}

/** A loop that isn't run because its file failed to load or a reference didn't resolve. */
export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("@usine/config/QuarantinedLoop")(
  {
    /** The rejected file path relative to the instance folder. */
    file: InstancePath,
    /** The loading or validation failure that excluded this file. */
    error: ConfigFileError,
  },
) {}

/**
 * Returns the relative Markdown path for `name`, using `projects/<project>/loops/<loop>.md` for a
 * qualified name and `loops/<name>.md` otherwise.
 */
export const loopPath = (name: LoopName): InstancePath => {
  const [project, loop] = name.split("/");
  return InstancePath.make(
    loop === undefined ? `loops/${name}.md` : `projects/${project}/loops/${loop}.md`,
  );
};

/** Evaluates the priority against the supplied item and repository snapshot. */
export const evaluateLoopPriority = Effect.fn("Loop.evaluatePriority")(function* (
  expressions: ExpressionEngine["Service"],
  loop: LoopFile,
  context: Schema.JsonObject,
) {
  yield* Effect.annotateCurrentSpan({ loop: loop.name });
  if (Option.isNone(loop.priority)) return PriorityValue.make(0);
  const priority = loop.priority.value;
  if (Predicate.isNumber(priority)) return priority;
  const value = yield* expressions.evaluateInteger(
    priority,
    environmentFor(loop.trigger.on),
    context,
  );
  return yield* Schema.decodeUnknownEffect(PriorityValue)(Number(value)).pipe(
    Effect.mapError(
      () =>
        new ExpressionEvaluationError({
          source: priority,
          message: "Priority must be a safe integer between -9007199254740991 and 9007199254740991",
        }),
    ),
  );
});
