import { ConfigFileError, InstancePath } from "@usine/config/file";
import {
  ConfigurationEntity,
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationInvalid,
  ConfigurationStore,
  ConfigurationStoreError,
  configurationEntities,
  validateConfiguration,
} from "@usine/config/configuration";
import { parseConfigurationForm } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { repositoryContext } from "@usine/config/payload-slices";
import { matchesSelector } from "@usine/config/selector";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { Array as Arr, Effect, Option, Result } from "effect";
import { projectedItem } from "../../../board/items.ts";
import { evaluateTriggerOnEach } from "../../../polling/loop-evaluation.ts";
import { ConfigurationNotFound } from "../model.ts";
import { LoopCheck, LoopDraft, LoopPreview, LoopPreviewItem, LoopPreviewRequest } from "./model.ts";

export const configurationLoopOperations = Effect.gen(function* () {
  const store = yield* ConfigurationStore;
  const parser = yield* ConfigParser;
  const items = yield* ItemProjectionReader;
  const expressions = yield* ExpressionEngine;

  const candidate = (input: LoopDraft) =>
    Effect.gen(function* () {
      const key = new ConfigurationEntityKey({
        kind: "loop",
        identifier: ConfigurationEntityId.make(input.name),
      });
      const value =
        input.text === undefined
          ? input.value
          : yield* parseConfigurationForm(key, input.text).pipe(
              Effect.mapError((problem) => new ConfigurationInvalid({ problems: [problem] })),
            );
      const snapshot = yield* store.read;
      const entities = Option.match(snapshot.instance, {
        onNone: () => [],
        onSome: configurationEntities,
      });
      const instance = yield* validateConfiguration(parser, [
        ...entities.filter((entity) => entity.key.key !== key.key),
        new ConfigurationEntity({ key, value }),
      ]);
      const loop = instance.loops.find((loop) => loop.name === input.name);
      if (loop === undefined)
        return yield* new ConfigurationNotFound({
          message: "Loop was not found in the checked configuration.",
        });
      return { instance, loop };
    });

  const check = Effect.fn("ConfigurationEditor.checkLoop")(function* (input: LoopDraft) {
    yield* Effect.annotateCurrentSpan({ loop: input.name });
    const problems = yield* candidate(input).pipe(
      Effect.as([]),
      Effect.catchTag("ConfigurationInvalid", (error) =>
        Effect.succeed(
          error.problems.flatMap(
            (problem) => problem.details ?? [{ path: [], message: problem.message }],
          ),
        ),
      ),
    );
    yield* Effect.logDebug("Checked loop draft without saving", {
      loop: input.name,
      problems: problems.length,
    });
    return new LoopCheck({ problems });
  });

  const preview = Effect.fn("ConfigurationEditor.previewLoop")(
    function* (input: LoopPreviewRequest) {
      yield* Effect.annotateCurrentSpan({ loop: input.name });
      const { instance, loop } = yield* candidate(input);
      const matched: Array<LoopPreviewItem> = [];
      const failures: Array<LoopPreview["failures"][number]> = [];
      const repositoriesWithoutItems: Array<LoopPreview["repositoriesWithoutItems"][number]> = [];
      let selected: LoopPreview["prompt"] = null;
      let total = 0;
      if (loop.trigger.on !== "schedule") {
        for (const repository of instance.config.repos.filter((repo) =>
          matchesSelector(loop.selector, repo),
        )) {
          const stored = yield* items.list(repository.name, { limit: Number.MAX_SAFE_INTEGER });
          const candidates = stored.filter(
            (item) => item.source === loop.trigger.on && Option.isNone(item.goneAt),
          );
          if (candidates.length === 0) repositoriesWithoutItems.push(repository.name);
          const evaluated = yield* evaluateTriggerOnEach(
            loop,
            repository,
            candidates.map(({ payload }) => payload),
          ).pipe(
            Effect.mapError(
              (error) =>
                new ConfigurationInvalid({
                  problems: [
                    new ConfigFileError({
                      file: InstancePath.make(`loops/${loop.name}.md`),
                      stage: "expression",
                      expression: Option.some(error.source),
                      message: error.message,
                    }),
                  ],
                }),
            ),
          );
          for (const [item, result] of Arr.zip(candidates, evaluated)) {
            if (Result.isFailure(result)) {
              failures.push({ itemKey: item.itemKey, message: result.failure.message });
              continue;
            }
            if (!result.success) continue;
            total += 1;
            const projected = yield* projectedItem(item).pipe(Effect.result);
            if (Result.isSuccess(projected) && matched.length < 20)
              matched.push(
                new LoopPreviewItem({ ...projected.success, repository: repository.name }),
              );
            else if (Result.isFailure(projected))
              failures.push({ itemKey: item.itemKey, message: projected.failure.message });
            if ((input.itemKey === undefined && total === 1) || input.itemKey === item.itemKey) {
              const rendered = yield* parser
                .renderPrompt(loop, { repo: repositoryContext(repository), item: item.payload })
                .pipe(Effect.result);
              if (Result.isSuccess(rendered))
                selected = { itemKey: item.itemKey, text: rendered.success };
              else failures.push({ itemKey: item.itemKey, message: rendered.failure.message });
            }
          }
        }
      }
      if (
        input.itemKey !== undefined &&
        selected === null &&
        !failures.some((failure) => failure.itemKey === input.itemKey)
      )
        return yield* new ConfigurationNotFound({
          message: "The selected item no longer matches this loop.",
        });
      for (const failure of failures)
        yield* Effect.logWarning("Could not preview a stored item", {
          loop: loop.name,
          ...failure,
        });
      yield* Effect.logInfo("Previewed loop without saving or opening runs", {
        loop: loop.name,
        total,
        failures: failures.length,
        repositoriesWithoutItems: repositoriesWithoutItems.length,
      });
      return new LoopPreview({
        items: matched,
        total,
        prompt: selected,
        failures,
        repositoriesWithoutItems,
        stream: loop.trigger.on,
      });
    },
    Effect.provideService(ExpressionEngine, expressions),
    Effect.catchTag("EnginePersistenceError", (cause) =>
      Effect.fail(new ConfigurationStoreError({ operation: "preview loop", cause })),
    ),
  );
  return { checkLoop: check, previewLoop: preview };
});
