import { assert, describe, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { IssueTrigger } from "@usine/config/trigger";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  ProviderRetries,
  ProviderRetrying,
  TextOutput,
} from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, BlockedFailure } from "@usine/core/attempt/failure";
import {
  AttemptCanceled,
  AttemptFailed,
  type AttemptOutcome,
  AttemptSucceeded,
} from "@usine/core/attempt/outcome";
import {
  CycleBudgetAsk,
  CycleBudgetAskId,
  CycleCount,
  CycleLimit,
  LoopCycleCount,
} from "@usine/core/cycle-budget";
import { EventId } from "@usine/core/event";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionReader,
  ItemProjectionSource,
} from "@usine/engine/item-projection";
import { LoopRuntimeState } from "@usine/engine/loop-control";
import { LoopSighting, RunReader, RunSummary } from "@usine/engine/run-reader";
import { TranscriptEntry, TranscriptSequence } from "@usine/engine/transcript";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { OperatorObservation } from "../src/operator/operator.ts";
import { PollCycle, PollingTriggers, RepositoryPoll } from "../src/polling-triggers.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";
import { ScheduleTriggers } from "../src/schedule-triggers.ts";
import { WorkerStatus } from "../src/worker-status.ts";
import {
  emptyCycleBudgets,
  loopControlLayer,
  repositoryLabelProjectionReaderLayer,
} from "./support/polling.ts";
import { CycleBudgets } from "@usine/engine/cycle-budget";

const time = (clock: string) => DateTime.makeUnsafe(`2026-10-20T${clock}.000Z`);
const repository = RepositoryName.make("basaltbytes/usine");
const brain = new BrainSpec({
  harness: "claude",
  model: ModelId.make("claude-opus"),
  effort: "high",
});
const developer = new AgentFile({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const labelled = (name: string, label: string) =>
  new LoopFile({
    name: LoopName.make(name),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(`item.labels.nodes.exists(label, label.name == "${label}")`),
    }),
    selector: Option.none(),
    approval: "none",
    step: StepName.make("run"),
    agent: developer.name,
    body: PromptTemplate.make("Work on it."),
  });
const startDev = labelled("start-dev", "ready");
const review = labelled("review", "review");
const instance = new LoadedInstance({
  config: Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: repository }],
    workers: [
      { name: "local", kind: "local", max_concurrent_attempts: 2 },
      { name: "spare", kind: "local", max_concurrent_attempts: 1 },
      { name: "fresh", kind: "local", max_concurrent_attempts: 1 },
    ],
  }),
  agents: [developer],
  invalidAgents: [],
  loops: [startDev, review],
  quarantinedLoops: [],
  warnings: [],
});

const itemKey = (number: number) => gitHubItemKey(repository, number);
const issue = (number: number, labels: ReadonlyArray<string>, gone = false) =>
  new ItemProjection({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://github.com/basaltbytes/usine/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-10-19T10:00:00Z",
      updatedAt: "2026-10-19T12:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
      assignees: { totalCount: 0, nodes: [] },
      comments: { totalCount: 0, nodes: [] },
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
    goneAt: gone ? Option.some(time("09:00:00")) : Option.none(),
  });

const agent = new Agent({
  name: developer.name,
  brain,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: developer.persona,
});

const attempt = (
  run: string,
  startedAt: string,
  outcome: Option.Option<AttemptOutcome>,
  endedAt: Option.Option<string> = Option.none(),
) =>
  new Attempt({
    id: AttemptId.make(`${run}-attempt`),
    runId: RunId.make(run),
    stepName: StepName.make("run"),
    worker: WorkerName.make("local"),
    number: AttemptNumber.make(1),
    brain,
    task: AttemptTask.make("Work on it."),
    agent: developer.name,
    operatorIntervened: false,
    parentModel: Option.none(),
    startedAt: time(startedAt),
    outcome,
    endedAt: Option.map(endedAt, time),
    salvage: Option.none(),
  });

const summary = (
  id: string,
  item: number,
  state: RunState.RunState,
  openedAt: string,
  attempts: ReadonlyArray<Attempt> = [],
  loop: LoopFile = startDev,
) =>
  new RunSummary({
    itemKey: itemKey(item),
    run: new Run({
      id: RunId.make(id),
      eventId: EventId.make(`event-${id}`),
      loop: loop.name,
      state,
      openedAt: time(openedAt),
    }),
    step: new Step({ runId: RunId.make(id), name: StepName.make("run"), result: Option.none() }),
    attempts,
    resolvedFailureAttemptId: Option.none(),
    closedAt: Option.none(),
    approval: Option.none(),
    runAgain: Option.none(),
    repository,
    task: AttemptTask.make("Work on it."),
    agent,
  });

const sighting = (
  item: number,
  run: string | null,
  heldBy: string | null = null,
  loop: LoopFile = startDev,
) =>
  new LoopSighting({
    loop: loop.name,
    itemKey: itemKey(item),
    event: Option.some(EventId.make(`event-${run ?? item}`)),
    run: Option.map(Option.fromNullishOr(run), RunId.make),
    heldBy: Option.map(Option.fromNullishOr(heldBy), RunId.make),
  });

const canceledByOperator = new RunState.Canceled({ reason: new RunState.OperatorCanceled() });
const items = [
  issue(1, ["ready"]),
  issue(2, ["ready"]),
  issue(3, ["ready"]),
  issue(4, ["ready"]),
  issue(5, ["ready"]),
  issue(6, ["ready"]),
  issue(7, ["ready"]),
  issue(8, ["ready"]),
  issue(9, ["bug"]),
  issue(10, ["review"]),
  issue(11, ["done"]),
  issue(12, ["ready"], true),
];
const runs = [
  summary("canceled-1", 1, canceledByOperator, "08:00:00", [
    attempt("canceled-1", "08:01:00", Option.some(new AttemptCanceled()), Option.some("08:20:00")),
  ]),
  summary("blocked-2", 2, new RunState.Failed(), "08:30:00", [
    attempt(
      "blocked-2",
      "08:31:00",
      Option.some(new AttemptFailed({ failure: new BlockedFailure({ message: "Main is red." }) })),
      Option.some("08:50:00"),
    ),
  ]),
  summary("waiting-3", 3, new RunState.Waiting(), "09:00:00"),
  summary("queued-4", 4, new RunState.Queued(), "09:10:00"),
  summary("failed-6", 6, new RunState.Failed(), "09:20:00", [
    attempt(
      "failed-6",
      "09:21:00",
      Option.some(new AttemptFailed({ failure: new AgentFailure({ message: "No login." }) })),
      Option.some("09:40:00"),
    ),
  ]),
  summary("running-8", 8, new RunState.Running(), "11:00:00", [
    attempt("running-8", "11:01:00", Option.none()),
  ]),
  summary("canceled-9", 9, canceledByOperator, "07:00:00", [
    attempt("canceled-9", "07:01:00", Option.some(new AttemptCanceled()), Option.some("07:30:00")),
  ]),
  summary("succeeded-11", 11, new RunState.Succeeded(), "10:00:00", [
    attempt(
      "succeeded-11",
      "10:01:00",
      Option.some(new AttemptSucceeded()),
      Option.some("10:45:00"),
    ),
  ]),
  summary(
    "superseded-11",
    11,
    new RunState.Canceled({ reason: new RunState.Superseded({ by: EventId.make("event-later") }) }),
    "10:50:00",
  ),
];
const sightings = [
  sighting(1, "canceled-1"),
  sighting(2, "blocked-2", "blocked-2"),
  sighting(3, "waiting-3"),
  sighting(4, "queued-4"),
  sighting(5, null),
  sighting(6, "failed-6"),
  sighting(8, "running-8"),
  sighting(9, "canceled-9"),
];
const ask = new CycleBudgetAsk({
  id: CycleBudgetAskId.make("event-budget-5"),
  itemKey: itemKey(5),
  repository,
  loop: startDev.name,
  limit: CycleLimit.make(3),
  counts: [
    new LoopCycleCount({
      loop: startDev.name,
      admitted: CycleCount.make(3),
      completed: CycleCount.make(3),
    }),
  ],
});

const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: developer.name,
  brain,
});
const child = new ChildSession({
  id: AgentSessionId.make("child"),
  parentId: parent.id,
  agent: AgentName.make("researcher"),
  brain,
});
const outbound = (sequence: number, at: string, payload: AttemptChannel.OutboundPayload) =>
  new TranscriptEntry({
    sequence: TranscriptSequence.make(sequence),
    attemptId: AttemptId.make("running-8-attempt"),
    direction: "outbound",
    envelope: new AttemptChannel.OutboundEnvelope({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId: AttemptId.make("running-8-attempt"),
      sequence: AttemptChannel.Sequence.make(sequence),
      sentAt: time(at),
      payload,
    }),
    receivedAt: time(at),
  });
const retrying = (retries: number) =>
  new AttemptChannel.SessionEvent({
    event: new ProviderRetrying({
      session: child,
      message: "Reconnecting... waiting for network",
      retries: ProviderRetries.make(retries),
    }),
  });
const transcript = [
  outbound(
    1,
    "11:50:00",
    new AttemptChannel.SessionEvent({ event: new TextOutput({ session: parent, text: "Tests" }) }),
  ),
  outbound(
    2,
    "11:55:00",
    new AttemptChannel.WorkerUnresponsive({
      worker: WorkerName.make("local"),
      lastAnsweredAt: time("11:54:00"),
      reason: "No answer within 45 seconds",
    }),
  ),
  outbound(3, "11:56:00", retrying(1)),
  outbound(4, "11:57:00", retrying(2)),
];

const deskLayer = (polls: ReadonlyArray<RepositoryPoll>) => {
  const reader = Layer.succeed(RunReader)({
    inspect: () => Effect.die("unused"),
    evidence: () => Effect.die("unused"),
    list: () => Effect.succeed(runs),
    closed: ({ limit }) =>
      Effect.succeed(
        runs
          .filter(({ run }) => !RunState.OPEN_STATE_TAGS.some((tag) => tag === run.state._tag))
          .slice(0, limit),
      ),
    forItems: (keys) => Effect.succeed(runs.filter(({ itemKey }) => keys.includes(itemKey))),
    events: () => Effect.die("unused"),
    revision: () => Effect.die("unused"),
    transcript: (query) =>
      Effect.succeed(query.attemptId === AttemptId.make("running-8-attempt") ? transcript : []),
    attemptsByWorker: () => Effect.die("unused"),
    sightings: (keys) => Effect.succeed(sightings.filter(({ itemKey }) => keys.includes(itemKey))),
  });
  const polling = Layer.succeed(PollingTriggers)({
    hint: () => Effect.void,
    poll: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(
      polls.length === 0
        ? Option.none()
        : Option.some(
            new PollCycle({
              repositoryPolls: polls,
              repositories: 1,
              changedItems: 0,
              submissions: [],
              revokedRuns: 0,
              failures: [],
              preflightFindings: [],
              nextPollAt: Option.none(),
            }),
          ),
    ),
  });
  const schedules = Layer.succeed(ScheduleTriggers)({
    tick: () => Effect.die("unused"),
    run: () => Effect.never,
    latest: Effect.succeed(Option.none()),
  });
  const passed = (clock: string) => ({ _tag: "Passed" as const, checkedAt: time(clock) });
  const slots = Layer.succeed(WorkerStatus)({
    slots: Effect.succeed([
      { worker: WorkerName.make("local"), capacity: 2, leased: 1 },
      { worker: WorkerName.make("spare"), capacity: 1, leased: 0 },
    ]),
    preflights: Effect.succeed([
      {
        worker: WorkerName.make("local"),
        prerequisites: Option.some(passed("05:00:00")),
        harnesses: [
          { harness: "claude", check: passed("06:30:00") },
          {
            harness: "codex",
            check: {
              _tag: "Failed",
              checkedAt: time("06:00:00"),
              capability: Option.none(),
              message: "Codex is not logged in",
            },
          },
        ],
      },
      {
        worker: WorkerName.make("spare"),
        prerequisites: Option.some(passed("05:00:00")),
        harnesses: [{ harness: "claude", check: passed("05:30:00") }],
      },
    ]),
  });
  return OperatorObservation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        reader,
        polling,
        schedules,
        slots,
        Layer.succeed(CycleBudgets)({ ...emptyCycleBudgets, asks: () => Effect.succeed([ask]) }),
        Layer.succeed(ItemProjectionReader)({
          list: () => Effect.succeed(items),
          openIssues: () => Effect.die("the desk does not check open issues"),
        }),
        loopControlLayer([new LoopRuntimeState({ loop: review.name, paused: true })]),
        repositoryLabelProjectionReaderLayer,
        MarcbachmannCelLayer,
      ),
    ),
  );
};

const polled = [new RepositoryPoll({ repository, completedAt: time("11:59:00") })];

describe("Operator desk", () => {
  it.effect("says why each Item a Loop matches has no Attempt running on it", () =>
    Effect.gen(function* () {
      const desk = yield* (yield* OperatorObservation).desk(instance);
      assert.deepStrictEqual(
        desk.notMoving.map(({ loop, item, reason }) => [item.number, loop, reason._tag]),
        [
          [3, "start-dev", "AwaitingApproval"],
          [2, "start-dev", "HeldForOperator"],
          [5, "start-dev", "CycleBudgetUsedUp"],
          [6, "start-dev", "RunFailed"],
          [1, "start-dev", "ClosedUnchanged"],
          [10, "review", "LoopPaused"],
          [4, "start-dev", "QueuedForWorker"],
          [7, "start-dev", "AwaitingPoll"],
        ],
      );
      const runOf = (number: number) => {
        const reason = desk.notMoving.find(({ item }) => item.number === number)?.reason;
        return reason !== undefined && "run" in reason ? reason.run.id : null;
      };
      assert.strictEqual(runOf(1), RunId.make("canceled-1"));
      assert.strictEqual(runOf(2), RunId.make("blocked-2"));
      assert.strictEqual(runOf(3), RunId.make("waiting-3"));
      const budget = desk.notMoving.find(({ item }) => item.number === 5)?.reason;
      assert(budget?._tag === "CycleBudgetUsedUp");
      assert.strictEqual(budget.ask.id, ask.id);
    }).pipe(Effect.provide(deskLayer(polled))),
  );

  it.effect(
    "lists Attempts in flight with their last activity and open connectivity warnings",
    () =>
      Effect.gen(function* () {
        const desk = yield* (yield* OperatorObservation).desk(instance);
        assert.strictEqual(desk.running.length, 1);
        const [running] = desk.running;
        assert(running !== undefined);
        assert.strictEqual(running.run.id, RunId.make("running-8"));
        assert.strictEqual(running.attempt.id, AttemptId.make("running-8-attempt"));
        assert.strictEqual(running.item?.title, "Issue 8");
        assert.strictEqual(running.lastActivityAt, DateTime.formatIso(time("11:50:00")));
        assert.deepStrictEqual(
          running.warnings.map((warning) =>
            warning._tag === "WorkerSilent"
              ? [warning._tag, warning.worker, warning.lastAnsweredAt]
              : [warning._tag, warning.agent, warning.retries, warning.since],
          ),
          [
            ["WorkerSilent", "local", DateTime.formatIso(time("11:54:00"))],
            ["ProviderRetrying", "researcher", 2, DateTime.formatIso(time("11:56:00"))],
          ],
        );
      }).pipe(Effect.provide(deskLayer(polled))),
  );

  it.effect(
    "lists the Runs that closed last, newest first, without those replaced before starting",
    () =>
      Effect.gen(function* () {
        const desk = yield* (yield* OperatorObservation).desk(instance);
        assert.deepStrictEqual(
          desk.lastOutcomes.map(({ run, closedAt }) => [run.id, run.state, closedAt]),
          [
            ["succeeded-11", "Succeeded", DateTime.formatIso(time("10:45:00"))],
            ["failed-6", "Failed", DateTime.formatIso(time("09:40:00"))],
            ["blocked-2", "Failed", DateTime.formatIso(time("08:50:00"))],
            ["canceled-1", "Canceled", DateTime.formatIso(time("08:20:00"))],
            ["canceled-9", "Canceled", DateTime.formatIso(time("07:30:00"))],
          ],
        );
      }).pipe(Effect.provide(deskLayer(polled))),
  );

  it.effect(
    "reports each Worker's slots and last preflight, and when each repository was polled",
    () =>
      Effect.gen(function* () {
        const desk = yield* (yield* OperatorObservation).desk(instance);
        assert.deepStrictEqual(
          desk.workers.map(({ name, slots, preflight }) => [
            `${name} ${slots.leased}/${slots.capacity}`,
            preflight === null ? null : `${preflight._tag} ${preflight.checkedAt}`,
          ]),
          [
            // A harness that stands failed outranks a newer pass.
            ["local 1/2", `Failed ${DateTime.formatIso(time("06:00:00"))}`],
            ["spare 0/1", `Passed ${DateTime.formatIso(time("05:30:00"))}`],
            ["fresh 0/1", null],
          ],
        );
        assert.deepStrictEqual(
          desk.polls.map(({ repository: name, polledAt }) => [name, polledAt]),
          [[repository, DateTime.formatIso(time("11:59:00"))]],
        );
      }).pipe(Effect.provide(deskLayer(polled))),
  );

  it.effect("has no poll time for a repository before its first poll ends", () =>
    Effect.gen(function* () {
      const desk = yield* (yield* OperatorObservation).desk(instance);
      assert.deepStrictEqual(
        desk.polls.map(({ polledAt }) => polledAt),
        [null],
      );
    }).pipe(Effect.provide(deskLayer([]))),
  );
});
