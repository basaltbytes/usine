import { assert, describe, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { Cron, IssueTrigger, ScheduleTrigger, TimeZone } from "@usine/config/trigger";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { Submission } from "@usine/engine/engine";
import { TriggerCondition } from "@usine/engine/trigger-condition";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { GitHubApiError } from "@usine/github/github-app";
import { GitHubItemNotFoundError, GitHubPolling } from "@usine/github/polling";
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Schema, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { triggerConditionLayer } from "../src/trigger-condition.ts";
import { fixedInstanceLayer } from "./support/current-instance.ts";
import { unmovedBaseRefHead } from "./support/polling.ts";

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [{ name: "basaltbytes/usine" }],
});

const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});

const issueLoop = new LoopFile({
  name: LoopName.make("start-dev"),
  trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
  selector: Option.none(),
  approval: "none",
  step: StepName.make("run"),
  agent: agent.name,
  body: PromptTemplate.make("Implement issue {{ item.number }}."),
});

const scheduleLoop = new LoopFile({
  ...issueLoop,
  name: LoopName.make("nightly"),
  trigger: new ScheduleTrigger({
    on: "schedule",
    if: Source.make("true"),
    cron: Schema.decodeUnknownSync(Cron)("0 3 * * *"),
    tz: Schema.decodeUnknownSync(TimeZone)("UTC"),
  }),
});

const instance = new LoadedInstance({
  config,
  agents: [agent],
  invalidAgents: [],
  loops: [issueLoop, scheduleLoop],
  quarantinedLoops: [],
  warnings: [],
});

const submissionFor = (loop: LoopName, itemKey: string) =>
  new Submission({
    event: new Event({
      id: EventId.make(`event-${loop}`),
      dedupKey: DedupKey.make(`dedup-${loop}`),
      payload: {},
      receivedAt: DateTime.makeUnsafe("2026-09-18T04:08:10Z"),
    }),
    itemKey: ItemKey.make(itemKey),
    loop,
    step: StepName.make("run"),
    approval: "none",
    repository: RepositoryName.make("basaltbytes/usine"),
    revision: RepositoryRevision.make("HEAD"),
    task: AttemptTask.make("Implement issue 28."),
    agent: agent.agent,
    parentModel: Option.none(),
  });

const layerWith = (
  github: GitHubPolling["Service"],
  current: Layer.Layer<CurrentInstance> = fixedInstanceLayer(instance),
) =>
  triggerConditionLayer.pipe(
    Layer.provide(Layer.succeed(GitHubPolling, github)),
    Layer.provide(MarcbachmannCelLayer),
    Layer.provide(current),
  );

const failingGitHub: GitHubPolling["Service"] = {
  baseRefHead: unmovedBaseRefHead,
  missingIssues: () => Effect.succeed([]),
  changes: () => Effect.die("unused"),
  labels: () => Effect.die("unused"),
  snapshot: () =>
    Effect.fail(
      new GitHubApiError({
        operation: "fetch-issue-snapshot",
        status: Option.some(502),
        message: "GitHub returned HTTP status 502",
      }),
    ),
};

describe("TriggerCondition", () => {
  it.effect("keeps the queued Event's turn when the fresh snapshot cannot be fetched", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const recheck = yield* condition.recheck(
        submissionFor(issueLoop.name, '["github","basaltbytes/usine",28]'),
      );
      assert.strictEqual(recheck, "matches");
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );

  it.effect("reports the Item gone when GitHub no longer has it", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const recheck = yield* condition.recheck(
        submissionFor(issueLoop.name, '["github","basaltbytes/usine",28]'),
      );
      assert.strictEqual(recheck, "item-gone");
    }).pipe(
      Effect.provide(
        layerWith({
          ...failingGitHub,
          snapshot: (repository, item) =>
            Effect.fail(
              new GitHubItemNotFoundError({
                operation: "fetch-issue-snapshot",
                item: item.number,
                message: `GitHub has no issue ${item.number} in ${repository}`,
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("interrupts a hung snapshot and keeps the queued Event's turn after five seconds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const github: GitHubPolling["Service"] = {
        ...failingGitHub,
        snapshot: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      };
      const fiber = yield* Effect.gen(function* () {
        const condition = yield* TriggerCondition;
        return yield* condition.recheck(
          submissionFor(issueLoop.name, '["github","basaltbytes/usine",28]'),
        );
      }).pipe(Effect.provide(layerWith(github)), Effect.forkChild);

      yield* Deferred.await(started);
      yield* TestClock.adjust("4 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(fiber), "matches");
      assert.isTrue(yield* Deferred.isDone(interrupted));
    }),
  );

  it.effect("never re-fetches for a schedule Tick, which has no standing condition", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const recheck = yield* condition.recheck(
        submissionFor(scheduleLoop.name, '["github","basaltbytes/usine"]'),
      );
      assert.strictEqual(recheck, "matches");
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );

  it.effect(
    "re-checks against the current instance, so a reload that removes a Loop drops its Events",
    () =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.make(instance);
        const reloadable = Layer.succeed(CurrentInstance)({
          get: SubscriptionRef.get(current),
          changes: SubscriptionRef.changes(current),
          reload: Effect.die("the test swaps the instance itself"),
          registerWorkers: () => Effect.void,
          commit: () => Effect.die("the test swaps the instance itself"),
        });
        const submission = submissionFor(scheduleLoop.name, '["github","basaltbytes/usine"]');
        yield* Effect.gen(function* () {
          const condition = yield* TriggerCondition;
          assert.strictEqual(yield* condition.recheck(submission), "matches");
          yield* SubscriptionRef.set(
            current,
            new LoadedInstance({ ...instance, loops: [issueLoop] }),
          );
          assert.strictEqual(yield* condition.recheck(submission), "no-longer-matches");
        }).pipe(Effect.provide(layerWith(failingGitHub, reloadable)));
      }),
  );

  it.effect("drops a queued Event whose Loop is no longer loaded", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const recheck = yield* condition.recheck(
        submissionFor(LoopName.make("retired"), '["github","basaltbytes/usine",28]'),
      );
      assert.strictEqual(recheck, "no-longer-matches");
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );
});
