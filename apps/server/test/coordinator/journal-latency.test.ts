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
  EncodedState,
  JournalRevision,
  OutputSaved,
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
// The median of one child event's writes, in milliseconds: about 0.7 ms locally with targeted
// statements, and about 6 ms when each write loads the journal.
const BUDGET_MILLIS = 5;

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

/** Writes one child event as the coordinator does: reserve its envelope, save the output, and acknowledge. */
const childEvent = (sequence: AttemptChannel.Sequence) =>
  Effect.gen(function* () {
    const journal = yield* AttemptJournal;
    yield* journal.reserve(attemptId, [
      AttemptChannel.OutboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId,
        sequence,
        sentAt: yield* DateTime.now,
        payload: AttemptChannel.SessionEvent.make({
          event: TextOutput.make({ session: childSession, text: "Working" }),
        }),
      }),
    ]);
    yield* journal.saveProgress(
      attemptId,
      ChildSessionCount.make(CHILDREN),
      OutputSaved.make({ output: `${OUTPUT.slice(sequence)}Working\n` }),
    );
    yield* journal.acknowledge(attemptId, sequence);
  });

it.live(
  `writes a coordinator's child event to SQLite in a median below ${BUDGET_MILLIS} ms`,
  () =>
    Effect.gen(function* () {
      const directory = yield* instanceDirectory;
      const durations = yield* Effect.gen(function* () {
        yield* seeded;
        const durations: Array<number> = [];
        for (let round = 1; round <= ROUNDS; round += 1) {
          const started = yield* Clock.currentTimeNanos;
          yield* childEvent(AttemptChannel.Sequence.make(round));
          const ended = yield* Clock.currentTimeNanos;
          durations.push(Number(ended - started) / 1_000_000);
        }
        return durations;
      }).pipe(
        Effect.provide(
          sqliteAttemptJournalLayer.pipe(Layer.provide(localSqliteLayer(directory)), Layer.orDie),
        ),
      );
      const sorted = [...durations].sort((left, right) => left - right);
      const median = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
      assert.isBelow(
        median,
        BUDGET_MILLIS,
        `median of ${ROUNDS} child events, in milliseconds; slowest ${sorted.at(-1)?.toFixed(1)}`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
