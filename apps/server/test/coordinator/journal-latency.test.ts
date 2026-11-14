import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ChildSessionBudget,
  ChildSessionCount,
  TextOutput,
} from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InstanceDirectory } from "@usine/core/instance";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { StoredRequest } from "@usine/durable/attempt-runtime";
import {
  AttemptJournal,
  Delegate,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  encodeIntervention,
  EncodedState,
  JournalRevision,
  OutputSaved,
  QueuedInput,
  SessionSaved,
  Transition,
} from "@usine/durable/coordinator/journal";
import { sqliteAttemptJournalLayer } from "@usine/durable/coordinator/sqlite";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { Clock, DateTime, Effect, FileSystem, Layer, Option } from "effect";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";

// A long coordinated Attempt: every child of a 30-child budget saved its session and the retained
// output that the coordinator caps at 50,000 characters. A write that loads the whole journal reads
// all of it for each event.
const CHILDREN = 30;
const OUTPUT = "x".repeat(50_000);
const SAVED_SESSION = { harnessSession: { id: "native-session", cwd: "/workspace/usine" } };
const ROUNDS = 200;
// Each write has its own median budget. Output saves decode and encode one delegation's progress;
// reserve, acknowledge, and forgetInput use targeted statements independent of the other children.
const BUDGET_MILLIS = 1;

const WRITES = ["reserve", "output save", "acknowledge", "forgetInput"] as const;
type Write = (typeof WRITES)[number];

const attemptId = AttemptId.make("latency/coordinator-journal");
const request = StoredRequest.make({
  spec: AttemptChannel.RunSpec.make({
    attemptId,
    repository: RepositoryName.make("basaltbytes/usine"),
    revision: RepositoryRevision.make("main"),
    baseCommit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
    payload: { number: 1237 },
    task: AttemptTask.make("Measure the coordinator's writes."),
    agent: Agent.make({
      name: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-6-astra"),
        effort: "medium",
      }),
      parentModel: Option.none(),
      parentEffort: Option.none(),
      persona: AgentPersona.make("Implement the issue."),
    }),
    parentModel: Option.none(),
    maxChildren: ChildSessionBudget.make(CHILDREN),
    parentEffort: "medium",
    coordinator: "events",
    resume: Option.none(),
    preparedAt: Option.none(),
    botLogin: Option.none(),
  }),
  worker: WorkerName.make("local"),
  cwd: "/workspace/usine",
});

const childSession = ChildSession.make({
  id: AgentSessionId.make(`parent:${attemptId}:child:${CHILDREN}`),
  parentId: AgentSessionId.make(`parent:${attemptId}`),
  agent: request.spec.agent.name,
  brain: request.spec.agent.brain,
});

const instanceDirectory = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({
    directory: sqliteTempDirectory(),
    prefix: "usine-coordinator-latency-",
  }),
).pipe(Effect.map(InstanceDirectory.make));

/** Opens the Attempt with every delegation started and holding its saved conversation and output. */
const seeded = Effect.gen(function* () {
  const journal = yield* AttemptJournal;
  yield* journal.open(request);
  yield* journal.transition(
    attemptId,
    JournalRevision.make(0),
    Transition.make({
      event: EncodedEvent.make({ _tag: "AttemptStarted" }),
      decision: EncodedDecision.make({ decision: { _tag: "StartChild" }, handler: "rule" }),
      state: EncodedState.make({ _tag: "Delegating", child: CHILDREN }),
      intents: Array.from({ length: CHILDREN }, (_, index) =>
        Delegate.make({
          delegation: Delegation.make({
            number: ChildSessionCount.make(index + 1),
            assignment: Option.none(),
          }),
        }),
      ),
      outbound: [],
    }),
  );
  for (let child = 1; child <= CHILDREN; child += 1) {
    const number = ChildSessionCount.make(child);
    yield* journal.startDelegation(attemptId, number);
    yield* journal.saveProgress(
      attemptId,
      number,
      SessionSaved.make({ saved: SAVED_SESSION, beforePrompt: false }),
    );
    yield* journal.saveProgress(attemptId, number, OutputSaved.make({ output: OUTPUT }));
  }
});

/** Times `write`, in milliseconds. */
const timed = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeNanos;
    yield* write;
    const ended = yield* Clock.currentTimeNanos;
    return Number(ended - started) / 1_000_000;
  });

/**
 * Writes one child event as the coordinator does: reserve its envelope, save the output, and
 * acknowledge, followed by a queued operator input's receipt. Returns the duration of each write.
 */
const childEvent = (sequence: AttemptChannel.Sequence) =>
  Effect.gen(function* () {
    const journal = yield* AttemptJournal;
    const envelope = AttemptChannel.OutboundEnvelope.make({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence,
      sentAt: yield* DateTime.now,
      payload: AttemptChannel.SessionEvent.make({
        event: TextOutput.make({ session: childSession, text: "Working" }),
      }),
    });
    const reserve = yield* timed(journal.reserve(attemptId, [envelope]));
    const output = yield* timed(
      journal.saveProgress(
        attemptId,
        ChildSessionCount.make(CHILDREN),
        OutputSaved.make({ output: `${OUTPUT.slice(sequence)}Working\n` }),
      ),
    );
    const acknowledge = yield* timed(journal.acknowledge(attemptId, sequence));
    const intervention = AttemptChannel.Intervention.make({
      target: AttemptChannel.ChildTarget.make({ sessionId: childSession.id }),
      operator: "octocat",
      action: AttemptChannel.Steer.make({ message: "Run the tests." }),
    });
    const encoded = yield* encodeIntervention(intervention);
    yield* journal.queueInput(
      attemptId,
      QueuedInput.make({
        inputSequence: sequence,
        sessionId: childSession.id,
        intervention: encoded,
      }),
    );
    const receipt = AttemptChannel.OutboundEnvelope.make({
      version: AttemptChannel.PROTOCOL_VERSION,
      attemptId,
      sequence: AttemptChannel.Sequence.make(sequence + 1),
      sentAt: yield* DateTime.now,
      payload: AttemptChannel.InterventionApplied.make({
        inputSequence: sequence,
        intervention,
        state: AttemptChannel.InterventionState.make({ held: true, paused: false }),
      }),
    });
    const forgetInput = yield* timed(journal.forgetInput(attemptId, sequence, [receipt]));
    yield* journal.acknowledge(attemptId, receipt.sequence);
    return { reserve, "output save": output, acknowledge, forgetInput } satisfies Record<
      Write,
      number
    >;
  });

const median = (durations: ReadonlyArray<number>) => {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY,
    slowest: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
};

it.live(
  `keeps each SQLite write of a coordinator's child event in a median below ${BUDGET_MILLIS} ms`,
  () =>
    Effect.gen(function* () {
      const directory = yield* instanceDirectory;
      const events = yield* Effect.gen(function* () {
        yield* seeded;
        const events: Array<Record<Write, number>> = [];
        for (let round = 1; round <= ROUNDS; round += 1) {
          const event = yield* childEvent(AttemptChannel.Sequence.make(round * 2 - 1));
          events.push(event);
        }
        return events;
      }).pipe(
        Effect.provide(
          sqliteAttemptJournalLayer.pipe(Layer.provide(localSqliteLayer(directory)), Layer.orDie),
        ),
      );
      for (const write of WRITES) {
        const measured = median(events.map((event) => event[write]));
        assert.isBelow(
          measured.median,
          BUDGET_MILLIS,
          `median ${write} of ${ROUNDS} child events, in milliseconds; slowest ${measured.slowest.toFixed(1)}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
