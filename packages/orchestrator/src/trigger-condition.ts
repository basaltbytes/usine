import type { ManagedRepo } from "@usine/config/factory";
import type { LoadedInstance } from "@usine/config/instance";
import type { LoopFile } from "@usine/config/loop";
import { environmentFor, repositoryContext } from "@usine/config/payload-slices";
import { matchesLoop } from "@usine/config/project";
import { canonicalRepositoryName } from "@usine/core/repository";
import type { Submission } from "@usine/engine/engine";
import {
  type AdmissionSettings,
  savedSettings,
  TriggerCondition,
  TriggerRecheck,
} from "@usine/engine/trigger-condition";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import {
  ChangedIssue,
  ChangedPullRequest,
  GitHubPolling,
  PullRequestSnapshot,
} from "@usine/github/polling";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { needsCiFix } from "./polling/ci-fix-state.ts";
import { repositoryFailureLogFields } from "./polling/cycle.ts";
import { loopSettings, resolveTriggerLoop, taskWithCiPolicy } from "./trigger-submission.ts";
import { GitHubItemKey } from "@usine/core/item";

const decodeItemKey = Schema.decodeUnknownOption(GitHubItemKey);

const logFields = (submission: Submission) => ({
  loop: submission.loop,
  repository: submission.repository,
  itemKey: submission.itemKey,
});

/**
 * Re-evaluates a queued Event's trigger against a fresh GitHub snapshot of its Item. Returns
 * `ItemGone` if the Item no longer exists, and `Undetermined` on any other GitHub failure or
 * after five seconds. A queued trigger match keeps its saved settings. A queued CI fix keeps its
 * recorded prompt and failure evidence; its approval, Agent, models, permissions, CI policy,
 * generated CI handoff instructions, outcome labels, and cycle limit follow its Loop's current
 * configuration.
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

    /** Returns the CI fix's current Loop settings, or `None` if the Loop lost its Agent. */
    const withCurrentSettings = Effect.fn("TriggerCondition.withCurrentSettings")(function* (
      instance: LoadedInstance,
      loop: LoopFile,
      repository: ManagedRepo,
      submission: Submission,
    ) {
      const resolved = yield* Effect.result(resolveTriggerLoop(instance, loop));
      if (Result.isFailure(resolved)) {
        yield* Effect.logWarning("Queued CI fix's Loop lost its rostered Agent; revoking it", {
          ...logFields(submission),
          agent: resolved.failure.agent,
          errorTag: resolved.failure._tag,
        });
        return Option.none<AdmissionSettings>();
      }
      const settings = yield* loopSettings(
        expressions,
        resolved.success,
        repository,
        submission.event.payload,
      );
      yield* Effect.logInfo("Queued CI fix takes its Loop's current settings", {
        ...logFields(submission),
        approval: settings.approval,
        agent: settings.agent.name,
        permissions: settings.permissions,
        cycleLimit: Option.getOrNull(settings.cycleLimit),
      });
      return Option.some<AdmissionSettings>({
        ...settings,
        task: taskWithCiPolicy(submission.task, settings.ciPolicy, submission.ciPolicy),
      });
    });

    const evaluate = Effect.fn("TriggerCondition.evaluate")(function* (
      loop: LoopFile,
      repository: ManagedRepo,
      submission: Submission,
      settings: AdmissionSettings,
    ) {
      const fields = logFields(submission);
      const matches = TriggerRecheck.Matches({ settings });
      if (loop.trigger.on === "schedule") return matches;
      const item = decodeItemKey(submission.itemKey);
      if (Option.isNone(item)) {
        yield* Effect.logWarning(
          "Queued Event's Item key is not a GitHub Item; opening as before",
          fields,
        );
        return matches;
      }
      const [, , number] = item.value;
      const changed =
        loop.trigger.on === "pr"
          ? ChangedPullRequest.make({ number, updatedAt: submission.event.receivedAt })
          : ChangedIssue.make({ number, updatedAt: submission.event.receivedAt });
      const snapshot = yield* github.snapshot(repository.name, changed);
      if (Option.isSome(submission.ciFailureHead)) {
        if (!Schema.is(PullRequestSnapshot)(snapshot)) {
          yield* Effect.logInfo("Queued CI fix no longer belongs to a pull request", {
            ...fields,
            head: submission.ciFailureHead.value,
          });
          return TriggerRecheck.NoLongerMatches();
        }
        const holds =
          snapshot.payload.headRefOid === submission.ciFailureHead.value &&
          needsCiFix(snapshot.payload);
        yield* Effect.logInfo("Queued CI fix rechecked against its recorded head", {
          ...fields,
          head: submission.ciFailureHead.value,
          holds,
          mergeable: snapshot.payload.mergeable,
          checkState: snapshot.payload.statusCheckRollup?.state ?? "absent",
        });
        return holds ? matches : TriggerRecheck.NoLongerMatches();
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
      return holds ? matches : TriggerRecheck.NoLongerMatches();
    });

    const recheck = Effect.fn("TriggerCondition.recheck")(function* (submission: Submission) {
      const fields = logFields(submission);
      yield* Effect.annotateCurrentSpan(fields);
      const instance = yield* instances.get;
      const loop = instance.loops.find(({ name }) => name === submission.loop);
      if (loop === undefined) {
        yield* Effect.logInfo("Queued Event belongs to a Loop that is no longer loaded", fields);
        return TriggerRecheck.NoLongerMatches();
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
        return TriggerRecheck.NoLongerMatches();
      }
      const settings = Option.isSome(submission.ciFailureHead)
        ? yield* withCurrentSettings(instance, loop, repository, submission)
        : Option.some(savedSettings(submission));
      if (Option.isNone(settings)) return TriggerRecheck.NoLongerMatches();
      // Bound the GitHub read so a stalled request cannot retain the closed Run's continuation
      // and block the Item or an operator retry.
      return yield* evaluate(loop, repository, submission, settings.value).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchTag("GitHubItemNotFoundError", (error) =>
          Effect.logInfo("Queued Event's Item is gone from GitHub; its Events are revoked", {
            ...fields,
            item: error.item,
            errorTag: error._tag,
            message: error.message,
          }).pipe(Effect.as(TriggerRecheck.ItemGone())),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Trigger re-check could not read the Item's current state", {
            ...fields,
            ...(error._tag === "TimeoutError"
              ? { errorTag: error._tag, message: "Trigger re-check exceeded five seconds" }
              : repositoryFailureLogFields(error)),
          }).pipe(Effect.as(TriggerRecheck.Undetermined())),
        ),
      );
    });

    return { recheck };
  }),
);
