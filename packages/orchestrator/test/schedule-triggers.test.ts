import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ModelId } from "@usine/core/agent/brain";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { AgentFile } from "@usine/config/agent";
import { ConfigFileError, InstancePath } from "@usine/config/file";
import { Cron as CronExpression, ScheduleTrigger, TimeZone } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { Selector } from "@usine/config/selector";
import { UsineConfig } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine, Claimed, EnginePersistenceError, type Submission } from "@usine/engine/engine";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import { StepExecutor } from "@usine/engine/step-executor";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Source } from "@usine/expression/expression-engine";
import {
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { alwaysHoldsLayer } from "./support/polling.ts";
import {
  ScheduleCronFailure,
  ScheduleTickFailure,
  ScheduleTriggers,
} from "../src/schedule-triggers.ts";

const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});

const isSchedulePayload = Schema.is(
  Schema.Struct({
    tick: Schema.Struct({
      scheduledAt: Schema.String,
      scheduledAtLocal: Schema.String,
      cron: CronExpression,
      tz: TimeZone,
    }),
  }),
);

const configWith = (repos: ReadonlyArray<{ readonly name: string; readonly tags?: string[] }>) =>
  Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos });

const scheduleLoop = (
  config: UsineConfig,
  options: {
    readonly cron: string;
    readonly body?: string;
    readonly expression?: string;
    readonly name?: string;
    readonly selectedTag?: string;
    readonly tz?: string;
  },
) =>
  new LoopFile({
    name: LoopName.make(options.name ?? "scheduled-maintenance"),
    trigger: new ScheduleTrigger({
      on: "schedule",
      if: Source.make(options.expression ?? "true"),
      cron: Schema.decodeUnknownSync(CronExpression)(options.cron),
      tz: Schema.decodeUnknownSync(TimeZone)(options.tz ?? "UTC"),
    }),
    selector:
      options.selectedTag === undefined
        ? Option.none()
        : Option.some(
            new Selector({
              repos: Option.none(),
              tags: Option.some([
                config.repos
                  .flatMap(({ tags }) => tags)
                  .find((tag) => tag === options.selectedTag) ??
                  assert.fail("missing selected registry tag"),
              ]),
            }),
          ),
    approval: "required",
    step: StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make(options.body ?? "Run maintenance for {{ repo.name }}."),
  });

const instanceWith = (config: UsineConfig, loops: ReadonlyArray<LoopFile>) =>
  new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
    warnings: [],
  });

const fakeLayer = (
  submissions: Ref.Ref<ReadonlyArray<Submission>>,
  failRepository: Option.Option<string> = Option.none(),
  parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer)),
  states: ReadonlyArray<LoopRuntimeState> = [],
) => {
  const runs = Layer.succeed(RunEngine)({
    resolveFailure: () => Effect.void,
    intervene: () => Effect.void,
    approve: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    reconcile: () => Effect.die("unused"),
    drain: () => Effect.void,
    retry: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    submit: (submission) =>
      Option.contains(failRepository, submission.repository)
        ? Effect.fail(
            new EnginePersistenceError({
              operation: "record-scheduled-event",
              cause: new Error("database unavailable"),
            }),
          )
        : Ref.update(submissions, (values) => [...values, submission]).pipe(
            Effect.as(
              new Claimed({
                eventId: submission.event.id,
                runId: RunId.make(`run-${submission.event.id}`),
              }),
            ),
          ),
    transcript: () => Effect.die("unused"),
  });
  const loopControl = Layer.succeed(LoopControl)({
    isPaused: (loop) => Effect.succeed(states.some((state) => state.loop === loop && state.paused)),
    pause: () => Effect.die("unused"),
    states: Effect.succeed(states),
    unpause: () => Effect.die("unused"),
  });
  const dependencies = Layer.mergeAll(runs, loopControl, MarcbachmannCelLayer, parser);
  return ScheduleTriggers.layer.pipe(Layer.provide(dependencies));
};

const waitForWaiting = Effect.fn("test.waitForWaiting")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
) {
  for (let poll = 0; poll < 500; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (snapshot.run.state._tag === "Waiting") return snapshot;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Run ${runId} did not reach Waiting`);
});

const runtimeLayer = (directory: InstanceDirectory) => {
  const executor = Layer.succeed(StepExecutor)({
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover: () => Effect.void,
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    reserve: () => Effect.die("an approval-gated test run must not reserve a worker"),
    execute: () => Effect.die("an approval-gated test run must not start an Attempt"),
  });
  const engine = localEngineLayer(directory).pipe(
    Layer.provide(executor),
    Layer.provide(alwaysHoldsLayer),
  );
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(engine, MarcbachmannCelLayer, parser);
  return Layer.merge(dependencies, ScheduleTriggers.layer.pipe(Layer.provide(dependencies)));
};

describe("ScheduleTriggers", () => {
  it.effect("skips paused schedule Loops and exposes the latest cycle", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/usine" }]);
      const loop = scheduleLoop(config, { cron: "* * * * *" });
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      const state = new LoopRuntimeState({ loop: loop.name, paused: true });

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const cycle = yield* schedules.tick(instanceWith(config, [loop]));
        assert.strictEqual(cycle.loops, 0);
        assert.strictEqual(cycle.fanout, 0);
        const latest = yield* schedules.latest;
        assert(Option.isSome(latest));
        assert.strictEqual(latest.value, cycle);
      }).pipe(Effect.provide(fakeLayer(submissions, Option.none(), undefined, [state])));
    }),
  );

  it.effect("fans the latest due Tick out once per selected repository in its IANA zone", () =>
    Effect.gen(function* () {
      const config = configWith([
        { name: "basaltbytes/one", tags: ["active"] },
        { name: "basaltbytes/two", tags: ["active"] },
        { name: "basaltbytes/idle", tags: ["inactive"] },
      ]);
      const loop = scheduleLoop(config, {
        cron: "0 9 * * *",
        tz: "Europe/Warsaw",
        selectedTag: "active",
        expression: 'item.tick.tz == "Europe/Warsaw" && repo.owner == "basaltbytes"',
      });
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      yield* TestClock.setTime(Date.parse("2026-08-31T08:45:30.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const cycle = yield* schedules.tick(instanceWith(config, [loop]));
        const captured = yield* Ref.get(submissions);
        assert(captured.every((submission) => submission.revision === "HEAD"));

        assert.strictEqual(cycle.loops, 1);
        assert.strictEqual(cycle.fanout, 2);
        assert.strictEqual(cycle.submissions.length, 2);
        assert.strictEqual(cycle.skipped, 0);
        assert.strictEqual(cycle.failures.length, 0);
        assert.deepStrictEqual(
          captured.map(({ repository }) => repository),
          ["basaltbytes/one", "basaltbytes/two"],
        );
        for (const submission of captured) {
          assert.strictEqual(submission.task, `Run maintenance for ${submission.repository}.`);
          assert.strictEqual(submission.agent.name, agent.name);
          assert.strictEqual(submission.agent.brain.model, agent.model);
          assert(Option.isNone(submission.parentModel));
          assert.deepStrictEqual(submission.event.payload, {
            tick: {
              scheduledAt: "2026-08-31T07:00:00.000Z",
              scheduledAtLocal: "2026-08-31T09:00:00.000+02:00[Europe/Warsaw]",
              cron: "0 9 * * *",
              tz: "Europe/Warsaw",
            },
          });
          assert.strictEqual(
            DateTime.formatIso(submission.event.receivedAt),
            "2026-08-31T08:45:30.000Z",
          );
          assert.strictEqual(
            submission.itemKey,
            JSON.stringify(["github", submission.repository.toLowerCase()]),
          );
        }
        assert(
          Option.isSome(cycle.nextTickAt) &&
            DateTime.formatIso(cycle.nextTickAt.value) === "2026-09-01T07:00:00.000Z",
        );
      }).pipe(Effect.provide(fakeLayer(submissions)));
    }),
  );

  it.effect(
    "includes an exact-boundary Tick and catches up only the latest missed occurrence",
    () =>
      Effect.gen(function* () {
        const config = configWith([{ name: "basaltbytes/usine" }]);
        const loop = scheduleLoop(config, { cron: "* * * * *" });
        const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
        yield* TestClock.setTime(Date.parse("2026-08-31T10:00:00.000Z"));

        yield* Effect.gen(function* () {
          const schedules = yield* ScheduleTriggers;
          yield* schedules.tick(instanceWith(config, [loop]));
          // The orchestrator is down for several occurrences: no cycles run.
          yield* TestClock.adjust("365 seconds");
          yield* schedules.tick(instanceWith(config, [loop]));

          assert.deepStrictEqual(
            (yield* Ref.get(submissions)).map(({ event }) => event.payload),
            [
              {
                tick: {
                  scheduledAt: "2026-08-31T10:00:00.000Z",
                  scheduledAtLocal: "2026-08-31T10:00:00.000+00:00[UTC]",
                  cron: "* * * * *",
                  tz: "UTC",
                },
              },
              {
                tick: {
                  scheduledAt: "2026-08-31T10:06:00.000Z",
                  scheduledAtLocal: "2026-08-31T10:06:00.000+00:00[UTC]",
                  cron: "* * * * *",
                  tz: "UTC",
                },
              },
            ],
          );
        }).pipe(Effect.provide(fakeLayer(submissions)));
      }),
  );

  it.effect("sleeps to the cron boundary instead of the GitHub poll interval", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/usine" }]);
      const loop = scheduleLoop(config, { cron: "* * * * *" });
      const instance = instanceWith(config, [loop]);
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      yield* TestClock.setTime(Date.parse("2026-08-31T10:00:30.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const fiber = yield* Effect.forkChild(schedules.run(Effect.succeed(instance)));
        // Wait on the observable outcome, not on a scheduler-op budget.
        for (let spin = 0; (yield* Ref.get(submissions)).length === 0; spin += 1) {
          if (spin > 1_000) return yield* Effect.die("the first cycle never submitted");
          yield* Effect.yieldNow;
        }
        assert.strictEqual((yield* Ref.get(submissions)).length, 1);
        yield* TestClock.adjust("29 seconds");
        assert.strictEqual((yield* Ref.get(submissions)).length, 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Ref.get(submissions)).length, 2);
        assert.deepStrictEqual(
          (yield* Ref.get(submissions)).map(({ event }) => event.payload),
          [
            {
              tick: {
                scheduledAt: "2026-08-31T10:00:00.000Z",
                scheduledAtLocal: "2026-08-31T10:00:00.000+00:00[UTC]",
                cron: "* * * * *",
                tz: "UTC",
              },
            },
            {
              tick: {
                scheduledAt: "2026-08-31T10:01:00.000Z",
                scheduledAtLocal: "2026-08-31T10:01:00.000+00:00[UTC]",
                cron: "* * * * *",
                tz: "UTC",
              },
            },
          ],
        );
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(fakeLayer(submissions)));
    }),
  );

  it.effect("isolates one selected repository failure from sibling fanout", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/failing" }, { name: "basaltbytes/healthy" }]);
      const loop = scheduleLoop(config, { cron: "0 0 1 1 *" });
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      yield* TestClock.setTime(Date.parse("2026-08-31T10:00:00.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const cycle = yield* schedules.tick(instanceWith(config, [loop]));

        assert.strictEqual(cycle.fanout, 2);
        assert.strictEqual(cycle.submissions.length, 1);
        assert.strictEqual(cycle.failures.length, 1);
        const failure = cycle.failures[0];
        assert(failure instanceof ScheduleTickFailure);
        assert.strictEqual(failure.repository, "basaltbytes/failing");
        assert.strictEqual(failure.errorTag, "EnginePersistenceError");
        assert.deepStrictEqual(
          (yield* Ref.get(submissions)).map(({ repository }) => repository),
          ["basaltbytes/healthy"],
        );
      }).pipe(Effect.provide(fakeLayer(submissions, Option.some("basaltbytes/failing"))));
    }),
  );

  it.effect("isolates one loop's prompt rendering failure from sibling schedules", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/usine" }]);
      const broken = scheduleLoop(config, {
        cron: "0 0 1 1 *",
        name: "broken-prompt",
        body: "Run {{ item.tick.missing }}.",
      });
      const healthy = scheduleLoop(config, { cron: "0 0 1 1 *", name: "healthy-prompt" });
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      const parser = Layer.succeed(ConfigParser)({
        parseAgentFile: () => Effect.die("unused"),
        parseLoopFile: () => Effect.die("unused"),
        parseUsineYaml: () => Effect.die("unused"),
        configWarnings: () => Effect.succeed([]),
        renderPrompt: (loop) =>
          loop.name === broken.name
            ? Effect.fail(
                new ConfigFileError({
                  file: InstancePath.make(`loops/${loop.name}.md`),
                  stage: "expression",
                  expression: Option.some(Source.make("item.tick.missing")),
                  message: "No such key: missing",
                }),
              )
            : Effect.succeed(`Rendered ${loop.name}.`),
      });
      yield* TestClock.setTime(Date.parse("2026-08-31T10:00:00.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const cycle = yield* schedules.tick(instanceWith(config, [broken, healthy]));

        assert.strictEqual(cycle.fanout, 2);
        assert.strictEqual(cycle.submissions.length, 1);
        assert.strictEqual(cycle.failures.length, 1);
        const failure = cycle.failures[0];
        assert(failure instanceof ScheduleTickFailure);
        assert.strictEqual(failure.loop, broken.name);
        assert.strictEqual(failure.errorTag, "ConfigFileError");
        assert.deepStrictEqual(
          (yield* Ref.get(submissions)).map(({ loop, task }) => ({ loop, task })),
          [{ loop: healthy.name, task: `Rendered ${healthy.name}.` }],
        );
      }).pipe(Effect.provide(fakeLayer(submissions, Option.none(), parser)));
    }),
  );

  it.effect("keeps evaluating when a cron minute falls in a DST spring-forward gap", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/usine" }]);
      // Warsaw skips 02:00-03:00 local on 2026-03-29 (01:00Z), so Cron.prev
      // throws for this instant. The stream must fail only this schedule and
      // keep returning cycles.
      const loop = scheduleLoop(config, { cron: "30 2 * * *", tz: "Europe/Warsaw" });
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      yield* TestClock.setTime(Date.parse("2026-03-29T01:30:00.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const cycle = yield* schedules.tick(instanceWith(config, [loop]));

        assert.strictEqual(cycle.fanout, 0);
        assert.strictEqual(cycle.submissions.length, 0);
        assert.strictEqual(cycle.failures.length, 1);
        const failure = cycle.failures[0];
        assert(failure instanceof ScheduleCronFailure);
        assert.strictEqual(failure.loop, "scheduled-maintenance");
        assert.strictEqual(failure.tz, "Europe/Warsaw");
        // With no computable boundary the run loop falls back to its idle wake.
        assert(Option.isNone(cycle.nextTickAt));
      }).pipe(Effect.provide(fakeLayer(submissions)));
    }),
  );

  it.effect("fires a coarser schedule once, not on every finer-grained cycle", () =>
    Effect.gen(function* () {
      const config = configWith([{ name: "basaltbytes/usine" }]);
      const minutely = scheduleLoop(config, { cron: "* * * * *", name: "minutely" });
      const daily = scheduleLoop(config, { cron: "0 9 * * *", name: "daily" });
      const instance = instanceWith(config, [minutely, daily]);
      const submissions = yield* Ref.make<ReadonlyArray<Submission>>([]);
      yield* TestClock.setTime(Date.parse("2026-08-31T10:00:00.000Z"));

      yield* Effect.gen(function* () {
        const schedules = yield* ScheduleTriggers;
        const first = yield* schedules.tick(instance);
        assert.strictEqual(first.submissions.length, 2);
        assert.strictEqual(first.alreadyFired, 0);

        yield* TestClock.adjust("60 seconds");
        const second = yield* schedules.tick(instance);
        // The daily loop's 09:00 tick already fired: no duplicate submit, no
        // duplicate log line, and the cycle says so.
        assert.strictEqual(second.submissions.length, 1);
        assert.strictEqual(second.alreadyFired, 1);
        assert.deepStrictEqual(
          (yield* Ref.get(submissions)).map(({ loop }) => loop),
          ["minutely", "daily", "minutely"],
        );

        // A reload that moves the daily boundary earlier forgets the fired
        // Ticks, as a restart does, so the moved schedule's latest Tick fires.
        const reloaded = instanceWith(config, [
          minutely,
          scheduleLoop(config, { cron: "30 8 * * *", name: "daily" }),
        ]);
        yield* TestClock.adjust("60 seconds");
        const third = yield* schedules.tick(reloaded);
        assert.strictEqual(third.alreadyFired, 0);
        assert.deepStrictEqual(
          (yield* Ref.get(submissions)).map(({ loop }) => loop),
          ["minutely", "daily", "minutely", "minutely", "daily"],
        );
      }).pipe(Effect.provide(fakeLayer(submissions)));
    }),
  );

  it.live("deduplicates one scheduled Event across engine restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-schedules-" }),
      );
      const config = configWith([{ name: "basaltbytes/usine" }]);
      const instance = instanceWith(config, [scheduleLoop(config, { cron: "0 0 1 1 *" })]);

      const firstScope = yield* Scope.make();
      const firstContext = yield* Scope.provide(Layer.build(runtimeLayer(directory)), firstScope);
      const firstSchedules = Context.get(firstContext, ScheduleTriggers);
      const firstEngine = Context.get(firstContext, RunEngine);
      const firstCycle = yield* firstSchedules.tick(instance);
      const first = firstCycle.submissions[0];
      assert(first !== undefined && first._tag === "Claimed");
      const snapshot = yield* waitForWaiting(firstEngine, first.runId);
      assert(isSchedulePayload(snapshot.event.payload));
      assert.deepStrictEqual(Object.keys(snapshot.event.payload), ["tick"]);
      // In-process, the fired-tick memory suppresses the duplicate entirely.
      const duplicateCycle = yield* firstSchedules.tick(instance);
      assert.strictEqual(duplicateCycle.submissions.length, 0);
      assert.strictEqual(duplicateCycle.alreadyFired, 1);
      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      const secondContext = yield* Scope.provide(Layer.build(runtimeLayer(directory)), secondScope);
      const afterRestart = (yield* Context.get(secondContext, ScheduleTriggers).tick(instance))
        .submissions[0];
      assert(afterRestart !== undefined && afterRestart._tag === "Claimed");
      assert.strictEqual(afterRestart.runId, first.runId);
      yield* Scope.close(secondScope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
