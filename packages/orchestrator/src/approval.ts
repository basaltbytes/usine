import type { ManagedRepo } from "@usine/config/factory";
import type { LoopFile } from "@usine/config/loop";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { ApprovalRequirement } from "@usine/core/loop";
import type { ExpressionEngine } from "@usine/expression/expression-engine";
import { IssuePayload } from "@usine/github/polling";
import { Effect, Option, Result, Schema } from "effect";

const LabelHistory = Schema.Struct({ labelEvents: IssuePayload.fields.labelEvents });

/** Evaluates approval against the event snapshot, requiring approval if evaluation fails. */
export const approvalFor = Effect.fn("Loop.approvalFor")(function* (
  expressions: ExpressionEngine["Service"],
  loop: LoopFile,
  repository: Pick<ManagedRepo, "name">,
  payload: Schema.Json,
) {
  yield* Effect.annotateCurrentSpan({ loop: loop.name, repository: repository.name });
  const policy = loop.approval;
  if (Schema.is(ApprovalRequirement)(policy)) {
    yield* Effect.logInfo("Applied fixed approval requirement", {
      loop: loop.name,
      repository: repository.name,
      approval: policy,
    });
    return {
      approval: policy,
      approvalReason: Option.some(
        policy === "required"
          ? "Approval required: the loop requires approval"
          : "Approval not required: the loop allows automatic starts",
      ),
    };
  }
  const evaluated = yield* expressions
    .evaluateBoolean(policy, environmentFor(loop.trigger.on), {
      repo: repositoryContext(repository),
      item: payload,
    })
    .pipe(Effect.result);
  if (Result.isFailure(evaluated)) {
    yield* Effect.logWarning("Approval evaluation failed; requiring approval", {
      loop: loop.name,
      repository: repository.name,
      expression: policy,
      errorTag: evaluated.failure._tag,
      message: evaluated.failure.message,
    });
    return {
      approval: "required" as const,
      approvalReason: Option.some(
        `Approval required: condition could not be evaluated (${policy}): ${evaluated.failure.message}`,
      ),
    };
  }
  const approval: ApprovalRequirement = evaluated.success ? "required" : "none";
  const history = Schema.decodeUnknownOption(LabelHistory)(payload);
  const actors = Option.match(history, {
    onNone: () => [],
    onSome: ({ labelEvents }) =>
      Object.entries(labelEvents).map(([label, { actor }]) =>
        actor === null
          ? `Label "${label}" has an unknown actor`
          : `Label "${label}" was set by ${actor.login} (${actor.type})`,
      ),
  });
  const reason = [
    `Approval ${evaluated.success ? "required" : "not required"}: condition evaluated to ${evaluated.success} (${policy})`,
    ...actors,
  ].join(". ");
  yield* Effect.logInfo("Evaluated approval condition", {
    loop: loop.name,
    repository: repository.name,
    expression: policy,
    value: evaluated.success,
    approval,
  });
  return { approval, approvalReason: Option.some(reason) };
});
