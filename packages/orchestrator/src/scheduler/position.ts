import { PriorityValue, evaluateLoopPriority } from "@usine/config/loop";
import { boardRepositories } from "@usine/config/project";
import { repositoryContext } from "@usine/config/payload-slices";
import { canonicalRepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import type { Submission } from "@usine/engine/engine";
import type { ExpressionEngine } from "@usine/expression/expression-engine";
import { Effect, Option } from "effect";
import { payloadLabels } from "../board/items.ts";
import type { CurrentInstance } from "../current-instance/current-instance.ts";
import { pipelinePosition, type PipelinePosition } from "../lease-order.ts";

export const positionFields = (position: PipelinePosition) => ({
  priority: position.priority,
  ...Option.match(position.lane, {
    onNone: () => ({ positionSource: "none" }),
    onSome: ({ name, number }) => ({ positionSource: "lane", position: number, lane: name }),
  }),
});

export const positionFor = (
  instances: CurrentInstance["Service"],
  expressions: ExpressionEngine["Service"],
) =>
  Effect.fn("WorkerScheduler.position")(function* (runId: RunId, submission: Submission) {
    yield* Effect.annotateCurrentSpan({ runId, loop: submission.loop });
    const { config, loops } = yield* instances.get;
    const loop = loops.find(({ name }) => name === submission.loop);
    const repository = boardRepositories(config).find(
      ({ name }) =>
        canonicalRepositoryName(name) === canonicalRepositoryName(submission.repository),
    );
    const priority =
      loop === undefined
        ? PriorityValue.make(0)
        : yield* evaluateLoopPriority(expressions, loop, {
            repo: repositoryContext({ name: submission.repository }),
            item: submission.event.payload,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Priority evaluation failed; using zero", {
                runId,
                loop: submission.loop,
                eventId: submission.event.id,
                expression: error.source,
                errorTag: error._tag,
                message: error.message,
              }).pipe(Effect.as(PriorityValue.make(0))),
            ),
          );
    const lanes = repository?.lanes ?? [];
    const stream = loop?.trigger.on;
    if (lanes.length === 0 || stream === undefined || stream === "schedule")
      return pipelinePosition(priority, lanes, []);
    const labels = yield* payloadLabels(stream, submission.event.payload).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "The Run's Event has no labels to read; the Run waits for a worker slot without a lane position",
          {
            runId,
            loop: submission.loop,
            eventId: submission.event.id,
            errorTag: error._tag,
            message: error.message,
          },
        ).pipe(Effect.as([])),
      ),
    );
    return pipelinePosition(priority, lanes, labels);
  });
