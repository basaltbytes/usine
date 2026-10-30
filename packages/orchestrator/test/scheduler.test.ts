import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import type { Agent } from "@usine/core/agent";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { type WorkerKind, WorkerName } from "@usine/core/worker";
import { Submission } from "@usine/engine/engine";
import { StepExecutor } from "@usine/engine/step-executor";
import {
  Executor,
  ExecutorOperationError,
  WorkerCapabilityError,
  fullPreflight,
} from "@usine/executor";
import { type SshWorkerAddress, SshWorkers } from "@usine/executor/ssh";
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  type Path,
  Redacted,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { CurrentInstance } from "../src/current-instance/current-instance.ts";
import { ReloadPreflightRefusal, reloadRefusal } from "../src/operator/http.ts";
import { stepExecutorLayer } from "../src/scheduler/scheduler.ts";
import { CloudflareWorkers, type CloudflareWorkerAddress } from "@usine/executor/cloudflare";
import { cloudflareStepExecutorLayer } from "../src/cloudflare.ts";
import { sshStepExecutorLayer } from "../src/ssh.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import { fixedConfigLayer } from "./support/current-instance.ts";
import { testAppLayer } from "./support/github-app.ts";
import { reloadableInstanceLayer, writeInstanceFiles } from "./support/instance-folder.ts";

const unused = () => Effect.die("unused");

describe("Worker scheduler startup", () => {
  it.effect("releases a canceled manual preflight reservation so a queued attempt can start", () =>
    withWorkers(localWorkers([["local", 1]]), () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let initial = true;
        const config = Schema.decodeUnknownSync(UsineConfig)({
          version: 1,
          repos: [],
          workers: [{ name: "local", kind: "local" }],
        });
        const worker = WorkerName.make("local");
        const executor = Layer.mock(Executor)({
          kind: "local",
          preflight: () =>
            Effect.gen(function* () {
              if (initial) {
                initial = false;
                return fullPreflight;
              }
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }),
        });
        const context = yield* Layer.build(
          stepExecutorLayer(config, []).pipe(
            Layer.provide(MarcbachmannCelLayer),
            Layer.provide(executor),
            Layer.provide(fixedConfigLayer(config)),
            Layer.provide(testAppLayer),
          ),
        );
        const status = Context.get(context, WorkerStatus);
        const steps = Context.get(context, StepExecutor);
        const check = yield* status.runPreflight(worker).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const agent = yield* developer;
        const waiting = yield* steps
          .reserve(runOf(1), submission(agent, 1), Option.some(worker))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isUndefined(waiting.pollUnsafe());
        assert.strictEqual((yield* status.checking).has(worker), true);
        yield* Fiber.interrupt(check);
        const lease = yield* Fiber.join(waiting);
        assert.strictEqual(lease.worker, worker);
        assert.strictEqual((yield* status.checking).size, 0);
        assert.strictEqual(
          (yield* Effect.flip(status.runPreflight(worker))).reason,
          "attempt-running",
        );
        yield* lease.release;
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("fails startup with the worker message when every worker fails preflight", () =>
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
        sweep: Effect.void,
      });
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [],
        workers: [
          { name: "local", kind: "local" },
          { name: "spare", kind: "local" },
        ],
      });
      const failure = yield* Layer.build(
        stepExecutorLayer(config, []).pipe(
          Layer.provide(MarcbachmannCelLayer),
          Layer.provide(executor),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(testAppLayer),
        ),
      ).pipe(Effect.flip, Effect.scoped);
      assert(failure._tag === "ExecutorOperationError", failure._tag);
      assert.strictEqual(failure.operation, "preflight");
      assert.strictEqual(failure.message, 'worker "local": The harness probe timed out');
    }),
  );

  it.effect(
    "schedules on a healthy worker while a failed worker waits, then recovers on its second preflight",
    () =>
      withWorkers(
        localWorkers([
          ["local", 1],
          ["spare", 1],
        ]),
        () =>
          Effect.gen(function* () {
            const failing = ["local"];
            const calls: Array<string> = [];
            const context = yield* schedulerContext(calls, { failing });
            const steps = Context.get(context, StepExecutor);
            const status = Context.get(context, WorkerStatus);
            const agent = yield* developer;
            assert.deepStrictEqual(
              (yield* status.slots).map(({ worker, capacity }) => [worker, capacity]),
              [
                ["local", 0],
                ["spare", 1],
              ],
            );
            const healthy = yield* steps.reserve(runOf(1), submission(agent, 1), Option.none());
            assert.strictEqual(healthy.worker, "spare");
            const waiting = yield* steps
              .reserve(runOf(2), submission(agent, 2), Option.some(WorkerName.make("local")))
              .pipe(Effect.forkChild);
            failing.length = 0;
            yield* TestClock.adjust("59 seconds");
            assert.isUndefined(waiting.pollUnsafe());
            assert.lengthOf(calls, 2);
            yield* TestClock.adjust("1 second");
            const recovered = yield* Fiber.join(waiting);
            assert.strictEqual(recovered.worker, "local");
            assert.lengthOf(calls, 3);
            const checks = yield* status.preflights;
            assert.strictEqual(
              Option.getOrNull(
                checks.find(({ worker }) => worker === "local")?.prerequisites ?? Option.none(),
              )?._tag,
              "Passed",
            );
            yield* recovered.release;
            yield* healthy.release;
          }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "keeps failed workers disabled across unrelated reloads and backs off until a changed worker passes",
    () =>
      withWorkers(
        localWorkers([
          ["local", 1],
          ["spare", 1],
        ]),
        (root) =>
          Effect.gen(function* () {
            const failing = ["local"];
            const calls: Array<string> = [];
            const context = yield* schedulerContext(calls, { failing });
            const status = Context.get(context, WorkerStatus);
            const instances = yield* CurrentInstance;
            yield* instances.reload;
            assert.strictEqual(
              (yield* status.slots).find(({ worker }) => worker === "local")?.capacity,
              0,
            );
            for (const minutes of [1, 2, 5, 10, 10]) {
              const before = calls.length;
              yield* TestClock.adjust(`${minutes * 60 - 1} seconds`);
              assert.lengthOf(calls, before);
              yield* TestClock.adjust("1 second");
              assert.lengthOf(calls, before + 1);
            }
            yield* writeInstanceFiles(root, [
              [
                "usine.yaml",
                usineYaml(
                  localWorkers([
                    ["local", 2],
                    ["spare", 1],
                  ]),
                ),
              ],
            ]);
            const refused = yield* instances.reload.pipe(Effect.flip);
            assert.strictEqual(refused._tag, "ReloadPreflightError");
            assert.strictEqual(
              (yield* status.slots).find(({ worker }) => worker === "local")?.capacity,
              0,
            );
            failing.length = 0;
            yield* instances.reload;
            assert.strictEqual(
              (yield* status.slots).find(({ worker }) => worker === "local")?.capacity,
              2,
            );
            const recoveredCalls = calls.length;
            yield* TestClock.adjust("10 minutes");
            assert.lengthOf(calls, recoveredCalls);
          }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "keeps a worker unavailable when its check passes but another worker refuses the revision",
    () =>
      withWorkers(
        localWorkers([
          ["local", 1],
          ["spare", 1],
        ]),
        (root) =>
          Effect.gen(function* () {
            const failing = ["local"];
            const context = yield* schedulerContext([], { failing });
            const status = Context.get(context, WorkerStatus);
            failing.splice(0, 1, "spare");
            yield* writeInstanceFiles(root, [
              [
                "usine.yaml",
                usineYaml(
                  localWorkers([
                    ["local", 2],
                    ["spare", 2],
                  ]),
                ),
              ],
            ]);
            const refused = yield* (yield* CurrentInstance).reload.pipe(Effect.flip);
            assert.strictEqual(refused._tag, "ReloadPreflightError");
            assert.deepStrictEqual(
              (yield* status.unavailable).map(({ worker }) => worker),
              ["local"],
            );
            assert.strictEqual(
              (yield* status.slots).find(({ worker }) => worker === "local")?.capacity,
              0,
            );
            yield* TestClock.adjust("1 minute");
            assert.deepStrictEqual(yield* status.unavailable, []);
            assert.strictEqual(
              (yield* status.slots).find(({ worker }) => worker === "local")?.capacity,
              1,
            );
          }).pipe(Effect.scoped),
      ),
  );

  it.effect("stops preflight retries when a revision removes the failed worker", () =>
    withWorkers(
      localWorkers([
        ["local", 1],
        ["spare", 1],
      ]),
      (root) =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const context = yield* schedulerContext(calls, { failing: ["local"] });
          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(localWorkers([["spare", 1]]))],
          ]);
          yield* (yield* CurrentInstance).reload;
          yield* TestClock.adjust("20 minutes");
          assert.lengthOf(calls, 2);
          assert.deepStrictEqual(
            (yield* Context.get(context, WorkerStatus).slots).map(({ worker }) => worker),
            ["spare"],
          );
        }).pipe(Effect.scoped),
    ),
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

/** Runs `test` against a reloadable instance in a new folder with `files`. */
const withInstance = <A, E>(
  files: ReadonlyArray<readonly [string, string]>,
  test: (
    root: InstanceDirectory,
  ) => Effect.Effect<A, E, CurrentInstance | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const root = InstanceDirectory.make(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "usine-workers-" }),
    );
    yield* writeInstanceFiles(root, files);
    return yield* test(root).pipe(Effect.provide(reloadableInstanceLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * Runs `test` against a reloadable instance in a new folder whose `usine.yaml` declares `workers`.
 */
const withWorkers = <A, E>(
  workers: string,
  test: (
    root: InstanceDirectory,
  ) => Effect.Effect<A, E, CurrentInstance | FileSystem.FileSystem | Path.Path>,
) => withInstance(instanceFiles(workers), test);

/** Builds the scheduler on the current instance with a `recordingExecutor`. */
const schedulerContext = (
  preflighted: Array<string>,
  options: {
    readonly kind?: WorkerKind;
    readonly failing?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const { config, agents } = yield* (yield* CurrentInstance).get;
    return yield* Layer.build(
      stepExecutorLayer(
        config,
        agents.map(({ agent }) => agent.brain),
      ).pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(recordingExecutor(preflighted, options)),
        Layer.provide(testAppLayer),
      ),
    );
  });

/** Starts the scheduler on the current instance with a `recordingExecutor`. */
const startScheduler = (...args: Parameters<typeof schedulerContext>) =>
  Effect.map(schedulerContext(...args), (context) => Context.get(context, StepExecutor));

/**
 * Returns an executor of `kind` whose preflight records `worker xN: model` for each check and fails
 * for the Workers in `failing`.
 */
const recordingExecutor = (
  preflighted: Array<string>,
  options: { readonly kind?: WorkerKind; readonly failing?: ReadonlyArray<string> },
) =>
  Layer.succeed(Executor)({
    kind: options.kind ?? "local",
    recover: unused,
    isLive: unused,
    outcome: unused,
    prepare: unused,
    cancel: unused,
    intervene: unused,
    sweep: Effect.void,
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
        return fullPreflight;
      }),
  });

const runOf = (second: number) => RunId.make(`run-${second}`);

/**
 * Returns the Submission of a Run of `loop` whose Event arrived at second `second` with an Item
 * that has `labels`. Without `labels`, the payload is empty.
 */
const submission = (
  agent: Agent,
  second: number,
  loop = "start-dev",
  labels?: ReadonlyArray<string>,
) =>
  new Submission({
    event: new Event({
      id: EventId.make(`event-${second}`),
      dedupKey: DedupKey.make(`dedup-${second}`),
      payload:
        labels === undefined
          ? {}
          : { labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) } },
      receivedAt: DateTime.makeUnsafe(`2026-10-19T08:00:${String(second).padStart(2, "0")}Z`),
    }),
    itemKey: ItemKey.make(`basaltbytes/usine#${second}`),
    loop: LoopName.make(loop),
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

/** Asserts that `fiber` is still waiting after the dispatcher had 50 ms to assign a free slot. */
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

describe("Worker scheduler reservations that name a Worker", () => {
  it.live("lease from that Worker only, without holding up the Runs behind them", () =>
    withWorkers(
      localWorkers([
        ["local", 1],
        ["spare", 1],
      ]),
      () =>
        Effect.gen(function* () {
          const context = yield* schedulerContext([]);
          const scheduler = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const agent = yield* developer;
          const onLocal = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          assert.strictEqual(onLocal.worker, local);
          const reattaching = yield* Effect.forkChild(
            scheduler.reserve(runOf(2), submission(agent, 2), Option.some(local)),
          );
          yield* assertWaiting(reattaching, "local's only slot is leased; spare's stays free");
          const behind = yield* scheduler.reserve(runOf(3), submission(agent, 3), Option.none());
          assert.strictEqual(behind.worker, spare);
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(4), submission(agent, 4), Option.none()),
          );
          yield* assertWaiting(waiting, "both slots are leased");
          assert.deepStrictEqual(
            (yield* status.queue).map(({ runId, ahead }) => [runId, ahead]),
            [
              [runOf(2), 0],
              [runOf(4), 0],
            ],
            "the reattached Attempt's Run waits for local only, so spare's next slot goes to run 4",
          );
          yield* onLocal.release;
          assert.strictEqual((yield* leaseOf(reattaching)).worker, local);
          yield* behind.release;
          assert.strictEqual((yield* leaseOf(waiting)).worker, spare);
        }).pipe(Effect.scoped),
    ),
  );

  it.live("count for the Runs behind them while every Worker has one", () =>
    withWorkers(
      localWorkers([
        ["local", 1],
        ["spare", 1],
      ]),
      () =>
        Effect.gen(function* () {
          const context = yield* schedulerContext([]);
          const scheduler = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const agent = yield* developer;
          const onLocal = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());
          const reattachingLocal = yield* Effect.forkChild(
            scheduler.reserve(runOf(3), submission(agent, 3), Option.some(local)),
          );
          const reattachingSpare = yield* Effect.forkChild(
            scheduler.reserve(runOf(4), submission(agent, 4), Option.some(spare)),
          );
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(5), submission(agent, 5), Option.none()),
          );
          yield* assertWaiting(waiting, "both slots are leased");
          assert.deepStrictEqual(
            (yield* status.queue).map(({ runId, ahead }) => [runId, ahead]),
            [
              [runOf(3), 0],
              [runOf(4), 0],
              [runOf(5), 1],
            ],
            "whichever Worker frees a slot first, its reattached Attempt's Run takes it",
          );
          yield* onLocal.release;
          const onLocalAgain = yield* leaseOf(reattachingLocal);
          assert.strictEqual(onLocalAgain.worker, local);
          yield* assertWaiting(waiting, "local's freed slot went to run 3");
          assert.deepStrictEqual(
            (yield* status.queue).map(({ runId, ahead }) => [runId, ahead]),
            [
              [runOf(4), 0],
              [runOf(5), 0],
            ],
            "local's next slot goes to run 5",
          );
          yield* onLocalAgain.release;
          assert.strictEqual((yield* leaseOf(waiting)).worker, local);
          yield* Fiber.interrupt(reattachingSpare);
        }).pipe(Effect.scoped),
    ),
  );

  it.live("take a freed slot before a Run whose Event arrived earlier", () =>
    withWorkers(localWorkers([["local", 1]]), () =>
      Effect.gen(function* () {
        const scheduler = yield* startScheduler([]);
        const agent = yield* developer;
        const held = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
        const earlier = yield* Effect.forkChild(
          scheduler.reserve(runOf(2), submission(agent, 2), Option.none()),
        );
        yield* assertWaiting(earlier, "the only slot is leased");
        const reattaching = yield* Effect.forkChild(
          scheduler.reserve(runOf(5), submission(agent, 5), Option.some(local)),
        );
        yield* assertWaiting(reattaching, "the only slot is leased");
        yield* held.release;
        assert.strictEqual((yield* leaseOf(reattaching)).worker, local);
        yield* assertWaiting(earlier, "the reattached Attempt holds the slot");
      }).pipe(Effect.scoped),
    ),
  );

  it.live("warn when usine.yaml does not declare the Worker, and leave the queue on cancel", () =>
    withWorkers(localWorkers([["local", 1]]), () =>
      Effect.gen(function* () {
        const lines: Array<ReadonlyArray<unknown>> = [];
        const scheduler = yield* startScheduler([]);
        const agent = yield* developer;
        yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
        const gone = WorkerName.make("gone");
        const reattaching = yield* Effect.forkChild(
          scheduler
            .reserve(runOf(2), submission(agent, 2), Option.some(gone))
            .pipe(Effect.withLogger(logsIn(lines))),
        );
        yield* assertWaiting(reattaching, "no slot of an undeclared Worker ever frees");
        assert.deepStrictEqual(
          logged(
            lines,
            "Run waits for a slot on the Worker its reattached Attempt runs on, which is unavailable or no longer declared; it waits until preflight passes, a reload declares that Worker again, or the Run is canceled",
          ),
          [
            {
              runId: runOf(2),
              loop: "start-dev",
              itemKey: "basaltbytes/usine#2",
              priority: 0,
              positionSource: "none",
              queued: 1,
              ahead: 0,
              worker: gone,
            },
          ],
        );
        yield* Fiber.interrupt(reattaching);
        const waiting = yield* Effect.forkChild(
          scheduler
            .reserve(runOf(3), submission(agent, 3), Option.none())
            .pipe(Effect.withLogger(logsIn(lines))),
        );
        yield* assertWaiting(waiting, "the only slot is leased");
        assert.deepStrictEqual(logged(lines, "Run waits for a worker slot"), [
          {
            runId: runOf(3),
            loop: "start-dev",
            itemKey: "basaltbytes/usine#3",
            priority: 0,
            positionSource: "none",
            queued: 1,
            ahead: 0,
          },
        ]);
      }).pipe(Effect.scoped),
    ),
  );
});

const loopFile = (stream: "issue" | "pr", label: string, extra = "") => `---
trigger:
  on: ${stream}
  if: item.labels.nodes.exists(label, label.name == "${label}")
agent: developer
${extra}---
Work on #{{ item.number }}.
`;

/** An instance with a label pipeline on two slots of one Worker. */
const pipelineFiles = [
  [
    "usine.yaml",
    `version: 1
repos:
  - name: basaltbytes/usine
    lanes:
      - name: Ready
        sources: [{ label: ready-for-agent }]
      - name: Review
        sources: [{ label: ready-for-review }]
      - name: Merge
        sources: [{ label: ready-to-merge }]
workers:
${localWorkers([["local", 2]])}`,
  ],
  instanceFiles("")[1],
  ["loops/start-dev.md", loopFile("issue", "ready-for-agent")],
  ["loops/review-pr.md", loopFile("pr", "ready-for-review")],
  ["loops/rebase-pr.md", loopFile("pr", "conflicting", "priority: 1\n")],
  ["loops/triage.md", loopFile("issue", "bug")],
] as const;

describe("Worker scheduler lease order", () => {
  it.live("uses zero and logs when a priority expression fails, preserving lane order", () =>
    withInstance(
      pipelineFiles.map(([path, text]) => [
        path,
        path === "loops/start-dev.md"
          ? loopFile("issue", "ready-for-agent", "priority: '1 / 0'\n")
          : text,
      ]),
      () =>
        Effect.gen(function* () {
          const lines: Array<ReadonlyArray<unknown>> = [];
          const context = yield* schedulerContext([]).pipe(Effect.withLogger(logsIn(lines)));
          const scheduler = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const agent = yield* developer;
          const reserve = (n: number, loop: string, label: string) =>
            scheduler
              .reserve(runOf(n), submission(agent, n, loop, [label]), Option.none())
              .pipe(Effect.withLogger(logsIn(lines)));
          const first = yield* reserve(1, "start-dev", "ready-for-agent");
          const second = yield* reserve(2, "start-dev", "ready-for-agent");
          const failing = yield* Effect.forkChild(reserve(3, "start-dev", "ready-for-agent"));
          const review = yield* Effect.forkChild(reserve(4, "review-pr", "ready-for-review"));
          yield* assertWaiting(review, "both slots are leased");
          assert.deepStrictEqual(
            (yield* status.queue).map(({ runId, position }) => [runId, position.priority]),
            [
              [runOf(4), 0],
              [runOf(3), 0],
            ],
          );
          const warnings = logged(lines, "Priority evaluation failed; using zero");
          assert.lengthOf(warnings, 3);
          assert.include(warnings[2], {
            runId: runOf(3),
            loop: "start-dev",
            expression: "1 / 0",
            errorTag: "ExpressionEvaluationError",
          });
          assert.property(warnings[2], "message");
          yield* first.release;
          yield* leaseOf(review);
          yield* assertWaiting(failing, "the later lane takes the freed slot");
          yield* second.release;
          yield* leaseOf(failing);
          assert.include(logged(lines, "Worker slot leased in lease order").at(-1), {
            priority: 0,
            loop: "start-dev",
          });
        }).pipe(Effect.scoped),
    ),
  );

  it.live("leases a freed slot to the Run furthest along the lanes, then keeps Event order", () =>
    withInstance(pipelineFiles, () =>
      Effect.gen(function* () {
        const lines: Array<ReadonlyArray<unknown>> = [];
        const context = yield* schedulerContext([]).pipe(Effect.withLogger(logsIn(lines)));
        const scheduler = Context.get(context, StepExecutor);
        const status = Context.get(context, WorkerStatus);
        const agent = yield* developer;
        const startDev = (second: number) =>
          scheduler.reserve(
            runOf(second),
            submission(agent, second, "start-dev", ["ready-for-agent"]),
            Option.none(),
          );
        const first = yield* startDev(1);
        const second = yield* startDev(2);
        const queued = yield* Effect.forEach([3, 4, 5, 6], (n) => Effect.forkChild(startDev(n)));
        const review = yield* Effect.forkChild(
          scheduler.reserve(
            runOf(7),
            submission(agent, 7, "review-pr", ["ready-for-review"]),
            Option.none(),
          ),
        );
        yield* assertWaiting(review, "both slots are leased");
        assert.deepStrictEqual(
          (yield* status.queue).map(({ runId }) => runId),
          [7, 3, 4, 5, 6].map(runOf),
        );

        yield* first.release;
        assert.strictEqual((yield* leaseOf(review)).worker, local);
        const [third, ...behind] = queued;
        assert(third !== undefined);
        yield* Effect.forEach(behind, (fiber) =>
          assertWaiting(fiber, "the review-pr Run took the freed slot"),
        );
        yield* second.release;
        assert.strictEqual((yield* leaseOf(third)).worker, local);
        yield* Effect.forEach(behind, (fiber) =>
          assertWaiting(fiber, "the earliest start-dev Event goes first"),
        );
        assert.deepStrictEqual(logged(lines, "Worker slot leased in lease order").slice(2), [
          {
            runId: runOf(7),
            loop: "review-pr",
            itemKey: "basaltbytes/usine#7",
            worker: local,
            priority: 0,
            positionSource: "lane",
            position: 2,
            lane: "Review",
            passed: 4,
          },
          {
            runId: runOf(3),
            loop: "start-dev",
            itemKey: "basaltbytes/usine#3",
            worker: local,
            priority: 0,
            positionSource: "lane",
            position: 1,
            lane: "Ready",
            passed: 0,
          },
        ]);
      }).pipe(Effect.scoped),
    ),
  );

  it.live(
    "leases to a Loop with a priority before lane order, and to Runs with no position last",
    () =>
      withInstance(pipelineFiles, () =>
        Effect.gen(function* () {
          const scheduler = yield* startScheduler([]);
          const agent = yield* developer;
          const reserve = (second: number, loop: string, labels: ReadonlyArray<string>) =>
            Effect.forkChild(
              scheduler.reserve(
                runOf(second),
                submission(agent, second, loop, labels),
                Option.none(),
              ),
            );
          const one = yield* Fiber.join(yield* reserve(1, "start-dev", ["ready-for-agent"]));
          const two = yield* Fiber.join(yield* reserve(2, "start-dev", ["ready-for-agent"]));
          const triage = yield* reserve(3, "triage", ["bug"]);
          const merging = yield* reserve(4, "review-pr", ["ready-to-merge"]);
          const rebase = yield* reserve(5, "rebase-pr", ["conflicting"]);
          yield* assertWaiting(rebase, "both slots are leased");
          yield* one.release;
          yield* leaseOf(rebase);
          yield* assertWaiting(merging, "the rebase-pr Loop's priority beats the last lane");
          yield* two.release;
          yield* leaseOf(merging);
          yield* assertWaiting(triage, "a Run in no lane goes after Runs in a lane");
        }).pipe(Effect.scoped),
      ),
  );
});

describe("Worker scheduler slots occupied by Attempts that already run", () => {
  it.live(
    "count at once, even past max_concurrent_attempts, and take slots from new Attempts until enough end",
    () =>
      withWorkers(
        localWorkers([
          ["local", 1],
          ["spare", 1],
        ]),
        () =>
          Effect.gen(function* () {
            const lines: Array<ReadonlyArray<unknown>> = [];
            const scheduler = yield* startScheduler([]);
            const agent = yield* developer;
            const first = yield* scheduler.occupy(local, AttemptId.make("running-1"));
            const second = yield* scheduler
              .occupy(local, AttemptId.make("running-2"))
              .pipe(Effect.withLogger(logsIn(lines)));
            assert.deepStrictEqual(
              logged(
                lines,
                "An Attempt that already runs on the Worker occupies a slot beyond its max_concurrent_attempts; the Worker takes no new Attempt until enough of its Attempts end",
              ),
              [{ worker: local, running: 2, slots: 1 }],
            );
            const onLocal = yield* Effect.forkChild(
              scheduler.reserve(runOf(1), submission(agent, 1), Option.some(local)),
            );
            yield* assertWaiting(onLocal, "two Attempts run on local's one slot");
            const fresh = yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());
            assert.strictEqual(fresh.worker, spare);
            yield* first.release;
            yield* assertWaiting(onLocal, "the first Attempt's slot retired");
            yield* second.release;
            assert.strictEqual((yield* leaseOf(onLocal)).worker, local);
          }).pipe(Effect.scoped),
      ),
  );

  it.live("occupy no slot of a Worker the scheduler does not have, and warn", () =>
    withWorkers(localWorkers([["local", 1]]), () =>
      Effect.gen(function* () {
        const lines: Array<ReadonlyArray<unknown>> = [];
        const scheduler = yield* startScheduler([]);
        const gone = WorkerName.make("gone");
        const lease = yield* scheduler
          .occupy(gone, AttemptId.make("running-1"))
          .pipe(Effect.withLogger(logsIn(lines)));
        assert.deepStrictEqual(
          logged(
            lines,
            "An Attempt already runs on a Worker the scheduler does not have; it occupies no slot, and that Worker takes no new Attempt",
          ),
          [{ worker: gone }],
        );
        yield* lease.release;
        assert.deepStrictEqual(yield* scheduler.workers, [local]);
        const agent = yield* developer;
        assert.strictEqual(
          (yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none())).worker,
          local,
        );
      }).pipe(Effect.scoped),
    ),
  );
});

describe("Worker scheduler on reload", () => {
  it.live("a reload that raises max_concurrent_attempts admits a waiting Run at once", () =>
    withWorkers(localWorkers([["local", 1]]), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const lines: Array<ReadonlyArray<unknown>> = [];
        const scheduler = yield* startScheduler([]);
        const agent = yield* developer;
        const first = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
        const waiting = yield* Effect.forkChild(
          scheduler.reserve(runOf(2), submission(agent, 2), Option.none()),
        );
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
          const first = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const second = yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());

          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(localWorkers([["local", 1]]))],
          ]);
          yield* instances.reload;
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(3), submission(agent, 3), Option.none()),
          );
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
          const onLocal = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const onSpare = yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());
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

          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(3), submission(agent, 3), Option.none()),
          );
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
          yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(2), submission(agent, 2), Option.none()),
          );
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
          yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(2), submission(agent, 2), Option.none()),
          );

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
          assert.include(failure.message, 'worker "gpu" (added or given more slots by the reload)');
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
          assert.include(renamed.message, 'worker "spare" was renamed to "extra"');
          assert.include(renamed.message, "Restart usine up");

          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(`${localWorkers([["local", 1]])}${sshWorker("spare", 1)}`)],
          ]);
          const rekinded = yield* Effect.flip(instances.reload);
          assert(rekinded._tag === "RestartRequiredError", rekinded._tag);
          assert.deepStrictEqual(rekinded.fields, ["workers.spare.kind"]);
          assert.include(rekinded.message, 'worker "spare" changed kind from local to ssh');
          assert.strictEqual(yield* instances.get, running);
        }).pipe(Effect.scoped),
    ),
  );

  it.live("resizes an SSH Worker on reload, and refuses one re-pointed", () =>
    withWorkers(sshWorker("build-1", 1), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const preflighted: Array<string> = [];
        const scheduler = yield* startScheduler(preflighted, { kind: "ssh" });

        yield* writeInstanceFiles(root, [
          ["usine.yaml", usineYaml(sshWorker("build-1", 1, "usine@203.0.113.10"))],
        ]);
        const repointed = yield* Effect.flip(instances.reload);
        assert(repointed._tag === "RestartRequiredError", repointed._tag);
        assert.deepStrictEqual(repointed.fields, ["workers.build-1.destination"]);
        assert.include(repointed.message, 'worker "build-1" changed destination');

        preflighted.length = 0;
        yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(sshWorker("build-1", 3))]]);
        const resized = yield* instances.reload;
        assert.deepStrictEqual(resized.workers.changed, [WorkerName.make("build-1")]);
        assert.deepStrictEqual(preflighted, ["build-1 x3: gpt-5.6-sol"]);
        preflighted.length = 0;
        yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(sshWorker("build-1", 2))]]);
        yield* instances.reload;
        assert.deepStrictEqual(preflighted, ["build-1 x2: gpt-5.6-sol"]);
        assert.deepStrictEqual(yield* scheduler.workers, [WorkerName.make("build-1")]);
      }).pipe(Effect.scoped),
    ),
  );
});

/**
 * Returns an SSH Worker behind the Gateway `usine-gateway`, with its admin token in the variable
 * `tokenEnv`.
 */
const gatewaySshWorker = (
  name: string,
  max: number,
  tokenEnv: string,
) => `${sshWorker(name, max)}    gateway:
      domain: gw.test
      destination: usine-gateway
      admin_token_env: ${tokenEnv}
`;

/**
 * Starts the SSH scheduler over a `recordingExecutor` of kind `ssh` that records preflights, Worker
 * additions, and removals in `events`, and each added address in `added`. `environment` is the
 * orchestrator's environment.
 */
const startSshScheduler = (
  events: Array<string>,
  options: {
    readonly added?: Array<SshWorkerAddress>;
    readonly environment?: Record<string, string>;
    readonly failing?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const { config, agents } = yield* (yield* CurrentInstance).get;
    const machines = Layer.succeed(SshWorkers)({
      addWorker: (address) =>
        Effect.sync(() => {
          events.push(`add ${address.name}`);
          options.added?.push(address);
        }),
      removeWorker: (worker) =>
        Effect.sync(() => {
          events.push(`remove ${worker}`);
        }),
    });
    const context = yield* Layer.build(
      sshStepExecutorLayer(
        config,
        agents.map(({ agent }) => agent.brain),
      ).pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(recordingExecutor(events, { kind: "ssh", failing: options.failing ?? [] })),
        Layer.provide(machines),
        Layer.provide(testAppLayer),
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.environment ?? {} })),
        ),
      ),
    );
    return Context.get(context, StepExecutor);
  });

const build1 = WorkerName.make("build-1");
const build2 = WorkerName.make("build-2");
const build3 = WorkerName.make("build-3");
const TOKEN_ENV = "USINE_TEST_GATEWAY_TWO_TOKEN";

/** Returns an SSH Worker that creates a Hetzner Cloud server for each Attempt. */
const provisionedSshWorker = (name: string, max: number, serverType = "cx33") => `  - name: ${name}
    kind: ssh
    max_concurrent_attempts: ${max}
    root: /home/usine/.usine
    provisioner:
      provider: hetzner
      token_env: USINE_TEST_HCLOUD_TOKEN
      server_type: ${serverType}
      location: nbg1
      image: usine-worker-test
      ssh_key: usine-orchestrator
      api_keys:
        anthropic: USINE_TEST_ANTHROPIC_KEY
`;

describe("SSH Workers on reload", () => {
  it.live(
    "adds a provisioned SSH Worker with its provider token and API key read at the reload, and refuses a changed provisioner",
    () =>
      withWorkers(sshWorker("build-1", 1), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const events: Array<string> = [];
          const added: Array<SshWorkerAddress> = [];
          const environment: Record<string, string> = {};
          yield* startSshScheduler(events, { added, environment });

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(`${sshWorker("build-1", 1)}${provisionedSshWorker("pool", 2)}`),
            ],
          ]);
          const unset = yield* Effect.flip(instances.reload);
          assert(unset._tag === "ReloadPreflightError", unset._tag);
          assert.include(
            unset.message,
            'The hetzner API token for SSH worker "pool" is missing: USINE_TEST_HCLOUD_TOKEN is not set',
          );
          assert.include(unset.message, "set provisioner.token_env to a variable");

          environment.USINE_TEST_HCLOUD_TOKEN = "hcloud-token";
          environment.USINE_TEST_ANTHROPIC_KEY = "sk-ant-api-key";
          const report = yield* instances.reload;
          assert.deepStrictEqual(report.workers.added, [WorkerName.make("pool")]);
          const address = added.at(-1);
          assert(address !== undefined && address.machine._tag === "Provisioned");
          const { provisioner } = address.machine;
          assert.strictEqual(provisioner.provider, "hetzner");
          assert.strictEqual(Redacted.value(provisioner.token), "hcloud-token");
          assert.deepStrictEqual(
            Option.map(provisioner.apiKeys.anthropic, Redacted.value),
            Option.some("sk-ant-api-key"),
          );

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(`${sshWorker("build-1", 1)}${provisionedSshWorker("pool", 2, "cpx32")}`),
            ],
          ]);
          const changed = yield* Effect.flip(instances.reload);
          assert(changed._tag === "RestartRequiredError", changed._tag);
          assert.deepStrictEqual(changed.fields, ["workers.pool.provisioner"]);
        }).pipe(Effect.scoped),
      ),
  );

  it.live(
    "adds an SSH Worker to the executor before its preflight, with its Gateway's admin token read at the reload",
    () =>
      withWorkers(sshWorker("build-1", 1), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const events: Array<string> = [];
          const added: Array<SshWorkerAddress> = [];
          const environment: Record<string, string> = {};
          const scheduler = yield* startSshScheduler(events, { added, environment });
          const agent = yield* developer;
          yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const waiting = yield* Effect.forkChild(
            scheduler.reserve(runOf(2), submission(agent, 2), Option.none()),
          );
          events.length = 0;

          environment[TOKEN_ENV] = "admin-token-set-after-startup";
          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(`${sshWorker("build-1", 1)}${gatewaySshWorker("build-2", 1, TOKEN_ENV)}`),
            ],
          ]);
          const report = yield* instances.reload;
          assert.deepStrictEqual(report.workers.added, [build2]);
          assert.deepStrictEqual(events, ["add build-2", "build-2 x1: gpt-5.6-sol"]);
          const address = added.find(({ name }) => name === build2);
          assert(address !== undefined && Option.isSome(address.gateway));
          assert.strictEqual(address.gateway.value.destination, "usine-gateway");
          assert.strictEqual(
            Redacted.value(address.gateway.value.adminToken),
            "admin-token-set-after-startup",
          );
          assert.strictEqual((yield* leaseOf(waiting)).worker, build2);
        }).pipe(Effect.scoped),
      ),
  );

  it.live(
    "refuses a reload whose new SSH Worker's admin token variable is unset, naming the variable",
    () =>
      withWorkers(sshWorker("build-1", 1), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const running = yield* instances.get;
          const events: Array<string> = [];
          const scheduler = yield* startSshScheduler(events);
          events.length = 0;

          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(`${sshWorker("build-1", 1)}${gatewaySshWorker("build-2", 1, TOKEN_ENV)}`),
            ],
          ]);
          const failure = yield* Effect.flip(instances.reload);
          assert(failure._tag === "ReloadPreflightError", failure._tag);
          assert.deepStrictEqual(failure.workers, [build2]);
          assert(failure.cause._tag === "WorkerCapabilityError", failure.cause._tag);
          assert.strictEqual(failure.cause.capability, "gateway");
          assert.strictEqual(
            failure.cause.message,
            'The gateway admin token for SSH worker "build-2" is missing: USINE_TEST_GATEWAY_TWO_TOKEN is not set in the orchestrator\'s environment. usine up reads only the variables that were set when it started. Set USINE_TEST_GATEWAY_TWO_TOKEN and restart usine up, or set admin_token_env to a variable that usine up already has.',
          );
          const refusal = reloadRefusal(failure, failure.message);
          assert(refusal instanceof ReloadPreflightRefusal);
          assert.deepStrictEqual(refusal.cause, {
            _tag: "WorkerCapabilityError",
            worker: build2,
            capability: "gateway",
            message: failure.cause.message,
          });
          assert.notInclude(events, "add build-2");
          assert(
            !events.some((event) => event.startsWith("build-2 x")),
            "no preflight without the token",
          );
          assert.strictEqual(yield* instances.get, running);
          assert.deepStrictEqual(yield* scheduler.workers, [build1]);
        }).pipe(Effect.scoped),
      ),
  );

  it.live("takes an added SSH Worker away from the executor again when its preflight fails", () =>
    withWorkers(sshWorker("build-1", 1), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const events: Array<string> = [];
        const scheduler = yield* startSshScheduler(events, {
          environment: { [TOKEN_ENV]: "admin-token" },
          failing: ["build-2"],
        });
        events.length = 0;

        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml(`${sshWorker("build-1", 1)}${gatewaySshWorker("build-2", 1, TOKEN_ENV)}`),
          ],
        ]);
        const failure = yield* Effect.flip(instances.reload);
        assert(failure._tag === "ReloadPreflightError", failure._tag);
        assert.include(failure.message, "less than 1.5 GiB per Attempt");
        assert.deepStrictEqual(events, [
          "add build-2",
          "build-2 x1: gpt-5.6-sol",
          "remove build-2",
        ]);
        assert.deepStrictEqual(yield* scheduler.workers, [build1]);
      }).pipe(Effect.scoped),
    ),
  );

  it.live("takes a removed SSH Worker away from the executor once its last Attempt ends", () =>
    withWorkers(
      `${sshWorker("build-1", 1)}${sshWorker("build-2", 1)}${sshWorker("build-3", 1)}`,
      (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const events: Array<string> = [];
          const scheduler = yield* startSshScheduler(events);
          const agent = yield* developer;
          const onFirst = yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const onSecond = yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());
          assert.deepStrictEqual([onFirst.worker, onSecond.worker], [build1, build2]);
          events.length = 0;

          yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(sshWorker("build-1", 1))]]);
          const report = yield* instances.reload;
          assert.deepStrictEqual(report.workers.removed, [build2, build3]);
          assert.deepStrictEqual(events, ["remove build-3"], "build-3 runs no Attempt");
          yield* onSecond.release;
          assert.deepStrictEqual(events, ["remove build-3", "remove build-2"]);
        }).pipe(Effect.scoped),
    ),
  );

  it.live(
    "refuses changed settings when re-adding a draining SSH Worker, but accepts unchanged settings and more slots",
    () =>
      withWorkers(`${sshWorker("build-1", 1)}${sshWorker("build-2", 1)}`, (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const events: Array<string> = [];
          const scheduler = yield* startSshScheduler(events);
          const agent = yield* developer;
          yield* scheduler.reserve(runOf(1), submission(agent, 1), Option.none());
          const onSecond = yield* scheduler.reserve(runOf(2), submission(agent, 2), Option.none());
          assert.strictEqual(onSecond.worker, build2);
          events.length = 0;

          yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(sshWorker("build-1", 1))]]);
          yield* instances.reload;
          const running = yield* instances.get;
          yield* writeInstanceFiles(root, [
            [
              "usine.yaml",
              usineYaml(
                `${sshWorker("build-1", 1)}${sshWorker("build-2", 1, "usine@replacement-host")}`,
              ),
            ],
          ]);
          const failure = yield* instances.reload.pipe(Effect.flip);
          assert(failure._tag === "ReloadPreflightError", failure._tag);
          assert(failure.cause._tag === "WorkerCapabilityError", failure.cause._tag);
          assert.strictEqual(failure.cause.capability, "machine");
          assert.include(failure.cause.message, "while its attempts run");
          assert.strictEqual(yield* instances.get, running);
          assert.deepStrictEqual(yield* scheduler.workers, [build1, build2]);
          assert.deepStrictEqual(events, [], "the retained host is not preflighted or removed");
          yield* writeInstanceFiles(root, [
            ["usine.yaml", usineYaml(`${sshWorker("build-1", 1)}${sshWorker("build-2", 2)}`)],
          ]);
          yield* instances.reload;
          const next = yield* scheduler.reserve(runOf(3), submission(agent, 3), Option.none());
          assert.strictEqual(next.worker, build2);
          yield* next.release;
          yield* onSecond.release;
          assert.deepStrictEqual(events, ["build-2 x2: gpt-5.6-sol"]);
          assert.deepStrictEqual(yield* scheduler.workers, [build1, build2]);
        }).pipe(Effect.scoped),
      ),
  );
});

describe("Worker status", () => {
  it.live(
    "reports slots in use and the last preflight per harness, including a refused reload's",
    () =>
      withWorkers(localWorkers([["local", 2]]), (root) =>
        Effect.gen(function* () {
          const instances = yield* CurrentInstance;
          const { config, agents } = yield* instances.get;
          const executor = Layer.succeed(Executor)({
            kind: "local",
            recover: unused,
            isLive: unused,
            outcome: unused,
            prepare: unused,
            cancel: unused,
            intervene: unused,
            sweep: Effect.void,
            preflight: (worker, brains) =>
              brains.some(({ harness }) => harness === "claude")
                ? Effect.fail(
                    new WorkerCapabilityError({
                      worker,
                      capability: "harness-login",
                      message: "Claude Code is not logged in",
                      cause: new HarnessUnavailableError({
                        harness: "claude",
                        capability: "login",
                        message: "Claude Code is not logged in",
                      }),
                    }),
                  )
                : Effect.succeed(fullPreflight),
          });
          const context = yield* Layer.build(
            stepExecutorLayer(
              config,
              agents.map(({ agent }) => agent.brain),
            ).pipe(
              Layer.provide(MarcbachmannCelLayer),
              Layer.provide(executor),
              Layer.provide(testAppLayer),
            ),
          );
          const scheduler = Context.get(context, StepExecutor);
          const status = Context.get(context, WorkerStatus);
          const checks = Effect.map(status.preflights, (preflights) =>
            preflights.flatMap(({ worker, prerequisites, harnesses }) => [
              `${worker} ${Option.match(prerequisites, { onNone: () => "unchecked", onSome: ({ _tag }) => _tag })}`,
              ...harnesses.map(({ harness, check }) => `${worker} ${harness} ${check._tag}`),
            ]),
          );
          assert.deepStrictEqual(yield* checks, ["local Passed", "local codex Passed"]);
          assert.deepStrictEqual(yield* status.slots, [{ worker: local, capacity: 2, leased: 0 }]);

          yield* scheduler.reserve(runOf(1), submission(yield* developer, 1), Option.none());
          assert.deepStrictEqual(yield* status.slots, [{ worker: local, capacity: 2, leased: 1 }]);

          yield* writeInstanceFiles(root, [
            [
              "agents/reviewer.md",
              "---\nharness: claude\nmodel: claude-opus-4-1\neffort: high\n---\nReview the pull request.\n",
            ],
          ]);
          const refused = yield* Effect.flip(instances.reload);
          assert(refused._tag === "ReloadPreflightError", refused._tag);
          assert.deepStrictEqual(yield* checks, [
            "local Passed",
            "local claude Failed",
            "local codex Passed",
          ]);
        }).pipe(Effect.scoped),
      ),
  );
});

const cloudflareWorker = (name: string, url = "https://worker.example") => `  - name: ${name}
    kind: cloudflare
    worker_url: ${url}
    access_client_id_env: CF_CLIENT_ID
    access_client_secret_env: CF_CLIENT_SECRET
    image: usine
    instance_type: standard-4
`;

/**
 * Builds the scheduler over Cloudflare workers whose preflight records each checked URL and
 * fails for `https://typo.example`. Returns the registered addresses and the checked URLs.
 */
const cloudflareScheduler = Effect.gen(function* () {
  const instances = yield* CurrentInstance;
  const { config, agents } = yield* instances.get;
  const addresses = new Map<WorkerName, CloudflareWorkerAddress>();
  const checked: string[] = [];
  const context = yield* Layer.build(
    cloudflareStepExecutorLayer(
      config,
      agents.map(({ agent }) => agent.brain),
    ).pipe(
      Layer.provide(MarcbachmannCelLayer),
      Layer.provide(
        Layer.mock(Executor)({
          kind: "cloudflare",
          preflight: (worker) =>
            Effect.gen(function* () {
              const address = addresses.get(worker);
              assert(address !== undefined, `worker ${worker} isn't registered`);
              checked.push(address.workerUrl.href);
              assert.strictEqual(Redacted.value(address.accessClientSecret), "secret");
              if (address.workerUrl.hostname === "typo.example")
                return yield* new WorkerCapabilityError({
                  worker,
                  capability: "machine",
                  message: "The Worker URL doesn't answer",
                  cause: address.workerUrl.href,
                });
              return fullPreflight;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(CloudflareWorkers, {
          addWorker: (address) =>
            Effect.sync(() => {
              if (!addresses.has(address.name)) addresses.set(address.name, address);
            }),
          removeWorker: (worker) =>
            Effect.sync(() => {
              addresses.delete(worker);
            }),
        }),
      ),
      Layer.provide(testAppLayer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ CF_CLIENT_ID: "id", CF_CLIENT_SECRET: "secret" }),
        ),
      ),
    ),
  );
  return { scheduler: Context.get(context, StepExecutor), addresses, checked };
});

it.live(
  "adds a Cloudflare worker after resolving credentials and refuses existing connection changes",
  () =>
    withWorkers(cloudflareWorker("cf-one"), (root) =>
      Effect.gen(function* () {
        const instances = yield* CurrentInstance;
        const { scheduler, addresses, checked } = yield* cloudflareScheduler;
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml(
              cloudflareWorker("cf-one") + cloudflareWorker("cf-two", "https://second.example"),
            ),
          ],
        ]);
        const added = yield* instances.reload;
        assert.deepStrictEqual(added.workers.added, [WorkerName.make("cf-two")]);
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml(
              cloudflareWorker("cf-one", "https://changed.example") +
                cloudflareWorker("cf-two", "https://second.example"),
            ),
          ],
        ]);
        const running = yield* instances.get;
        const refused = yield* instances.reload.pipe(Effect.flip);
        assert(refused._tag === "RestartRequiredError", refused._tag);
        assert.deepStrictEqual(refused.fields, ["workers.cf-one.worker_url"]);
        assert.strictEqual(yield* instances.get, running);
        assert.deepStrictEqual(checked, ["https://worker.example/", "https://second.example/"]);
        assert.deepStrictEqual(yield* scheduler.workers, [
          WorkerName.make("cf-one"),
          WorkerName.make("cf-two"),
        ]);

        yield* writeInstanceFiles(root, [
          ["usine.yaml", usineYaml(cloudflareWorker("cf-two", "https://second.example"))],
        ]);
        yield* instances.reload;
        const removed = yield* instances.get;
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml(
              cloudflareWorker("cf-one", "https://changed.example") +
                cloudflareWorker("cf-two", "https://second.example"),
            ),
          ],
        ]);
        const readded = yield* instances.reload.pipe(Effect.flip);
        assert(readded._tag === "ReloadPreflightError", readded._tag);
        assert(readded.cause._tag === "WorkerCapabilityError", readded.cause._tag);
        assert.include(readded.cause.message, "retained attempts keep their machine");
        assert.strictEqual(yield* instances.get, removed);
        assert.strictEqual(
          addresses.get(WorkerName.make("cf-one"))?.workerUrl.href,
          "https://worker.example/",
        );
        yield* writeInstanceFiles(root, [
          [
            "usine.yaml",
            usineYaml(
              cloudflareWorker("cf-one") + cloudflareWorker("cf-two", "https://second.example"),
            ),
          ],
        ]);
        yield* instances.reload;
        assert.deepStrictEqual(checked, [
          "https://worker.example/",
          "https://second.example/",
          "https://worker.example/",
        ]);
      }).pipe(Effect.scoped),
    ),
);

it.live("accepts a corrected Cloudflare worker after its added-worker preflight fails", () =>
  withWorkers(cloudflareWorker("cf-one"), (root) =>
    Effect.gen(function* () {
      const instances = yield* CurrentInstance;
      const { scheduler, addresses, checked } = yield* cloudflareScheduler;
      const running = yield* instances.get;
      yield* writeInstanceFiles(root, [
        [
          "usine.yaml",
          usineYaml(
            cloudflareWorker("cf-one") + cloudflareWorker("cf-two", "https://typo.example"),
          ),
        ],
      ]);
      const refused = yield* instances.reload.pipe(Effect.flip);
      assert(refused._tag === "ReloadPreflightError", refused._tag);
      assert.strictEqual(yield* instances.get, running);
      assert.isFalse(addresses.has(WorkerName.make("cf-two")));

      yield* writeInstanceFiles(root, [
        [
          "usine.yaml",
          usineYaml(
            cloudflareWorker("cf-one") + cloudflareWorker("cf-two", "https://second.example"),
          ),
        ],
      ]);
      const corrected = yield* instances.reload;
      assert.deepStrictEqual(corrected.workers.added, [WorkerName.make("cf-two")]);
      assert.deepStrictEqual(checked, [
        "https://worker.example/",
        "https://typo.example/",
        "https://second.example/",
      ]);
      assert.strictEqual(
        addresses.get(WorkerName.make("cf-two"))?.workerUrl.href,
        "https://second.example/",
      );
      assert.deepStrictEqual(yield* scheduler.workers, [
        WorkerName.make("cf-one"),
        WorkerName.make("cf-two"),
      ]);

      yield* writeInstanceFiles(root, [["usine.yaml", usineYaml(cloudflareWorker("cf-one"))]]);
      yield* instances.reload;
      const removed = yield* instances.get;
      yield* writeInstanceFiles(root, [
        [
          "usine.yaml",
          usineYaml(
            cloudflareWorker("cf-one") + cloudflareWorker("cf-two", "https://typo.example"),
          ),
        ],
      ]);
      const changed = yield* instances.reload.pipe(Effect.flip);
      assert(changed._tag === "ReloadPreflightError", changed._tag);
      assert.include(changed.cause.message, "retained attempts keep their machine");
      assert.strictEqual(yield* instances.get, removed);
      assert.strictEqual(
        addresses.get(WorkerName.make("cf-two"))?.workerUrl.href,
        "https://second.example/",
      );
    }).pipe(Effect.scoped),
  ),
);
