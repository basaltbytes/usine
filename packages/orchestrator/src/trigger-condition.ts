import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { matchesLoop } from "@usine/config/project";
import { canonicalRepositoryName } from "@usine/core/repository";
import type { Submission } from "@usine/engine/engine";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import {
  ChangedIssue,
  ChangedPullRequest,
  GitHubPolling,
  PullRequestSnapshot,
} from "@usine/github/polling";
import { Effect, Layer, Option, Schema } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { repositoryFailureLogFields } from "./polling/cycle.ts";
import { GitHubItemKey } from "@usine/core/item";

const decodeItemKey = Schema.decodeUnknownOption(GitHubItemKey);

/**
 * Re-evaluates a queued Event's trigger against a fresh GitHub snapshot of its Item. Returns
 * `item-gone` if the Item no longer exists, and `matches` on any other failure or after five
 * seconds.
 */
export const triggerConditionLayer: Layer.Layer<
  TriggerCondition,
  never,
  CurrentInstance | ExpressionEngine | GitHubPolling
> = Layer.effect(
  TriggerCondition,
  Effect.gen(function* () {
    const github = yield* GitHubPolling;
    const expressions = yield* ExpressionEngine;
    const instances = yield* CurrentInstance;

    const evaluate = Effect.fn("TriggerCondition.evaluate")(function* (submission: Submission) {
      const fields = {
        loop: submission.loop,
        repository: submission.repository,
        itemKey: submission.itemKey,
      };
      const instance = yield* instances.get;
      const loop = instance.loops.find(({ name }) => name === submission.loop);
      if (loop === undefined) {
        yield* Effect.logInfo("Queued Event belongs to a Loop that is no longer loaded", fields);
        return "no-longer-matches";
      }
      const repository = instance.config.repos.find(
        ({ name }) =>
          canonicalRepositoryName(name) === canonicalRepositoryName(submission.repository),
      );
      if (repository === undefined || !matchesLoop(instance.config, loop, repository)) {
        yield* Effect.logInfo("Queued Event's repository is no longer watched by its Loop", {
          ...fields,
          managed: repository !== undefined,
        });
        return "no-longer-matches";
      }
      if (loop.trigger.on === "schedule") return "matches";
      const item = decodeItemKey(submission.itemKey);
      if (Option.isNone(item)) {
        yield* Effect.logWarning(
          "Queued Event's Item key is not a GitHub Item; opening as before",
          fields,
        );
        return "matches";
      }
      const [, , number] = item.value;
      const changed =
        loop.trigger.on === "pr"
          ? new ChangedPullRequest({ number, updatedAt: submission.event.receivedAt })
          : new ChangedIssue({ number, updatedAt: submission.event.receivedAt });
      const snapshot = yield* github.snapshot(repository.name, changed);
      if (Option.isSome(submission.ciFailureHead)) {
        if (!(snapshot instanceof PullRequestSnapshot)) {
          yield* Effect.logInfo("Queued CI fix no longer belongs to a pull request", {
            ...fields,
            head: submission.ciFailureHead.value,
          });
          return "no-longer-matches";
        }
        const holds =
          snapshot.payload.state === "OPEN" &&
          snapshot.payload.headRefOid === submission.ciFailureHead.value &&
          (snapshot.payload.statusCheckRollup?.state === "FAILURE" ||
            snapshot.payload.statusCheckRollup?.state === "ERROR" ||
            (snapshot.payload.statusCheckRollup === null &&
              (snapshot.payload.mergeable === "CONFLICTING" ||
                snapshot.payload.mergeable === "UNKNOWN")));
        yield* Effect.logInfo("Queued CI fix rechecked against its recorded head", {
          ...fields,
          head: submission.ciFailureHead.value,
          holds,
          mergeable: snapshot.payload.mergeable,
          checkState: snapshot.payload.statusCheckRollup?.state ?? "absent",
        });
        return holds ? "matches" : "no-longer-matches";
      }
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
      return holds ? "matches" : "no-longer-matches";
    });

    const recheck = Effect.fn("TriggerCondition.recheck")(
      function* (submission: Submission) {
        yield* Effect.annotateCurrentSpan({
          loop: submission.loop,
          repository: submission.repository,
          itemKey: submission.itemKey,
        });
        // Bound the whole re-check so a stalled read cannot retain the closed
        // Run's continuation and block the Item or an operator retry.
        return yield* evaluate(submission).pipe(Effect.timeout("5 seconds"));
      },
      (effect, submission) =>
        effect.pipe(
          Effect.catchTag("GitHubItemNotFoundError", (error) =>
            Effect.logInfo("Queued Event's Item is gone from GitHub; its Events are revoked", {
              loop: submission.loop,
              repository: submission.repository,
              itemKey: submission.itemKey,
              item: error.item,
              errorTag: error._tag,
              message: error.message,
            }).pipe(Effect.as("item-gone" as const)),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Trigger re-check failed; opening the queued Event as before", {
              loop: submission.loop,
              repository: submission.repository,
              itemKey: submission.itemKey,
              ...(error._tag === "TimeoutError"
                ? { errorTag: error._tag, message: "Trigger re-check exceeded five seconds" }
                : repositoryFailureLogFields(error)),
            }).pipe(Effect.as("matches" as const)),
          ),
        ),
    );

    return { recheck };
  }),
);
