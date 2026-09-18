import type { LoadedInstance } from "@usine/config/instance";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { matchesSelector } from "@usine/config/selector";
import { canonicalRepositoryName } from "@usine/core/repository";
import type { Submission } from "@usine/engine/engine";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { ChangedIssue, ChangedPullRequest, GitHubPolling } from "@usine/github/polling";
import { Effect, Layer, Option, Schema } from "effect";
import { repositoryFailureLogFields } from "./polling/cycle.ts";
import { GitHubItemKey } from "./polling/repository-sync.ts";

const decodeItemKey = Schema.decodeUnknownOption(GitHubItemKey);

/**
 * Re-evaluates a queued Event's trigger against a fresh GitHub snapshot of its
 * Item, using the Loops and registry of the loaded instance. The stored
 * projection is not enough: the Run that just closed may have changed the
 * Item after the poll that recorded the Event and before the next poll. A
 * check that cannot complete answers `true`, so the Run opens as it did
 * before the check existed; the next poll revokes it if the Item moved on.
 */
export const triggerConditionLayer = (
  instance: LoadedInstance,
): Layer.Layer<TriggerCondition, never, ExpressionEngine | GitHubPolling> =>
  Layer.effect(
    TriggerCondition,
    Effect.gen(function* () {
      const github = yield* GitHubPolling;
      const expressions = yield* ExpressionEngine;
      const loops = new Map(instance.loops.map((loop) => [loop.name, loop]));
      const repositories = new Map(
        instance.config.repos.map((repository) => [
          canonicalRepositoryName(repository.name),
          repository,
        ]),
      );

      const evaluate = Effect.fn("TriggerCondition.evaluate")(function* (submission: Submission) {
        const fields = {
          loop: submission.loop,
          repository: submission.repository,
          itemKey: submission.itemKey,
        };
        const loop = loops.get(submission.loop);
        if (loop === undefined) {
          yield* Effect.logInfo("Queued Event belongs to a Loop that is no longer loaded", fields);
          return false;
        }
        if (loop.trigger.on === "schedule") return true;
        const repository = repositories.get(canonicalRepositoryName(submission.repository));
        if (repository === undefined || !matchesSelector(loop.selector, repository)) {
          yield* Effect.logInfo("Queued Event's repository is no longer watched by its Loop", {
            ...fields,
            managed: repository !== undefined,
          });
          return false;
        }
        const item = decodeItemKey(submission.itemKey);
        if (Option.isNone(item)) {
          yield* Effect.logWarning(
            "Queued Event's Item key is not a GitHub Item; opening as before",
            fields,
          );
          return true;
        }
        const [, , number] = item.value;
        const changed =
          loop.trigger.on === "pr"
            ? new ChangedPullRequest({ number, updatedAt: submission.event.receivedAt })
            : new ChangedIssue({ number, updatedAt: submission.event.receivedAt });
        const snapshot = yield* github.snapshot(repository.name, changed);
        const holds = yield* expressions.evaluateBoolean(
          loop.trigger.if,
          environmentFor(loop.trigger.on),
          { repo: repositoryContext(repository), item: snapshot.payload },
        );
        yield* Effect.logInfo("Queued Event re-evaluated against the Item's current state", {
          ...fields,
          item: number,
          contentHash: snapshot.contentHash,
          holds,
        });
        return holds;
      });

      const holds = Effect.fn("TriggerCondition.holds")(
        function* (submission: Submission) {
          yield* Effect.annotateCurrentSpan({
            loop: submission.loop,
            repository: submission.repository,
            itemKey: submission.itemKey,
          });
          return yield* evaluate(submission);
        },
        (effect, submission) =>
          Effect.catch(effect, (error) =>
            Effect.logWarning("Trigger re-check failed; opening the queued Event as before", {
              loop: submission.loop,
              repository: submission.repository,
              itemKey: submission.itemKey,
              ...repositoryFailureLogFields(error),
            }).pipe(Effect.as(true)),
          ),
      );

      return { holds };
    }),
  );
