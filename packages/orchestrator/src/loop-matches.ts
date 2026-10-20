import type { ManagedRepo } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import { matchesSelector } from "@usine/config/selector";
import type { ItemProjection } from "@usine/engine/item-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { Context, Effect, Layer, Option, Result } from "effect";
import { evaluateTrigger } from "./polling/loop-evaluation.ts";

/** A Loop whose trigger matches one stored Item now. */
export interface LoopItemMatch {
  readonly loop: LoopFile;
  readonly item: ItemProjection;
}

/**
 * Which stored Items each Loop's trigger matches now, evaluated as the poll
 * evaluates a changed Item: the Loop's stream and selector, then its `if:`
 * against the Item's stored payload slice.
 */
export class LoopMatches extends Context.Service<
  LoopMatches,
  {
    /**
     * Pairs each issue and pull-request Loop of `instance` that applies to
     * `repository` with each of `items` its trigger matches, in the order of
     * `items`, then of the instance's Loops. Paused Loops are included. An
     * Item GitHub no longer has matches no Loop. A Loop whose `if:` fails on
     * an Item is left out of that Item's matches; the poll reports the
     * failure in Needs you.
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

      const matching = Effect.fn("LoopMatches.matching")(function* (
        instance: LoadedInstance,
        repository: ManagedRepo,
        items: ReadonlyArray<ItemProjection>,
      ) {
        yield* Effect.annotateCurrentSpan({ repository: repository.name, items: items.length });
        const loops = instance.loops.filter(
          (loop) => loop.trigger.on !== "schedule" && matchesSelector(loop.selector, repository),
        );
        const matches: Array<LoopItemMatch> = [];
        let failures = 0;
        for (const item of items) {
          if (Option.isSome(item.goneAt)) continue;
          for (const loop of loops) {
            if (loop.trigger.on !== item.source) continue;
            const result = yield* Effect.result(
              evaluateTrigger(loop, repository, item.payload).pipe(
                Effect.provideService(ExpressionEngine, expressions),
              ),
            );
            if (Result.isFailure(result)) {
              failures += 1;
              yield* Effect.logDebug("Loop trigger could not be evaluated on a stored Item", {
                repository: repository.name,
                loop: loop.name,
                item: item.number,
                errorTag: result.failure._tag,
                message: result.failure.message,
              });
              continue;
            }
            if (result.success) matches.push({ loop, item });
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
      });

      return { matching };
    }),
  );
}
