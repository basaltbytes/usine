import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentFile,
  AgentName,
  ConfigFileError,
  ConfigParser,
  InstancePath,
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
import { Claimed, CursorKey, CursorStore, RunEngine, StepExecutor } from "@usine/engine";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { ExpressionEngine, MarcbachmannCelLayer, Source } from "@usine/expression";
import {
  ChangedIssue,
  ContentHash,
  EntityTag,
  GitHubApiError,
  GitHubPolling,
  IssueSnapshot,
  PollCursor,
  RepositoryNotModified,
  RepositoryChanges,
  type IssuePayload,
} from "@usine/github";
import {
  Context,
  Clock,
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
import { PollingTriggers } from "../src/index.ts";

const watchedRepository = "basaltbytes/usine";

const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  repos: [
    { name: watchedRepository, tags: ["active"] },
    { name: "basaltbytes/unwatched", tags: ["inactive"] },
  ],
  settings: { poll_interval: 60, parent_model: "anthropic/instance-parent" },
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

const issuePayload = (labels: ReadonlyArray<string>, number = 28): IssuePayload => ({
  number,
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
    interrupt: () => Effect.void,
    reserve: () => Effect.die("an approval-gated test run must not reserve a worker"),
    execute: () => Effect.die("an approval-gated test run must not start an Attempt"),
  });
  const engine = localEngineLayer(directory).pipe(Layer.provide(executor));
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    engine,
    MarcbachmannCelLayer,
    parser,
    Layer.succeed(GitHubPolling, github),
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

const schedulerLayer = (github: GitHubPolling["Service"]) => {
  const cursors = Layer.succeed(CursorStore)({
    read: () => Effect.succeed(Option.none()),
    write: () => Effect.void,
  });
  const expressions = Layer.succeed(ExpressionEngine)({
    checkBoolean: () => Effect.die("unused"),
    checkScalar: () => Effect.die("unused"),
    evaluateBoolean: () => Effect.die("unused"),
    evaluateScalar: () => Effect.die("unused"),
  });
  const runs = Layer.succeed(RunEngine)({
    approve: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    inspect: () => Effect.die("unused"),
    reconcile: () => Effect.die("unused"),
    retry: () => Effect.die("unused"),
    revoke: () => Effect.die("unused"),
    submit: () => Effect.die("unused"),
    transcript: () => Effect.die("unused"),
  });
  const parser = ConfigParser.layer.pipe(Layer.provide(expressions));
  const dependencies = Layer.mergeAll(
    cursors,
    expressions,
    parser,
    runs,
    Layer.succeed(GitHubPolling, github),
  );
  return PollingTriggers.layer.pipe(Layer.provide(dependencies));
};

describe("PollingTriggers", () => {
  it.effect("waits past poll_interval when GitHub recommends a longer delay", () => {
    let changeRequests = 0;
    const github: GitHubPolling["Service"] = {
      changes: (_repository, cursor) =>
        Effect.gen(function* () {
          changeRequests += 1;
          const now = yield* Clock.currentTimeMillis;
          return new RepositoryNotModified({
            cursor,
            nextPollAt: Option.some(DateTime.makeUnsafe(now + 120_000)),
          });
        }),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const fiber = yield* Effect.forkChild(polling.run(instanceWith([issueLoop("start-dev")])));
      yield* Effect.yieldNow;
      assert.strictEqual(changeRequests, 1);
      yield* TestClock.adjust("119 seconds");
      assert.strictEqual(changeRequests, 1);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(changeRequests, 2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(schedulerLayer(github)));
  });

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
                backlog: false,
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
        const firstCursors = Context.get(firstContext, CursorStore);

        yield* firstCursors.write(
          CursorKey.make(`github-poll:${watchedRepository}`),
          Schema.Struct({ obsolete: Schema.Boolean }),
          { obsolete: true },
        );

        const coldStart = yield* firstPolling.poll(firstInstance);
        assert.strictEqual(coldStart.repositories, 1);
        assert.strictEqual(coldStart.changedItems, 1);
        const originalRun = claimedRun(coldStart);
        const originalSnapshot = yield* waitForState(firstEngine, originalRun, "Waiting");
        assert.strictEqual(originalSnapshot.task, "Implement issue 28.");
        assert.strictEqual(originalSnapshot.agent.name, "developer");
        assert.strictEqual(originalSnapshot.agent.brain.harness, "codex");
        assert.strictEqual(originalSnapshot.agent.brain.model, "gpt-5.6-sol");
        assert.strictEqual(originalSnapshot.agent.brain.effort, "high");
        assert.strictEqual(originalSnapshot.agent.persona, "Implement the issue.");
        assert.deepStrictEqual(
          originalSnapshot.parentModel,
          Option.some(ModelId.make("anthropic/instance-parent")),
        );
        const initialCursor = (yield* Ref.get(seenCursors))[0];
        assert(initialCursor !== undefined && Option.isNone(initialCursor.entityTag));

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
        const restoredSnapshot = yield* secondEngine.inspect(originalRun);
        assert.strictEqual(restoredSnapshot.task, "Implement issue 28.");
        assert.strictEqual(restoredSnapshot.agent.name, "developer");
        assert.deepStrictEqual(
          restoredSnapshot.parentModel,
          Option.some(ModelId.make("anthropic/instance-parent")),
        );
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
        assert.strictEqual(unmatched.revokedRuns, 2);
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

  it.effect("isolates one repository's failure from its siblings", () => {
    const multiConfig = Schema.decodeUnknownSync(UsineConfig)({
      version: 1,
      repos: [{ name: "basaltbytes/failing" }, { name: "basaltbytes/healthy" }],
      settings: { poll_interval: 60 },
    });
    const loop = new LoopFile({
      name: LoopName.make("watch-open"),
      trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
      selector: Option.none(),
      approval: "required",
      step: Step.StepName.make("run"),
      agent: agent.name,
      body: PromptTemplate.make("Implement issue {{ item.number }}."),
    });
    const instance = new LoadedInstance({
      config: multiConfig,
      agents: [agent],
      invalidAgents: [],
      loops: [loop],
      quarantinedLoops: [],
    });
    const changed = new ChangedIssue({
      number: 7,
      updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
    });
    const github: GitHubPolling["Service"] = {
      changes: (repository, cursor) =>
        repository === "basaltbytes/failing"
          ? Effect.fail(
              new GitHubApiError({
                operation: "poll-repository-changes",
                status: Option.some(500),
                message: "GitHub rejected the request with status 500",
              }),
            )
          : Effect.succeed(
              new RepositoryChanges({
                cursor,
                items: [changed],
                backlog: false,
                nextPollAt: Option.none(),
              }),
            ),
      snapshot: () =>
        Effect.succeed(
          new IssueSnapshot({
            payload: issuePayload([], 7),
            contentHash: ContentHash.make("d".repeat(64)),
          }),
        ),
    };
    const cursors = Layer.succeed(CursorStore)({
      read: () => Effect.succeed(Option.none()),
      write: () => Effect.void,
    });
    const runs = Layer.succeed(RunEngine)({
      approve: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      reconcile: () => Effect.die("unused"),
      retry: () => Effect.die("unused"),
      revoke: () => Effect.succeed([]),
      submit: (submission) =>
        Effect.succeed(
          new Claimed({
            eventId: submission.event.id,
            runId: Run.RunId.make(`run-${submission.event.id}`),
          }),
        ),
      transcript: () => Effect.die("unused"),
    });
    const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
    const layer = PollingTriggers.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          cursors,
          runs,
          MarcbachmannCelLayer,
          parser,
          Layer.succeed(GitHubPolling, github),
        ),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      // One repository's typed failure never stops its siblings: the cycle
      // reports the failure and the healthy repository still submits.
      const cycle = yield* polling.poll(instance);
      assert.strictEqual(cycle.repositories, 2);
      assert.strictEqual(cycle.failures.length, 1);
      assert.strictEqual(cycle.failures[0]?.repository, "basaltbytes/failing");
      assert.strictEqual(cycle.failures[0]?.errorTag, "GitHubApiError");
      assert.strictEqual(cycle.submissions.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("isolates one loop's prompt rendering failure and still advances the cursor", () => {
    // A render failure is deterministic loop authoring: re-polling the same
    // snapshot re-fails identically, so it must not wedge the repository.
    const broken = issueLoop("broken-prompt");
    const healthy = issueLoop("healthy-prompt");
    const cursorWrites: Array<CursorKey> = [];
    const cursors = Layer.succeed(CursorStore)({
      read: () => Effect.succeed(Option.none()),
      write: (key) =>
        Effect.sync(() => {
          cursorWrites.push(key);
        }),
    });
    const runs = Layer.succeed(RunEngine)({
      approve: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      inspect: () => Effect.die("unused"),
      reconcile: () => Effect.die("unused"),
      retry: () => Effect.die("unused"),
      revoke: () => Effect.succeed([]),
      submit: (submission) =>
        Effect.succeed(
          new Claimed({
            eventId: submission.event.id,
            runId: Run.RunId.make(`run-${submission.loop}`),
          }),
        ),
      transcript: () => Effect.die("unused"),
    });
    const parser = Layer.succeed(ConfigParser)({
      parseAgentFile: () => Effect.die("unused"),
      parseLoopFile: () => Effect.die("unused"),
      parseUsineYaml: () => Effect.die("unused"),
      renderPrompt: (loop) =>
        loop.name === broken.name
          ? Effect.fail(
              new ConfigFileError({
                file: InstancePath.make(`loops/${loop.name}.md`),
                stage: "expression",
                expression: Option.some(Source.make("item.missing")),
                message: "No such key: missing",
              }),
            )
          : Effect.succeed(`Rendered ${loop.name}.`),
    });
    const github: GitHubPolling["Service"] = {
      changes: (_repository, cursor) =>
        Effect.succeed(
          new RepositoryChanges({
            cursor,
            items: [
              new ChangedIssue({
                number: 28,
                updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z"),
              }),
            ],
            backlog: false,
            nextPollAt: Option.none(),
          }),
        ),
      snapshot: () =>
        Effect.succeed(
          new IssueSnapshot({
            payload: issuePayload(["ready"]),
            contentHash: ContentHash.make("c".repeat(64)),
          }),
        ),
    };
    const layer = PollingTriggers.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          cursors,
          runs,
          MarcbachmannCelLayer,
          parser,
          Layer.succeed(GitHubPolling, github),
        ),
      ),
    );

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instanceWith([broken, healthy]));
      assert.strictEqual(cycle.failures.length, 1);
      assert.strictEqual(cycle.failures[0]?.repository, watchedRepository);
      assert.strictEqual(cycle.failures[0]?.errorTag, "ConfigFileError");
      assert.strictEqual(cycle.submissions.length, 1);
      assert.strictEqual(cycle.submissions[0]?._tag, "Claimed");
      assert.strictEqual(cursorWrites.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("submits items from concurrent repositories through one engine", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = Instance.Directory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-polling-multi-" }),
      );
      const multiConfig = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: "basaltbytes/one" }, { name: "basaltbytes/two" }],
        settings: { poll_interval: 60 },
      });
      const loop = new LoopFile({
        name: LoopName.make("watch-open"),
        trigger: new IssueTrigger({ on: "issue", if: Source.make('item.state == "OPEN"') }),
        selector: Option.none(),
        approval: "required",
        step: Step.StepName.make("run"),
        agent: agent.name,
        body: PromptTemplate.make("Implement issue {{ item.number }}."),
      });
      const instance = new LoadedInstance({
        config: multiConfig,
        agents: [agent],
        invalidAgents: [],
        loops: [loop],
        quarantinedLoops: [],
      });
      const changedItems = [11, 12].map(
        (number) =>
          new ChangedIssue({ number, updatedAt: DateTime.makeUnsafe("2026-08-30T20:00:00Z") }),
      );
      const hashFor = (repository: string, number: number) =>
        ContentHash.make(
          `${(repository.endsWith("one") ? "a" : "b").repeat(32)}${String(number).repeat(16)}`,
        );
      const github: GitHubPolling["Service"] = {
        changes: (_repository, cursor) =>
          Effect.succeed(
            new RepositoryChanges({
              cursor,
              items: changedItems,
              backlog: false,
              nextPollAt: Option.none(),
            }),
          ),
        snapshot: (repository, item) =>
          Effect.succeed(
            new IssueSnapshot({
              payload: issuePayload([], item.number),
              contentHash: hashFor(repository, item.number),
            }),
          ),
      };

      // Four concurrent submissions across two repositories all land on one
      // SQLite engine: distinct runs, no lost or interleaved writes.
      yield* Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        const engine = yield* RunEngine;
        const cycle = yield* polling.poll(instance);
        assert.strictEqual(cycle.repositories, 2);
        assert.strictEqual(cycle.changedItems, 4);
        assert.strictEqual(cycle.failures.length, 0);
        assert.strictEqual(cycle.submissions.length, 4);
        const runIds = cycle.submissions.flatMap((submission) =>
          submission._tag === "Claimed" ? [submission.runId] : [],
        );
        assert.strictEqual(new Set(runIds).size, 4);
        for (const runId of runIds) {
          yield* waitForState(engine, runId, "Waiting");
        }
      }).pipe(Effect.provide(runtimeLayer(directory, github)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
