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
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schema,
  Stream,
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

it.effect("refuses a save whose coordinator brain check is slow and stores no revision", () => {
  const StepLog = Schema.Struct({
    step: Schema.String,
    durationMillis: Schema.Finite,
    outcome: Schema.String,
  });
  const steps: Array<typeof StepLog.Type> = [];
  const stepLogger = Logger.make<unknown, void>(({ message }) => {
    if (!Array.isArray(message) || message[0] !== "Configuration step finished") return;
    steps.push(...Option.toArray(Schema.decodeUnknownOption(StepLog)(message[1])));
  });
  return Effect.gen(function* () {
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
    let slow = false;
    const checking = yield* Deferred.make<void>();
    yield* current.registerParentAdmission(() =>
      slow
        ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed([]),
    );
    yield* current.registerWorkers(() => Effect.succeed(Effect.void));
    slow = true;
    const agent = revision.changes.find(({ key }) => key.kind === "agent");
    if (agent === undefined) return yield* Effect.die("missing agent fixture");
    const agentAfter = yield* Effect.transposeOption(
      Option.map(agent.after, Schema.decodeUnknownEffect(Schema.JsonObject)),
    );
    const save = yield* current
      .commit({
        expected: revision.number,
        actor: initial.config.operator,
        message: Option.none(),
        changes: [
          ConfigurationChange.make({
            ...agent,
            before: agent.after,
            after: Option.map(agentAfter, (value) => ({ ...value, persona: "Review again." })),
          }),
        ],
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(checking);
    yield* TestClock.adjust(coordinatorBrainTimeout);
    const failure = yield* Fiber.join(save);

    expect(failure._tag).toBe("ValidationTimeoutError");
    if (failure._tag !== "ValidationTimeoutError") return;
    expect(failure.step).toBe("coordinator-brains");
    expect(failure.message).toContain("didn't finish within 10 seconds");
    expect((yield* store.read).number).toBe(revision.number);
    const unchanged = yield* current.get;
    expect(unchanged).toBe(initial);
    expect(steps).toContainEqual({
      step: "coordinator-brains",
      durationMillis: 10_000,
      outcome: "failed",
    });
    expect(steps.map(({ step }) => step)).toEqual([
      "wait",
      "read",
      "parse",
      "restart",
      "coordinator-brains",
    ]);
  }).pipe(Effect.scoped, Effect.withLogger(stepLogger), Effect.provide(NodeServices.layer));
});
