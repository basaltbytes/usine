import type { ManagedRepo } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import { matchesSelector } from "@usine/config/selector";
import type { ItemProjection } from "@usine/engine/item-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { Array as Arr, Context, Effect, Layer, Option, Result } from "effect";
import { evaluateTriggerOnEach } from "./polling/loop-evaluation.ts";

/** A Loop whose trigger currently matches one stored Item. */
export interface LoopItemMatch {
  readonly loop: LoopFile;
  readonly item: ItemProjection;
}

/**
 * The stored Items each Loop's trigger currently matches, evaluated as the poll does: stream and
 * selector, then `if:` against the stored payload slice.
 */
export class LoopMatches extends Context.Service<
  LoopMatches,
  {
    /**
     * Returns each issue and pull request Loop that applies to `repository`, paired with the
     * `items` its trigger matches. Includes paused Loops; excludes gone Items and Loops whose `if:`
     * fails.
     */
    readonly matching: (
      instance: LoadedInstance,
      repository: ManagedRepo,
      items: ReadonlyArray<ItemProjection>,
    ) => Effect.Effect<ReadonlyArray<LoopItemMatch>>;
  }
>()("@usine/orchestrator/LoopMatches") {
  static readonly layer = Layer.effect(
    LoopMatches,
    Effect.gen(function* () {
      const expressions = yield* ExpressionEngine;

      const matching = Effect.fn("LoopMatches.matching")(
        function* (
          instance: LoadedInstance,
          repository: ManagedRepo,
          items: ReadonlyArray<ItemProjection>,
        ) {
          yield* Effect.annotateCurrentSpan({ repository: repository.name, items: items.length });
          const loops = instance.loops.filter(
            (loop) => loop.trigger.on !== "schedule" && matchesSelector(loop.selector, repository),
          );
          const present = items.filter(({ goneAt }) => Option.isNone(goneAt));
          // Each Loop's trigger is checked once and evaluated on all of its stream's Items in one
          // call, because the overview and desk match every Loop on every Board Item on each read
          // (#464).
          const matched = new Map<LoopFile, ReadonlySet<ItemProjection>>();
          let failures = 0;
          for (const loop of loops) {
            const candidates = present.filter(({ source }) => source === loop.trigger.on);
            if (candidates.length === 0) continue;
            const evaluated = yield* Effect.result(
              evaluateTriggerOnEach(
                loop,
                repository,
                candidates.map(({ payload }) => payload),
              ),
            );
            if (Result.isFailure(evaluated)) {
              failures += candidates.length;
              yield* Effect.logDebug(
                "Loop trigger could not be checked; it matches no stored Item",
                {
                  repository: repository.name,
                  loop: loop.name,
                  items: candidates.length,
                  errorTag: evaluated.failure._tag,
                  message: evaluated.failure.message,
                },
              );
              continue;
            }
            const hits = new Set<ItemProjection>();
            for (const [item, result] of Arr.zip(candidates, evaluated.success)) {
              if (Result.isSuccess(result)) {
                if (result.success) hits.add(item);
                continue;
              }
              failures += 1;
              yield* Effect.logDebug("Loop trigger could not be evaluated on a stored Item", {
                repository: repository.name,
                loop: loop.name,
                item: item.number,
                errorTag: result.failure._tag,
                message: result.failure.message,
              });
            }
            matched.set(loop, hits);
          }
          const matches: Array<LoopItemMatch> = [];
          for (const item of present) {
            for (const loop of loops) {
              if (matched.get(loop)?.has(item) === true) matches.push({ loop, item });
            }
          }
          yield* Effect.logDebug("Matched Loop triggers against stored Items", {
            repository: repository.name,
            loops: loops.length,
            items: items.length,
            matches: matches.length,
            failures,
          });
          return matches;
        },
        Effect.provideService(ExpressionEngine, expressions),
      );

      return { matching };
    }),
  );
}
