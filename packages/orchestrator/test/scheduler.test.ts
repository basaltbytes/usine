import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import type { Agent } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { type WorkerKind, WorkerName } from "@usine/core/worker";
import { Submission } from "@usine/engine/engine";
import { StepExecutor } from "@usine/engine/step-executor";
import { Executor, ExecutorOperationError, WorkerCapabilityError } from "@usine/executor";
import {
  Context,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  type Path,
  Schema,
} from "effect";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { stepExecutorLayer } from "../src/scheduler.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";

const unused = () => Effect.die("unused");

describe("Worker scheduler startup", () => {
  it.effect("names the Worker when its preflight fails on an operation", () =>
    Effect.gen(function* () {
      const executor = Layer.succeed(Executor)({
        kind: "local",
        recover: unused,
        isLive: unused,
        outcome: unused,
        preflight: () =>
          Effect.fail(
            new ExecutorOperationError({
              operation: "preflight",
              message: "The harness probe timed out",
              cause: new Error("timeout"),
            }),
          ),
        prepare: unused,
        cancel: unused,
        intervene: unused,
      });
      const config = Schema.decodeUnknownSync(UsineConfig)({ version: 1, repos: [] });
      const failure = yield* Layer.build(
        stepExecutorLayer(config, []).pipe(
          Layer.provide(executor),
          Layer.provide(fixedConfigLayer(config)),
        ),
      ).pipe(Effect.flip, Effect.scoped);
      assert(failure._tag === "ExecutorOperationError", failure._tag);
      assert.strictEqual(failure.operation, "preflight");
      assert.strictEqual(failure.message, "Worker local: The harness probe timed out");
    }),
  );
});

const localWorkers = (workers: ReadonlyArray<readonly [string, number]>) =>
  workers
    .map(
      ([name, max]) => `  - name: ${name}
    kind: local
    max_concurrent_attempts: ${max}
`,
    )
    .join("");

const sshWorker = (name: string, max: number, destination = `usine@${name}`) => `  - name: ${name}
    kind: ssh
    max_concurrent_attempts: ${max}
    destination: ${destination}
    root: /srv/usine
`;

const usineYaml = (workers: string) => `version: 1
repos:
  - name: basaltbytes/usine
workers:
${workers}`;

const instanceFiles = (workers: string) =>
  [
    ["usine.yaml", usineYaml(workers)],
    [
      "agents/developer.md",
      `---
harness: codex
model: gpt-5.6-sol
effort: high
---
Implement the issue.
`,
    ],
    [
      "loops/start-dev.md",
      `---
trigger:
  on: issue
  if: item.labels.nodes.exists(label, label.name == "ready")
agent: developer
step: implement
---
Implement issue #{{ item.number }}.
`,
    ],
  ] as const;

/** Runs `test` against a reloadable instance over a fresh folder whose `usine.yaml` declares `workers`. */
const withWorkers = <A, E>(
  workers: string,
  test: (
    root: InstanceDirectory,
  ) => Effect.Effect<A, E, CurrentInstance | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const root = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-workers-" }),
    );
    yield* writeInstanceFiles(root, instanceFiles(workers));
    return yield* test(root).pipe(Effect.provide(reloadableInstanceLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * Starts the scheduler on the current instance with an executor of `kind`
 * whose preflight records `worker xN: model` for each check and fails for the
 * Workers in `failing`, as on a machine without enough memory.
 */
const startScheduler = (
  preflighted: Array<string>,
  options: {
    readonly kind?: WorkerKind;
    readonly failing?: ReadonlyArray<string>;
    readonly startupWorkersOnly?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const { config, agents } = yield* (yield* CurrentInstance).get;
    const executor = Layer.succeed(Executor)({
      kind: options.kind ?? "local",
      recover: unused,
      isLive: unused,
      outcome: unused,
      prepare: unused,
      cancel: unused,
      intervene: unused,
      preflight: (worker, brains, maxConcurrentAttempts) =>
        Effect.gen(function* () {
          preflighted.push(
            `${worker} x${maxConcurrentAttempts}: ${brains.map(({ model }) => model).join(",")}`,
          );
          if (options.failing?.includes(worker) === true)
            return yield* new WorkerCapabilityError({
              worker,
              capability: "memory",
              message: "The machine has 2 GiB of memory, less than 1.5 GiB per Attempt.",
              cause: "MemTotal: 2097152 kB",
            });
        }),
    });
    const context = yield* Layer.build(
      stepExecutorLayer(
        config,
        agents.map(({ agent }) => agent.brain),
        { startupWorkersOnly: options.startupWorkersOnly === true },
      ).pipe(Layer.provide(executor)),
    );
    return Context.get(context, StepExecutor);
  });

const submission = (agent: Agent, second: number) =>
  new Submission({
    event: new Event({
      id: EventId.make(`event-${second}`),
      dedupKey: DedupKey.make(`dedup-${second}`),
      payload: {},
      receivedAt: DateTime.makeUnsafe(`2026-10-19T08:00:${String(second).padStart(2, "0")}Z`),
    }),
    itemKey: ItemKey.make(`basaltbytes/usine#${second}`),
    loop: LoopName.make("start-dev"),
    step: StepName.make("implement"),
    approval: "none",
    repository: RepositoryName.make("basaltbytes/usine"),
    revision: RepositoryRevision.make("HEAD"),
    task: AttemptTask.make(`Implement issue ${second}.`),
    agent,
    parentModel: Option.none(),
  });

const developer = Effect.gen(function* () {
  const { agents } = yield* (yield* CurrentInstance).get;
  const [first] = agents;
  assert(first !== undefined, "the instance has an Agent");
  return first.agent;
});

/** Gives the dispatcher time to assign a slot that is free, so an unassigned reservation is waiting. */
const assertWaiting = <A, E>(fiber: Fiber.Fiber<A, E>, why: string) =>
  Effect.sleep("50 millis").pipe(
    Effect.andThen(Effect.sync(() => assert.isUndefined(fiber.pollUnsafe(), why))),
  );

const leaseOf = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));

const logsIn = (lines: Array<ReadonlyArray<unknown>>) =>
  Logger.make<unknown, void>(({ message }) => {
    lines.push(Array.isArray(message) ? message : [message]);
  });

const logged = (lines: ReadonlyArray<ReadonlyArray<unknown>>, message: string) =>
  lines.filter(([first]) => first === message).map(([, fields]) => fields);

const local = WorkerName.make("local");
const spare = WorkerName.make("spare");

describe("Worker scheduler on reload", () => {
  it.live("a reload that raises max_concurrent_attempts admits a waiting Run at once", () =>
    withWorkers(localWorkers([["local", 1]]), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const lines: Array<ReadonlyArray<unknown>> = [];
        const scheduler = yield* startScheduler([]);
        const agent = yield* developer;
        const first = yield* scheduler.reserve(submission(agent, 1));
        const waiting = yield* Effect.forkChild(scheduler.reserve(submission(agent, 2)));
        yield* assertWaiting(waiting, "one slot is leased");

        yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(localWorkers([["local", 2]]))]]);
        const report = yield* instances.reload.pipe(Effect.withLogger(logsIn(lines)));
        assert.deepStrictEqual(report.workers.changed, [local]);
        const second = yield* leaseOf(waiting);
        assert.strictEqual(second.worker, local);
        assert.strictEqual(first.worker, local);
        assert.deepStrictEqual(
          logged(lines, "Worker slots resized by a reload; running Attempts continue"),
          [{ worker: local, slotsBefore: 1, slotsAfter: 2, running: 1 }],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.live(
    "a reload that lowers max_concurrent_attempts lets running Attempts finish and retires the extra slots",
    () =>
      withWorkers(localWorkers([["local", 2]]), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const lines: Array<ReadonlyArray<unknown>> = [];
          const scheduler = yield* startScheduler([]);
          const agent = yield* developer;
          const first = yield* scheduler.reserve(submission(agent, 1));
          const second = yield* scheduler.reserve(submission(agent, 2));

          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(localWorkers([["local", 1]]))],
          ]);
          yield* instances.reload;
          const waiting = yield* Effect.forkChild(scheduler.reserve(submission(agent, 3)));
          yield* assertWaiting(waiting, "two Attempts run on one slot");
          yield* first.release.pipe(Effect.withLogger(logsIn(lines)));
          yield* assertWaiting(waiting, "the first Attempt's slot retired");
          assert.deepStrictEqual(
            logged(
              lines,
              "An Attempt ended on a Worker that runs more Attempts than it has slots; its slot retires",
            ),
            [{ worker: local, running: 1, slots: 1 }],
          );
          yield* second.release;
          assert.strictEqual((yield* leaseOf(waiting)).worker, local);
        }).pipe(Effect.scoped),
      ),
  );

  it.live("a removed Worker takes no new Attempt, and its running Attempt finishes", () =>
    withWorkers(
      localWorkers([
        ["local", 1],
        ["spare", 1],
      ]),
      (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const lines: Array<ReadonlyArray<unknown>> = [];
          const scheduler = yield* startScheduler([]);
          const agent = yield* developer;
          const onLocal = yield* scheduler.reserve(submission(agent, 1));
          const onSpare = yield* scheduler.reserve(submission(agent, 2));
          assert.deepStrictEqual([onLocal.worker, onSpare.worker], [local, spare]);

          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(localWorkers([["local", 1]]))],
          ]);
          const report = yield* instances.reload.pipe(Effect.withLogger(logsIn(lines)));
          assert.deepStrictEqual(report.workers.removed, [spare]);
          assert.deepStrictEqual(
            logged(
              lines,
              "Worker removed by a reload; it takes no new Attempt, and its running Attempts finish",
            ),
            [{ worker: spare, running: 1 }],
          );
          assert.deepStrictEqual(yield* scheduler.workers, [local, spare]);

          const waiting = yield* Effect.forkChild(scheduler.reserve(submission(agent, 3)));
          yield* onSpare.release.pipe(Effect.withLogger(logsIn(lines)));
          yield* assertWaiting(waiting, "the removed Worker's slot is gone");
          assert.lengthOf(
            logged(
              lines,
              "The last Attempt on a removed Worker ended; the Worker leaves the scheduler",
            ),
            1,
          );
          assert.deepStrictEqual(yield* scheduler.workers, [local]);
          yield* onLocal.release;
          assert.strictEqual((yield* leaseOf(waiting)).worker, local);
        }).pipe(Effect.scoped),
    ),
  );

  it.live(
    "a Worker a reload adds is preflighted with every rostered brain, then takes Attempts",
    () =>
      withWorkers(localWorkers([["local", 1]]), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const preflighted: Array<string> = [];
          const scheduler = yield* startScheduler(preflighted);
          const agent = yield* developer;
          yield* scheduler.reserve(submission(agent, 1));
          const waiting = yield* Effect.forkChild(scheduler.reserve(submission(agent, 2)));
          preflighted.length = 0;

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(
                localWorkers([
                  ["local", 1],
                  ["spare", 2],
                ]),
              ),
            ],
          ]);
          const report = yield* instances.reload;
          assert.deepStrictEqual(report.workers.added, [spare]);
          assert.deepStrictEqual(preflighted, ["spare x2: gpt-5.6-sol"]);
          assert.strictEqual((yield* leaseOf(waiting)).worker, spare);
        }).pipe(Effect.scoped),
      ),
  );

  it.live(
    "refuses a reload whose added Worker fails preflight, and the Worker takes no Attempt",
    () =>
      withWorkers(localWorkers([["local", 1]]), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const running = yield* instances.get;
          const scheduler = yield* startScheduler([], { failing: ["gpu"] });
          const agent = yield* developer;
          yield* scheduler.reserve(submission(agent, 1));
          const waiting = yield* Effect.forkChild(scheduler.reserve(submission(agent, 2)));

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(
                localWorkers([
                  ["local", 1],
                  ["gpu", 1],
                ]),
              ),
            ],
          ]);
          const failure = yield* Effect.flip(instances.reload);
          assert(failure._tag === "ReloadPreflightError", failure._tag);
          assert.deepStrictEqual(failure.workers, [WorkerName.make("gpu")]);
          assert.deepStrictEqual(failure.agents, []);
          assert.include(failure.message, "Worker gpu, which the reload adds or gives more slots");
          assert.include(failure.message, "less than 1.5 GiB per Attempt");
          assert.strictEqual(yield* instances.get, running);
          assert.deepStrictEqual(yield* scheduler.workers, [local]);
          yield* assertWaiting(waiting, "the refused Worker has no slot");
        }).pipe(Effect.scoped),
      ),
  );

  it.live("refuses a reload that renames a Worker or changes its kind, naming the field", () =>
    withWorkers(
      localWorkers([
        ["local", 1],
        ["spare", 1],
      ]),
      (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const running = yield* instances.get;
          yield* startScheduler([]);

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(
                localWorkers([
                  ["local", 1],
                  ["extra", 1],
                ]),
              ),
            ],
          ]);
          const renamed = yield* Effect.flip(instances.reload);
          assert(renamed._tag === "RestartRequiredError", renamed._tag);
          assert.deepStrictEqual(renamed.fields, ["workers.spare.name"]);
          assert.include(renamed.message, "Worker spare is renamed to extra");
          assert.include(renamed.message, "restart usine up");

          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(`${localWorkers([["local", 1]])}${sshWorker("spare", 1)}`)],
          ]);
          const rekinded = yield* Effect.flip(instances.reload);
          assert(rekinded._tag === "RestartRequiredError", rekinded._tag);
          assert.deepStrictEqual(rekinded.fields, ["workers.spare.kind"]);
          assert.include(rekinded.message, "Worker spare changed its kind from local to ssh");
          assert.strictEqual(yield* instances.get, running);
        }).pipe(Effect.scoped),
    ),
  );

  it.live("resizes an SSH Worker on reload, and refuses one re-pointed or added", () =>
    withWorkers(sshWorker("build-1", 1), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const preflighted: Array<string> = [];
        const scheduler = yield* startScheduler(preflighted, {
          kind: "ssh",
          startupWorkersOnly: true,
        });

        yield* writeInstanceFiles(root, [
          ["usine.yaml", usineYaml(sshWorker("build-1", 1, "usine@203.0.113.10"))],
        ]);
        const repointed = yield* Effect.flip(instances.reload);
        assert(repointed._tag === "RestartRequiredError", repointed._tag);
        assert.deepStrictEqual(repointed.fields, ["workers.build-1.destination"]);
        assert.include(repointed.message, "Worker build-1 changed its destination");

        yield* writeInstanceFiles(root, [
          ["usine.yaml", usineYaml(`${sshWorker("build-1", 1)}${sshWorker("build-2", 1)}`)],
        ]);
        const added = yield* Effect.flip(instances.reload);
        assert(added._tag === "RestartRequiredError", added._tag);
        assert.deepStrictEqual(added.fields, ["workers.build-2"]);
        assert.include(added.message, "runs only the Workers usine up started with");

        preflighted.length = 0;
        yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(sshWorker("build-1", 3))]]);
        const resized = yield* instances.reload;
        assert.deepStrictEqual(resized.workers.changed, [WorkerName.make("build-1")]);
        assert.deepStrictEqual(preflighted, ["build-1 x3: gpt-5.6-sol"]);
        assert.deepStrictEqual(yield* scheduler.workers, [WorkerName.make("build-1")]);
      }).pipe(Effect.scoped),
    ),
  );
});
