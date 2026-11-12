import { DurableHarness } from "@usine/durable/harness";
import { fauxParent } from "@usine/durable/testing";
import { parentAdmissionLayer } from "../src/current-instance/parents.ts";
import { Harness } from "@usine/core/agent/brain";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  ConfigurationStore,
  ConfigurationChange,
  ConfigurationRevisionNumber,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schema,
  Stream,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import {
  coordinatorBrainTimeout,
  CurrentInstance,
} from "../src/current-instance/current-instance.ts";
import { writeInstanceFiles } from "./support/instance-folder.ts";

const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const dependencies = Layer.mergeAll(memoryConfigurationLayer, ConfigurationFolder.layer).pipe(
  Layer.provideMerge(parser),
);

it.live("applies committed agent brains and webhook settings live", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      [
        "usine.yaml",
        "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\nprojects: [{ id: acme-project, name: Project, repositories: [acme/project] }]\n",
      ],
      [
        "agents/developer.md",
        "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement the issue.\n",
      ],
      [
        "projects/acme-project/loops/implement.md",
        "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement.\n",
      ],
    ]);
    const services = yield* Layer.build(dependencies);
    const store = Context.get(services, ConfigurationStore);
    const initial = yield* Context.get(services, ConfigurationFolder).load(root);
    const decodedValue2 = configurationEntities(initial);
    const revision = yield* store.commit({
      expected: ConfigurationRevisionNumber.make(0),
      changes: configurationDiff([], decodedValue2),
      actor: initial.config.operator,
      message: Option.none(),
    });
    const context = yield* Layer.build(
      CurrentInstance.layer(root, initial, revision.number).pipe(
        Layer.provide(Layer.succeedContext(services)),
      ),
    );
    const current = Context.get(context, CurrentInstance);
    const unused = () => Effect.die("unused harness operation");
    yield* Layer.build(parentAdmissionLayer).pipe(
      Effect.provideService(CurrentInstance, current),
      Effect.provideService(DurableHarness, {
        ...fauxParent([]),
        install: unused,
        resume: unused,
        use: unused,
        subscribe: unused,
      }),
    );
    const preflighted: Array<string> = [];
    yield* current.registerWorkers((_, loaded) =>
      Effect.sync(() => {
        preflighted.push(...loaded.agents.map(({ harness }) => harness));
        return Effect.void;
      }),
    );
    const next = yield* current.changes.pipe(
      Stream.filter(({ agents }) => agents[0]?.harness === "claude"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    const agent = revision.changes.find(({ key }) => key.kind === "agent");
    if (agent === undefined) return yield* Effect.die("missing agent fixture");
    const agentAfter = yield* Effect.transposeOption(
      Option.map(agent.after, Schema.decodeUnknownEffect(Schema.JsonObject)),
    );
    const invalid = yield* Effect.flip(
      current.commit({
        expected: revision.number,
        actor: initial.config.operator,
        message: Option.none(),
        changes: [
          ConfigurationChange.make({
            ...agent,
            before: agent.after,
            after: Option.map(agentAfter, (value) => ({
              ...value,
              parentModel: { _tag: "Some", value: "unknown-provider/nonexistent-model" },
            })),
          }),
        ],
      }),
    );
    expect(invalid._tag).toBe("FactoryConfigError");
    expect((yield* store.read).number).toBe(revision.number);
    const unchanged = yield* current.get;
    expect(unchanged).toBe(initial);

    const changed = yield* store.commit({
      expected: revision.number,
      actor: initial.config.operator,
      message: Option.none(),
      changes: [
        ConfigurationChange.make({
          ...agent,
          before: agent.after,
          after: Option.map(agentAfter, (value) => ({
            ...value,
            harness: Harness.make("claude"),
          })),
        }),
      ],
    });
    yield* Fiber.join(next);
    expect(preflighted).toEqual(["claude"]);

    expect((yield* current.get).agents[0]?.agent.brain.harness).toBe("claude");
    const settings = revision.changes.find(({ key }) => key.kind === "settings");
    if (settings === undefined) return yield* Effect.die("missing settings fixture");
    const settingsAfter = yield* Effect.transposeOption(
      Option.map(settings.after, Schema.decodeUnknownEffect(Schema.JsonObject)),
    );
    yield* store.commit({
      expected: changed.number,
      actor: initial.config.operator,
      message: Option.none(),
      changes: [
        ConfigurationChange.make({
          ...settings,
          before: settings.after,
          after: Option.map(settingsAfter, (value) => ({
            ...value,
            webhooks: { mode: "deliveries" },
          })),
        }),
      ],
    });
    yield* current.reload;

    expect((yield* current.get).config.webhooks.mode).toBe("deliveries");

    expect(Option.map((yield* store.read).instance, ({ config }) => config.webhooks.mode)).toEqual(
      Option.some("deliveries"),
    );
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(NodeServices.layer)),
);

const StepLog = Schema.Struct({
  step: Schema.String,
  durationMillis: Schema.Finite,
  outcome: Schema.String,
});
type StepLog = typeof StepLog.Type;

/**
 * A logger that appends each `Configuration step finished` line to `steps`, and every message to
 * `messages`.
 */
const stepLogger = (steps: Array<StepLog>, messages: Array<unknown> = []) =>
  Logger.make<unknown, void>(({ message }) => {
    if (!Array.isArray(message)) return;
    messages.push(message[0]);
    if (message[0] !== "Configuration step finished") return;
    steps.push(...Option.toArray(Schema.decodeUnknownOption(StepLog)(message[1])));
  });

/** Runs `effect` with a tracer that appends each span it starts to `spans`. */
const recordingSpans =
  (spans: Array<Tracer.Span>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.service(Tracer.Tracer), (native) =>
      effect.pipe(
        Effect.withTracer(
          Tracer.make({
            span: (options) => {
              const span = native.span(options);
              spans.push(span);
              return span;
            },
          }),
        ),
      ),
    );

/**
 * Returns each `CurrentInstance.step` span in `spans` as the step log it should match. A span that
 * never ended has outcome `open`; a span outside a `CurrentInstance.commit` or
 * `CurrentInstance.reload` span has outcome `orphaned`.
 */
const stepSpans = (spans: ReadonlyArray<Tracer.Span>): Array<StepLog> =>
  spans
    .filter(({ name }) => name === "CurrentInstance.step")
    .map((span) => {
      const step = String(span.attributes.get("step"));
      if (span.status._tag !== "Ended") return { step, durationMillis: -1, outcome: "open" };
      const ancestors: Array<string> = [];
      for (let parent = span.parent; Option.isSome(parent) && parent.value._tag === "Span";) {
        ancestors.push(parent.value.name);
        parent = parent.value.parent;
      }
      const { startTime, endTime, exit } = span.status;
      return {
        step,
        durationMillis: Number((endTime - startTime) / 1_000_000n),
        outcome: !ancestors.some((name) =>
          ["CurrentInstance.commit", "CurrentInstance.reload"].includes(name),
        )
          ? "orphaned"
          : Exit.isSuccess(exit)
            ? "passed"
            : Exit.hasInterrupts(exit)
              ? "interrupted"
              : "failed",
      };
    });

/** Orders step logs so that lists recorded in a different order compare equal. */
const unordered = (steps: ReadonlyArray<StepLog>) =>
  [...steps].sort(
    (left, right) =>
      left.step.localeCompare(right.step) ||
      left.durationMillis - right.durationMillis ||
      left.outcome.localeCompare(right.outcome),
  );

const savedSteps = (wait: number, preflight = 0): Array<StepLog> =>
  [
    ["wait", wait],
    ["read", 0],
    ["parse", 0],
    ["restart", 0],
    ["coordinator-brains", 0],
    ["worker-preflight", preflight],
    ["store", 0],
    ["apply", 0],
  ].map(([step, durationMillis]) => ({
    step: String(step),
    durationMillis: Number(durationMillis),
    outcome: "passed",
  }));

/**
 * Builds the current instance over a stored reviewer agent, with a coordinator brain check that
 * signals `checking` and never finishes while `slow.value` is true.
 */
const revisionFixture = Effect.gen(function* () {
  const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  const root = InstanceDirectory.make(directory);
  yield* writeInstanceFiles(root, [
    ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
    [
      "agents/reviewer.md",
      "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nReview the pull request.\n",
    ],
  ]);
  const services = yield* Layer.build(dependencies);
  const store = Context.get(services, ConfigurationStore);
  const initial = yield* Context.get(services, ConfigurationFolder).load(root);
  const revision = yield* store.commit({
    expected: ConfigurationRevisionNumber.make(0),
    changes: configurationDiff([], configurationEntities(initial)),
    actor: initial.config.operator,
    message: Option.none(),
  });
  const context = yield* Layer.build(
    CurrentInstance.layer(root, initial, revision.number).pipe(
      Layer.provide(Layer.succeedContext(services)),
    ),
  );
  const current = Context.get(context, CurrentInstance);
  const slow = { value: false };
  const checking = yield* Deferred.make<void>();
  yield* current.registerParentAdmission(() =>
    slow.value
      ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.succeed([]),
  );
  const agent = revision.changes.find(({ key }) => key.kind === "agent");
  if (agent === undefined) return yield* Effect.die("missing agent fixture");
  const agentAfter = yield* Effect.transposeOption(
    Option.map(agent.after, Schema.decodeUnknownEffect(Schema.JsonObject)),
  );
  const persona = (value: string) =>
    Option.map(agentAfter, (after) => ({ ...after, persona: value }));
  /** The change from the reviewer's persona `before`, or the stored one, to `after`. */
  const edit = (after: string, before?: string) =>
    ConfigurationChange.make({
      ...agent,
      before: before === undefined ? agent.after : persona(before),
      after: persona(after),
    });
  /** Saves `change` through `CurrentInstance.commit` on top of revision `expected`. */
  const save = (expected: number, change: ConfigurationChange) =>
    current.commit({
      expected: ConfigurationRevisionNumber.make(expected),
      actor: initial.config.operator,
      message: Option.none(),
      changes: [change],
    });
  return { store, initial, revision, current, slow, checking, edit, save };
});

it.effect("refuses a save whose coordinator brain check is slow and stores no revision", () => {
  const steps: Array<StepLog> = [];
  return Effect.gen(function* () {
    const { store, initial, revision, current, slow, checking, edit, save } =
      yield* revisionFixture;
    yield* current.registerWorkers(() => Effect.succeed(Effect.void));
    slow.value = true;
    const saving = yield* save(revision.number, edit("Review again.")).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(checking);
    yield* TestClock.adjust(coordinatorBrainTimeout);
    const failure = yield* Fiber.join(saving);

    expect(failure._tag).toBe("ValidationTimeoutError");
    if (failure._tag !== "ValidationTimeoutError") return;
    expect(failure.step).toBe("coordinator-brains");
    expect(failure.message).toContain("didn't finish within 10 seconds");
    expect((yield* store.read).number).toBe(revision.number);
    const unchanged = yield* current.get;
    expect(unchanged).toBe(initial);
    expect(steps).toEqual([
      ...savedSteps(0).slice(0, 4),
      { step: "coordinator-brains", durationMillis: 10_000, outcome: "failed" },
    ]);
  }).pipe(Effect.scoped, Effect.withLogger(stepLogger(steps)), Effect.provide(NodeServices.layer));
});

it.effect("logs every step of a save that waits behind a running save", () => {
  const steps: Array<StepLog> = [];
  const spans: Array<Tracer.Span> = [];
  return Effect.gen(function* () {
    const { store, revision, current, edit, save } = yield* revisionFixture;
    const preflighting = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    let preflights = 0;
    yield* current.registerWorkers(() =>
      preflights++ === 0
        ? Deferred.succeed(preflighting, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(Effect.void),
          )
        : Effect.succeed(Effect.void),
    );
    const first = yield* save(revision.number, edit("First.")).pipe(Effect.forkChild);
    yield* Deferred.await(preflighting);
    const second = yield* save(revision.number + 1, edit("Second.", "First.")).pipe(
      Effect.forkChild,
    );
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* TestClock.adjust("2 seconds");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    expect((yield* store.read).number).toBe(revision.number + 2);
    expect(steps).toEqual([...savedSteps(0, 2_000), ...savedSteps(2_000)]);
    expect(unordered(stepSpans(spans))).toEqual(unordered(steps));
  }).pipe(
    Effect.scoped,
    Effect.withLogger(stepLogger(steps)),
    recordingSpans(spans),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("logs the wait of a save whose caller gives up and releases the queue", () => {
  const steps: Array<StepLog> = [];
  const spans: Array<Tracer.Span> = [];
  return Effect.gen(function* () {
    const { store, revision, current, edit, save } = yield* revisionFixture;
    const preflighting = yield* Deferred.make<void>();
    let stuck = true;
    yield* current.registerWorkers(() =>
      stuck
        ? Deferred.succeed(preflighting, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(Effect.void),
    );
    const first = yield* save(revision.number, edit("First.")).pipe(Effect.forkChild);
    yield* Deferred.await(preflighting);
    const second = yield* save(revision.number, edit("Second.")).pipe(Effect.forkChild);
    yield* Effect.repeat(Effect.yieldNow, { times: 10 });
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.interrupt(second);
    yield* Fiber.interrupt(first);

    expect(steps).toContainEqual({ step: "wait", durationMillis: 30_000, outcome: "interrupted" });
    expect(steps).toContainEqual({
      step: "worker-preflight",
      durationMillis: 30_000,
      outcome: "interrupted",
    });
    expect((yield* store.read).number).toBe(revision.number);
    stuck = false;
    yield* save(revision.number, edit("Third."));
    expect((yield* store.read).number).toBe(revision.number + 1);
    expect(unordered(stepSpans(spans))).toEqual(unordered(steps));
  }).pipe(
    Effect.scoped,
    Effect.withLogger(stepLogger(steps)),
    recordingSpans(spans),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("logs the brain check of a save whose caller gives up before the time limit", () => {
  const steps: Array<StepLog> = [];
  return Effect.gen(function* () {
    const { store, revision, current, slow, checking, edit, save } = yield* revisionFixture;
    yield* current.registerWorkers(() => Effect.succeed(Effect.void));
    slow.value = true;
    const saving = yield* save(revision.number, edit("Given up.")).pipe(Effect.forkChild);
    yield* Deferred.await(checking);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.interrupt(saving);

    expect(steps).toEqual([
      ...savedSteps(0).slice(0, 4),
      { step: "coordinator-brains", durationMillis: 5_000, outcome: "interrupted" },
    ]);
    expect((yield* store.read).number).toBe(revision.number);
    slow.value = false;
    yield* save(revision.number, edit("Saved."));
    expect((yield* store.read).number).toBe(revision.number + 1);
  }).pipe(Effect.scoped, Effect.withLogger(stepLogger(steps)), Effect.provide(NodeServices.layer));
});

it.effect("refuses a reload whose coordinator brain check is slow and logs a passing one", () => {
  const steps: Array<StepLog> = [];
  return Effect.gen(function* () {
    const { initial, current, slow, checking } = yield* revisionFixture;
    yield* current.registerWorkers(() => Effect.succeed(Effect.void));
    slow.value = true;
    const reloading = yield* current.reload.pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(checking);
    yield* TestClock.adjust(coordinatorBrainTimeout);
    const failure = yield* Fiber.join(reloading);

    expect(failure._tag).toBe("ValidationTimeoutError");
    const unchanged = yield* current.get;
    expect(unchanged).toBe(initial);
    expect(steps).toEqual([
      { step: "wait", durationMillis: 0, outcome: "passed" },
      { step: "read", durationMillis: 0, outcome: "passed" },
      { step: "restart", durationMillis: 0, outcome: "passed" },
      { step: "coordinator-brains", durationMillis: 10_000, outcome: "failed" },
    ]);

    slow.value = false;
    steps.length = 0;
    yield* current.reload;
    expect(steps.map(({ step }) => step)).toEqual([
      "wait",
      "read",
      "restart",
      "coordinator-brains",
      "worker-preflight",
      "apply",
    ]);
  }).pipe(Effect.scoped, Effect.withLogger(stepLogger(steps)), Effect.provide(NodeServices.layer));
});

it.effect("keeps following stored revisions after one times out its brain check", () => {
  const steps: Array<StepLog> = [];
  const messages: Array<unknown> = [];
  return Effect.gen(function* () {
    const { store, initial, revision, current, slow, checking, edit } = yield* revisionFixture;
    yield* current.registerWorkers(() => Effect.succeed(Effect.void));
    const installed = yield* current.changes.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    slow.value = true;
    yield* store.commit({
      expected: revision.number,
      actor: initial.config.operator,
      message: Option.none(),
      changes: [edit("Timed out.")],
    });
    // The memory store polls for revisions every 500 milliseconds.
    yield* TestClock.adjust("500 millis");
    yield* Deferred.await(checking);
    yield* TestClock.adjust(coordinatorBrainTimeout);
    expect(steps).toContainEqual({
      step: "coordinator-brains",
      durationMillis: 10_000,
      outcome: "failed",
    });
    const unchanged = yield* current.get;
    expect(unchanged).toBe(initial);

    slow.value = false;
    yield* store.commit({
      expected: ConfigurationRevisionNumber.make(revision.number + 1),
      actor: initial.config.operator,
      message: Option.none(),
      changes: [edit("Applied.", "Timed out.")],
    });
    yield* TestClock.adjust("500 millis");
    const [, applied] = yield* Fiber.join(installed);
    expect(applied?.agents[0]?.agent.persona).toBe("Applied.");
    expect(messages).not.toContain("Configuration revision stream failed; retrying");
  }).pipe(
    Effect.scoped,
    Effect.withLogger(stepLogger(steps, messages)),
    Effect.provide(NodeServices.layer),
  );
});
