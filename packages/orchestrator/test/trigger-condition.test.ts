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
import { GitHubPolling } from "@usine/github/polling";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { triggerConditionLayer } from "../src/trigger-condition.ts";

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

const layerWith = (github: GitHubPolling["Service"]) =>
  triggerConditionLayer(instance).pipe(
    Layer.provide(Layer.succeed(GitHubPolling, github)),
    Layer.provide(MarcbachmannCelLayer),
  );

const failingGitHub: GitHubPolling["Service"] = {
  changes: () => Effect.die("unused"),
  labels: () => Effect.die("unused"),
  snapshot: () =>
    Effect.fail(
      new GitHubApiError({
        operation: "fetch-issue-snapshot",
        status: Option.some(502),
        message: "GitHub rejected the request with status 502",
      }),
    ),
};

describe("TriggerCondition", () => {
  it.effect("keeps the queued Event's turn when the fresh snapshot cannot be fetched", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const holds = yield* condition.holds(
        submissionFor(issueLoop.name, '["github","basaltbytes/usine",28]'),
      );
      assert.strictEqual(holds, true);
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );

  it.effect("never re-fetches for a schedule Tick, which has no standing condition", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const holds = yield* condition.holds(
        submissionFor(scheduleLoop.name, '["github","basaltbytes/usine"]'),
      );
      assert.strictEqual(holds, true);
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );

  it.effect("drops a queued Event whose Loop is no longer loaded", () =>
    Effect.gen(function* () {
      const condition = yield* TriggerCondition;
      const holds = yield* condition.holds(
        submissionFor(LoopName.make("retired"), '["github","basaltbytes/usine",28]'),
      );
      assert.strictEqual(holds, false);
    }).pipe(Effect.provide(layerWith(failingGitHub))),
  );
});
