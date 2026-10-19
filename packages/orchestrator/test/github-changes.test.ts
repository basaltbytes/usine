import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure } from "@usine/core/attempt/failure";
import { AttemptFailed } from "@usine/core/attempt/outcome";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunReader, RunSnapshot, RunSummary } from "@usine/engine/run-reader";
import { TranscriptEntry, TranscriptSequence } from "@usine/engine/transcript";
import {
  Commented,
  GitHubItemHistory,
  type ItemChange,
  LabelAdded,
  LabelRemoved,
} from "@usine/github/item-history";
import { RepositoryLabel, RepositoryLabelColor, RepositoryLabelName } from "@usine/github/polling";
import { DateTime, Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { RunGitHubChanges, type RunGitHubChangesView } from "../src/operator/github-changes.ts";
import { gitHubItemKey } from "../src/polling/repository-sync.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const itemKey = gitHubItemKey(repository, 247);
const runId = RunId.make("d4ca1525f463fad8df76328db85a7611");
const brain = new BrainSpec({
  harness: "codex",
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
});
const agent = new Agent({
  name: AgentName.make("developer"),
  brain,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
const time = (iso: string) => DateTime.makeUnsafe(iso);
const failed = Option.some(
  new AttemptFailed({ failure: new AgentFailure({ message: "Baseline gate blocked." }) }),
);
const attempt = (
  owner: RunId,
  number: number,
  startedAt: string,
  end: { readonly endedAt: string | null; readonly live?: boolean },
) =>
  new Attempt({
    id: AttemptId.make(`${owner}/implement/${number}`),
    runId: owner,
    stepName: StepName.make("implement"),
    worker: WorkerName.make("usine-worker-1"),
    number: AttemptNumber.make(number),
    brain,
    task: AttemptTask.make("Implement #247."),
    agent: agent.name,
    operatorIntervened: false,
    parentModel: Option.none(),
    startedAt: time(startedAt),
    outcome: end.live === true ? Option.none() : failed,
    endedAt: end.endedAt === null ? Option.none() : Option.some(time(end.endedAt)),
    salvage: Option.none(),
  });

// The first Attempt ended before end times were recorded; its last transcript row ends it.
const first = attempt(runId, 1, "2026-10-15T19:30:39.216Z", { endedAt: null });
const second = attempt(runId, 2, "2026-10-16T09:46:08.415Z", {
  endedAt: "2026-10-16T09:48:17.274Z",
});
const third = attempt(runId, 3, "2026-10-16T13:02:00.345Z", { endedAt: null, live: true });
const reviewRunId = RunId.make("review-run");
const review = attempt(reviewRunId, 1, "2026-10-16T13:04:00.000Z", {
  endedAt: "2026-10-16T13:06:00.000Z",
});

const step = (owner: RunId) =>
  new Step({ runId: owner, name: StepName.make("implement"), result: Option.none() });
const run = (owner: RunId, loop: string) =>
  new Run({
    id: owner,
    eventId: EventId.make(`event-${owner}`),
    loop: LoopName.make(loop),
    state: new RunState.Running(),
    openedAt: time("2026-10-15T19:30:21.965Z"),
  });
const snapshot = (attempts: ReadonlyArray<Attempt>) =>
  new RunSnapshot({
    event: new Event({
      id: EventId.make(`event-${runId}`),
      dedupKey: DedupKey.make(`event-${runId}`),
      payload: { number: 247 },
      receivedAt: time("2026-10-15T19:30:21.965Z"),
    }),
    itemKey,
    run: run(runId, "start-dev"),
    step: step(runId),
    attempts,
    resolvedFailureAttemptId: Option.none(),
    repository,
    revision: RepositoryRevision.make("main"),
    task: AttemptTask.make("Implement #247."),
    agent,
    parentModel: Option.none(),
  });
const reviewRun = new RunSummary({
  itemKey,
  run: run(reviewRunId, "review-issue"),
  step: step(reviewRunId),
  attempts: [review],
  resolvedFailureAttemptId: Option.none(),
  repository,
  task: AttemptTask.make("Review #247."),
  agent,
});

const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: agent.name,
  brain,
});
const lastRow = new TranscriptEntry({
  sequence: TranscriptSequence.make(19171),
  attemptId: first.id,
  direction: "outbound",
  envelope: new AttemptChannel.OutboundEnvelope({
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId: first.id,
    sequence: AttemptChannel.Sequence.make(1),
    sentAt: time("2026-10-15T19:55:19.808Z"),
    payload: new AttemptChannel.SessionEvent({
      event: new TextOutput({ session: parent, text: "Recorded the blocker on #247." }),
    }),
  }),
  receivedAt: time("2026-10-15T19:55:19.808Z"),
});

const label = (name: string, color: string) =>
  new RepositoryLabel({
    name: RepositoryLabelName.make(name),
    color: RepositoryLabelColor.make(color),
    description: Option.none(),
  });
const comment = (at: string, id: number) =>
  new Commented({
    at: time(at),
    url: `https://github.com/basaltbytes/usine/issues/247#issuecomment-${id}`,
  });
const appChanges: ReadonlyArray<ItemChange> = [
  // The operator's swap, before the first Attempt started.
  new LabelAdded({ at: time("2026-10-15T19:28:13Z"), label: label("ready-for-agent", "1f883d") }),
  // GitHub records seconds, so this is the second the first Attempt started.
  new LabelRemoved({ at: time("2026-10-15T19:30:39Z"), label: label("ready-for-agent", "1f883d") }),
  new LabelAdded({ at: time("2026-10-15T19:31:31Z"), label: label("agent-in-progress", "fbca04") }),
  comment("2026-10-15T19:55:08Z", 6201011438),
  new LabelRemoved({
    at: time("2026-10-15T19:55:11Z"),
    label: label("agent-in-progress", "fbca04"),
  }),
  // Between Attempts: no Attempt was at work.
  comment("2026-10-16T09:00:00Z", 1),
  new LabelAdded({ at: time("2026-10-16T09:46:55Z"), label: label("agent-in-progress", "fbca04") }),
  comment("2026-10-16T09:48:00Z", 6212798620),
  comment("2026-10-16T13:03:00Z", 2),
  // While the review Run's Attempt also worked the Item.
  comment("2026-10-16T13:05:08Z", 6216129425),
];

const testLayer = (current: Ref.Ref<RunSnapshot>, requests: Ref.Ref<ReadonlyArray<string>>) => {
  const reader = Layer.succeed(RunReader)({
    inspect: () => Ref.get(current),
    evidence: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    forItems: () =>
      Ref.get(current).pipe(
        Effect.map((saved) => [
          new RunSummary({
            itemKey,
            run: saved.run,
            step: saved.step,
            attempts: saved.attempts,
            resolvedFailureAttemptId: Option.none(),
            repository,
            task: saved.task,
            agent,
          }),
          reviewRun,
        ]),
      ),
    revision: () => Effect.die("unused"),
    transcript: (query) => Effect.succeed(query.attemptId === first.id ? [lastRow] : []),
    attemptsByWorker: () => Effect.die("unused"),
  });
  const history = Layer.succeed(GitHubItemHistory)({
    appChanges: (_repository, _item, since) =>
      Ref.update(requests, (sent) => [...sent, DateTime.formatIso(since)]).pipe(
        Effect.as(appChanges.filter(({ at }) => DateTime.isGreaterThanOrEqualTo(at, since))),
      ),
  });
  return RunGitHubChanges.layer.pipe(Layer.provide(Layer.merge(reader, history)));
};

const summary = (view: RunGitHubChangesView) =>
  view.attempts.map(({ changes }) =>
    changes.map((change) =>
      change._tag === "LabelAdded" || change._tag === "LabelRemoved"
        ? `${change.at} ${change._tag} ${change.label.name} #${change.label.color}`
        : `${change.at} ${change._tag} ${change.url.split("#")[1]}`,
    ),
  );

describe("RunGitHubChanges", () => {
  it.effect("places the App's changes in the one Attempt at work and caches settled Attempts", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(snapshot([first, second, third]));
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* TestClock.setTime(DateTime.toEpochMillis(time("2026-10-16T13:10:00Z")));
      yield* Effect.gen(function* () {
        const changes = yield* RunGitHubChanges;
        const read = yield* changes.read(runId);
        assert.deepStrictEqual(summary(read), [
          [
            "2026-10-15T19:30:39.000Z LabelRemoved ready-for-agent #1f883d",
            "2026-10-15T19:31:31.000Z LabelAdded agent-in-progress #fbca04",
            "2026-10-15T19:55:08.000Z Commented issuecomment-6201011438",
            "2026-10-15T19:55:11.000Z LabelRemoved agent-in-progress #fbca04",
          ],
          [
            "2026-10-16T09:46:55.000Z LabelAdded agent-in-progress #fbca04",
            "2026-10-16T09:48:00.000Z Commented issuecomment-6212798620",
          ],
          ["2026-10-16T13:03:00.000Z Commented issuecomment-2"],
        ]);
        assert.deepStrictEqual(yield* Ref.get(requests), ["2026-10-15T19:30:39.000Z"]);

        // Ended Attempts come from the cache; GitHub is asked only about the live one.
        assert.deepStrictEqual(summary(yield* changes.read(runId)), summary(read));
        assert.deepStrictEqual((yield* Ref.get(requests)).slice(1), ["2026-10-16T13:02:00.000Z"]);

        // A just-ended Attempt is asked about again until GitHub's record has settled.
        yield* Ref.set(
          current,
          snapshot([
            first,
            second,
            attempt(runId, 3, "2026-10-16T13:02:00.345Z", { endedAt: "2026-10-16T13:09:30Z" }),
          ]),
        );
        yield* changes.read(runId);
        yield* TestClock.adjust("1 minute");
        yield* changes.read(runId);
        yield* changes.read(runId);
        assert.strictEqual((yield* Ref.get(requests)).length, 4);
      }).pipe(Effect.provide(testLayer(current, requests)));
    }),
  );
});
