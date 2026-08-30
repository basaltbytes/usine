import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentFile,
  AgentName,
  IssueTrigger,
  LoadedInstance,
  LoopFile,
  LoopName,
  ModelId,
  Persona,
  PromptTemplate,
  Selector,
  UsineConfig,
} from "@usine/config";
import { Instance, Run, Step } from "@usine/core";
import { RunEngine, StepExecutor } from "@usine/engine";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer, Source } from "@usine/expression";
import {
  ChangedIssue,
  ContentHash,
  EntityTag,
  GitHubPolling,
  IssueSnapshot,
  PollCursor,
  RepositoryChanges,
  type IssuePayload,
} from "@usine/github";
import {
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { PollingTriggers } from "../src/index.ts";

const watchedRepository = "basaltbytes/usine";

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    { name: watchedRepository, tags: ["active"] },
    { name: "basaltbytes/unwatched", tags: ["inactive"] },
  ],
  settings: { poll_interval: 60 },
});

const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  persona: Persona.make("Implement the issue."),
});

const issueLoop = (name: string) =>
  new LoopFile({
    name: LoopName.make(name),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(
        'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready")',
      ),
    }),
    selector: Option.some(
      new Selector({
        repos: Option.some([config.repos[0]?.name ?? assert.fail("missing watched repo")]),
        tags: Option.none(),
      }),
    ),
    approval: "required",
    step: Step.StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make("Implement issue {{ item.number }}."),
  });

const instanceWith = (loops: ReadonlyArray<LoopFile>) =>
  new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
  });

const issuePayload = (labels: ReadonlyArray<string>): IssuePayload => ({
  number: 28,
  title: "Polling triggers",
  body: "Build the trigger path.",
  url: "https://github.com/basaltbytes/usine/issues/28",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-08-30T10:00:00Z",
  updatedAt: "2026-08-30T20:00:00Z",
  closedAt: null,
  author: { login: "PhilDL" },
  issueType: null,
  milestone: null,
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
  assignees: { totalCount: 0, nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
});

interface RemoteState {
  readonly hash: ContentHash;
  readonly payload: IssuePayload;
}

const waitForState = Effect.fn("test.waitForState")(function* (
  engine: RunEngine["Service"],
  runId: Run.RunId,
  tag: "Canceled" | "Waiting",
) {
  for (let poll = 0; poll < 500; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (snapshot.run.state._tag === tag) return snapshot;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(`Run ${runId} did not reach ${tag}`);
});

const claimedRun = (cycle: Effect.Success<ReturnType<PollingTriggers["Service"]["poll"]>>) => {
  const submission = cycle.submissions[0];
  assert(submission !== undefined && submission._tag === "Claimed");
  return submission.runId;
};

const runtimeLayer = (directory: Instance.Directory, github: GitHubPolling["Service"]) => {
  const executor = Layer.succeed(StepExecutor)({
    execute: () => Effect.die("an approval-gated test run must not start an Attempt"),
  });
  const engine = localEngineLayer(directory).pipe(Layer.provide(executor));
  const dependencies = Layer.mergeAll(
    engine,
    MarcbachmannCelLayer,
    Layer.succeed(GitHubPolling, github),
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

describe("PollingTriggers", () => {
  it.live(
    "deduplicates snapshots across restart and emits new Events only for new matching content",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = Instance.Directory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-polling-" }),
        );
        const state = yield* Ref.make<RemoteState>({
          hash: ContentHash.make("a".repeat(64)),
          payload: issuePayload(["ready"]),
        });
        const seenCursors = yield* Ref.make<ReadonlyArray<PollCursor>>([]);
        const seenRepositories = yield* Ref.make<ReadonlyArray<string>>([]);
        const snapshotCalls = yield* Ref.make(0);
        const changed = new ChangedIssue({
          number: 28,
          updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
        });
        const github: GitHubPolling["Service"] = {
          changes: (repository, cursor) =>
            Effect.gen(function* () {
              yield* Ref.update(seenCursors, (values) => [...values, cursor]);
              yield* Ref.update(seenRepositories, (values) => [...values, repository]);
              return new RepositoryChanges({
                cursor: new PollCursor({
                  entityTag: Option.some(EntityTag.make('W/"live"')),
                  watermark: Option.some(changed.updatedAt),
                }),
                items: [changed],
                nextPollAt: Option.none(),
              });
            }),
          snapshot: () =>
            Effect.gen(function* () {
              yield* Ref.update(snapshotCalls, (count) => count + 1);
              const current = yield* Ref.get(state);
              return new IssueSnapshot({
                payload: current.payload,
                contentHash: current.hash,
              });
            }),
        };

        const firstInstance = instanceWith([issueLoop("start-dev")]);
        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(
          Layer.build(runtimeLayer(directory, github)),
          firstScope,
        );
        const firstPolling = Context.get(firstContext, PollingTriggers);
        const firstEngine = Context.get(firstContext, RunEngine);

        const coldStart = yield* firstPolling.poll(firstInstance);
        assert.strictEqual(coldStart.repositories, 1);
        assert.strictEqual(coldStart.changedItems, 1);
        const originalRun = claimedRun(coldStart);
        yield* waitForState(firstEngine, originalRun, "Waiting");

        const duplicate = yield* firstPolling.poll(firstInstance);
        assert.strictEqual(claimedRun(duplicate), originalRun);
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(
          Layer.build(runtimeLayer(directory, github)),
          secondScope,
        );
        const secondPolling = Context.get(secondContext, PollingTriggers);
        const secondEngine = Context.get(secondContext, RunEngine);

        const afterRestart = yield* secondPolling.poll(firstInstance);
        assert.strictEqual(claimedRun(afterRestart), originalRun);
        const restoredCursors = yield* Ref.get(seenCursors);
        const restartCursor = restoredCursors[2];
        assert(restartCursor !== undefined && Option.isSome(restartCursor.entityTag));

        const expandedInstance = instanceWith([issueLoop("start-dev"), issueLoop("triage-ready")]);
        const newLoopColdStart = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(newLoopColdStart.submissions.length, 2);
        assert.strictEqual(claimedRun(newLoopColdStart), originalRun);
        const newLoopRun = newLoopColdStart.submissions[1];
        assert(newLoopRun !== undefined && newLoopRun._tag === "Claimed");
        yield* waitForState(secondEngine, newLoopRun.runId, "Waiting");
        const resetCursor = (yield* Ref.get(seenCursors))[3];
        assert(resetCursor !== undefined && Option.isNone(resetCursor.entityTag));

        yield* Ref.set(state, {
          hash: ContentHash.make("b".repeat(64)),
          payload: issuePayload(["ready", "touched"]),
        });
        const labelFlip = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(labelFlip.submissions.length, 2);
        const flippedRun = claimedRun(labelFlip);
        assert.notStrictEqual(flippedRun, originalRun);
        const flippedSnapshot = yield* waitForState(secondEngine, flippedRun, "Waiting");
        assert.deepStrictEqual(flippedSnapshot.event.payload, issuePayload(["ready", "touched"]));

        yield* Ref.set(state, {
          hash: ContentHash.make("c".repeat(64)),
          payload: issuePayload(["done"]),
        });
        const unmatched = yield* secondPolling.poll(expandedInstance);
        assert.strictEqual(unmatched.submissions.length, 0);
        assert.strictEqual(unmatched.revocations, 2);
        const revoked = yield* waitForState(secondEngine, flippedRun, "Canceled");
        assert.strictEqual(revoked.run.state._tag, "Canceled");
        if (revoked.run.state._tag === "Canceled") {
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
        }

        assert.deepStrictEqual(
          yield* Ref.get(seenRepositories),
          Array.from({ length: 6 }, () => watchedRepository),
        );
        assert.strictEqual(yield* Ref.get(snapshotCalls), 6);
        yield* Scope.close(secondScope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
