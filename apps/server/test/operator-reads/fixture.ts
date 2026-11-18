import { jsonKey } from "@usine/core/json-key";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { ConfigurationStore } from "@usine/config/configuration";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { IssueTrigger } from "@usine/config/trigger";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import {
  AgentSessionId,
  ParentSession,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { ChangedFile, FileChanges } from "@usine/github/file-changes";
import { GitHubFiles } from "@usine/github/files";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { RunEngine, Submission } from "@usine/engine/engine";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
  ItemProjectionWriter,
} from "@usine/engine/item-projection";
import { layer as engineLayer } from "@usine/engine/local-sqlite";
import { StepExecutor } from "@usine/engine/step-executor";
import { savedSettings, TriggerCondition, TriggerRecheck } from "@usine/engine/trigger-condition";
import { CompletionCheck } from "@usine/engine/completion-check";
import { Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { idleTriggersLayer } from "@usine/orchestrator/idle-triggers";
import {
  BoardTaskView,
  ConfigurationSummaryView,
  DeskView,
  FactoryOverview,
  ItemView,
  RunBriefView,
  RunTextPageView,
  RunTranscriptCursor,
  RunTranscriptPageView,
  Operator,
  OperatorConfiguration,
  OperatorObservation,
  PAGE_BYTES,
  RunDetailView,
  RunSummaryView,
  TaskView,
} from "@usine/orchestrator/operator";
import { ProjectId } from "@usine/core/project";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { WorkerStatus } from "@usine/orchestrator/worker-status";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { assert } from "vitest";
import { liveBackendLayer } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { type OperatorCall, OperatorUnavailableError } from "../../src/mcp/server.ts";
import { loadOperatorTools, MAX_RESULT_BYTES, PublishedApi } from "../../src/mcp/tools.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { operatorToolkit } from "../../src/supervisor/toolkit.ts";

// The dogfood instance has five Loops and about 500 Items on its Board; the overview and the desk
// each evaluate every Loop's trigger on every Item, and the web UI polls both at once.
const BOARD_ITEMS = 500;
const SIZE_ITEMS = 301;
// One task has many runs, as a task that a review loop picks up again and again.
const BUSY_ITEM = 2;
const BUSY_RUNS = 40;
const SIZE_RUNS = 800 - 3 + BUSY_RUNS;
// The running Attempt's transcript: three entries per step, and one tool output of about 60 KB.
const TRANSCRIPT_STEPS = 60;
const LONG_OUTPUT_STEP = 50;
const longOutput =
  "FAIL test/retry.test.ts > retries once and gives up on the second error\n".repeat(900);
// A pull request whose lockfile patch alone is larger than one page of files.
const PULL_REQUEST_FILES = 120;
const lockfilePatch = `@@ -1,1 +1,3000 @@\n${"+  resolution: {integrity: sha512-abcdef}\n".repeat(3_000)}`;
const SIZE_BUDGET_BYTES = 500_000;
const longBody = "Dependency release notes and migration instructions. ".repeat(500);
const longTask = `Implement the issue.\n${longBody.repeat(4)}`;
const LABELS = [
  "ready-for-agent",
  "agent-in-progress",
  "ready-for-review",
  "agent-review-findings",
  "review-passed",
];
// CI-calibrated read latency while an attempt starts (#464).
const READS = 3;

const repository = RepositoryName.make("basaltbytes/usine");
const project = ProjectId.make("usine");
// Polling keeps the latest 20 comments, so a long thread stores 20 of 35.
const COMMENTS = 20;
const commentBody = (comment: number) =>
  `Review notes for round ${comment}. ${"The reviewer asks for a test of the retry path. ".repeat(10 + comment * 6)}`;
const itemKey = (number: number) =>
  // The key contains already validated repository and item identifiers.
  // @effect-diagnostics-next-line schemaSync:off
  Schema.encodeSync(GitHubItemKey)(["github", repository, ItemNumber.make(number)]);
const brain = BrainSpec.make({
  harness: Harness.make("codex"),
  model: ModelId.make("gpt-6-astra"),
  effort: "medium",
});
const developer = AgentFile.make({
  name: AgentName.make("developer"),
  harness: brain.harness,
  model: brain.model,
  effort: brain.effort,
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the issue."),
});
// Loop prompts make the full configuration larger than one tool result.
const loopInstructions =
  "Read the issue, change the code, run the tests, and open a pull request. ".repeat(80);
const firstLoop = LoopName.make("usine/loop-0");
const loops = LABELS.map((label, index) =>
  LoopFile.make({
    name: LoopName.make(`usine/loop-${index}`),
    trigger: IssueTrigger.make({
      on: "issue",
      if: Source.make(
        `item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "${label}") && !item.labels.nodes.exists(label, label.name == "blocked")`,
      ),
    }),
    selector: Option.none(),
    approval: "none",
    step: StepName.make("run"),
    agent: developer.name,
    body: PromptTemplate.make(`Work on it.\n${loopInstructions}`),
  }),
);
const instance = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(UsineConfig)({
    version: 2,
    repos: [{ name: repository }],
    projects: [
      {
        id: project,
        name: "usine",
        repositories: [repository],
        lanes: [
          ...LABELS.map((label) => ({ name: label, sources: [{ label }] })),
          { name: "Done", sources: [{ state: "issue-closed" }] },
        ],
      },
    ],
    workers: [{ name: "worker", kind: "local", max_concurrent_attempts: 2 }],
  });
  return LoadedInstance.make({
    config: decodedValue1,
    agents: [developer],
    invalidAgents: [],
    loops,
    quarantinedLoops: [],
    warnings: [],
  });
});

// One Item in ten has a Loop's label, as on a Board where most work is done.
const labelOf = (number: number) =>
  number % 10 === 0 ? (LABELS[(number / 10) % LABELS.length] ?? "bug") : "bug";

const comments = (number: number) => ({
  totalCount: 2,
  nodes: [1, 2].map((comment) => ({
    author: { login: "usine-agent[bot]" },
    body: longBody,
    createdAt: "2026-10-19T11:00:00Z",
    url: `https://github.com/basaltbytes/usine/issues/${number}#issuecomment-${comment}`,
  })),
});

const thread = (number: number) => ({
  totalCount: 35,
  nodes: Array.from({ length: COMMENTS }, (_, comment) => ({
    author: { login: comment % 2 === 0 ? "usine-agent[bot]" : "PhilDL" },
    body: commentBody(comment),
    createdAt: `2026-10-19T11:${String(comment).padStart(2, "0")}:00Z`,
    url: `https://github.com/basaltbytes/usine/issues/${number}#issuecomment-${comment}`,
  })),
});

const issue = (number: number) =>
  ItemProjection.make({
    itemKey: itemKey(number),
    repository,
    source: ItemProjectionSource.make("issue"),
    number: ItemNumber.make(number),
    contentHash: ItemContentHash.make(`issue-${number}`),
    payload: {
      number,
      title: `Issue ${number}`,
      body: longBody,
      url: `https://github.com/basaltbytes/usine/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-10-19T10:00:00Z",
      updatedAt: "2026-10-19T12:00:00Z",
      closedAt: null,
      author: { login: "PhilDL" },
      issueType: null,
      milestone: null,
      labels: { totalCount: 1, nodes: [{ name: labelOf(number) }] },
      assignees: { totalCount: 0, nodes: [] },
      comments: number === BUSY_ITEM ? thread(number) : comments(number),
      closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
    },
    goneAt: Option.none(),
  });

const session = ParentSession.make({
  id: AgentSessionId.make("parent"),
  agent: developer.name,
  brain,
});

/** The outbound messages of the running Attempt's transcript, oldest first. */
const transcriptPayloads = (): ReadonlyArray<AttemptChannel.OutboundPayload> => [
  AttemptChannel.Started.make({ parentModel: Option.none() }),
  ...Array.from({ length: TRANSCRIPT_STEPS }, (_, step) => [
    AttemptChannel.SessionEvent.make({
      event: TextOutput.make({ session, text: `Step ${step}: run the retry tests again.` }),
    }),
    AttemptChannel.SessionEvent.make({
      event: ToolStarted.make({
        session,
        callId: `call-${step}`,
        tool: "bash",
        input: { command: "pnpm test retry" },
      }),
    }),
    AttemptChannel.SessionEvent.make({
      event: ToolFinished.make({
        session,
        callId: `call-${step}`,
        tool: "bash",
        output: step === LONG_OUTPUT_STEP ? longOutput : "ok",
        isError: step === LONG_OUTPUT_STEP,
      }),
    }),
  ]).flat(),
];

const pullRequestChanges = FileChanges.make({
  base: CommitSha.make("b".repeat(40)),
  head: CommitSha.make("a".repeat(40)),
  files: Array.from({ length: PULL_REQUEST_FILES }, (_, index) =>
    ChangedFile.make({
      path: index === 0 ? "pnpm-lock.yaml" : `src/retry/${index}.ts`,
      oldPath: null,
      status: "modified",
      additions: index === 0 ? 3_000 : 3,
      deletions: index === 0 ? 0 : 1,
      patch: {
        kind: "text",
        text:
          index === 0 ? lockfilePatch : "@@ -1,1 +1,3 @@\n-retry()\n+retry()\n+retry()\n+done()",
        truncated: false,
      },
      test: false,
      generated: index === 0,
    }),
  ),
  filesTruncated: false,
});

const started = (number: number) =>
  Submission.make({
    event: Event.make({
      id: EventId.make(`event-${number}`),
      dedupKey: DedupKey.make(`${firstLoop}/${number}`),
      payload: issue(number).payload,
      receivedAt: DateTime.makeUnsafe("2026-10-21T16:48:00Z"),
    }),
    itemKey: itemKey(number),
    loop: firstLoop,
    step: StepName.make("run"),
    approval: "none",
    repository,
    revision: RepositoryRevision.make("main"),
    task: AttemptTask.make(longTask),
    agent: Agent.make({
      name: developer.name,
      brain,
      parentModel: Option.none(),
      parentEffort: Option.none(),
      persona: developer.persona,
    }),
    parentModel: Option.none(),
  });

/** Runs `effect` and returns its value with the elapsed real-clock milliseconds. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = yield* Clock.currentTimeMillis;
    const valueDecoded1 = yield* effect;
    return { millis: (yield* Clock.currentTimeMillis) - before, value: valueDecoded1 } as const;
  });

const decodeOverview = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryOverview));
const decodeDesk = Schema.decodeUnknownEffect(Schema.fromJsonString(DeskView));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskView));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(ItemView));
const decodeLanePage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ items: Schema.Array(BoardTaskView), nextOffset: Schema.NullOr(Schema.Int) }),
  ),
);
const decodeRunsPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ runs: Schema.Array(RunSummaryView), nextOffset: Schema.NullOr(Schema.Int) }),
  ),
);
const decodeBrief = Schema.decodeUnknownEffect(Schema.fromJsonString(RunBriefView));
const decodeTranscriptPage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunTranscriptPageView),
);
const decodeTextPage = Schema.decodeUnknownEffect(Schema.fromJsonString(RunTextPageView));
const decodeConfigurationSummary = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ConfigurationSummaryView),
);
const decodeFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(FileChanges));
const encodeCursor = Schema.encodeEffect(RunTranscriptCursor);
const bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * Calls `name` through the supervisor's operator toolkit, as a harness does for the model, and
 * returns whether the call failed and the text that the model reads. Fails the test if the text is
 * larger than one tool result or usine cut it.
 */
const callTool = (toolkit: ReturnType<typeof operatorToolkit>, name: string, params: Schema.Json) =>
  Effect.gen(function* () {
    const built = yield* toolkit.toolkit;
    const last = yield* built
      .handle(name, params)
      .pipe(Stream.unwrap, Stream.runLast, Effect.result);
    const failed = Result.isFailure(last);
    const text = Result.isFailure(last)
      ? String(last.failure)
      : Option.match(last.success, {
          onNone: () => assert.fail(`${name} returned no result`),
          onSome: ({ result }) => String(result),
        });
    assert.isAtMost(bytes(text), MAX_RESULT_BYTES, `${name} ${jsonKey(params)}`);
    assert.notInclude(text, "usine cut this", name);
    return { failed, text };
  }).pipe(Effect.provide(toolkit.handlers));

/** The full representations that the tool results are measured against. */
interface FullReads {
  readonly overview: FactoryOverview;
  readonly overviewText: string;
  readonly taskText: string;
  readonly detailText: string;
  readonly configurationText: string;
}

/**
 * The read tools that this fixture doesn't call, with the reason. Every other read tool of the
 * supervisor's toolkit must be called below.
 */
const NOT_CALLED = new Map([
  ["githubChanges", "It reads the GitHub timeline of the run's item; this fixture has no GitHub."],
  ["configurationLabels", "It reads live GitHub labels; this fixture has no GitHub."],
  ["previewLoop", "It needs the configuration editor, which this fixture doesn't run."],
  ["configurationHead", "It needs the configuration editor; it returns one revision number."],
  [
    "configurationRevisions",
    "It needs the configuration editor; test/configuration-http bounds its pages to one result.",
  ],
  [
    "configurationRevision",
    "It needs the configuration editor; one revision's changes aren't paged, so a large import can be cut.",
  ],
  [
    "configurationEntity",
    "It needs the configuration editor; one entity's value and text aren't paged, so a long prompt can be cut.",
  ],
]);

/**
 * Calls every read tool of the supervisor's toolkit and reads the instance through them: the
 * overview, the project, every page of every lane, the busy task and its runs, an item's text, the
 * running run's brief, transcript, and texts, the configuration, and a large pull request. No
 * result passes one tool result or carries the cut note, and the pages together hold what the
 * full representations hold.
 */
const checkToolResults = Effect.fn("test.checkToolResults")(function* (
  full: FullReads,
  runId: RunId,
) {
  const client = yield* HttpClient.HttpClient;
  const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
  const tools = yield* loadOperatorTools(document);
  const call: OperatorCall = (request) =>
    client.get(request.url).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (text) => ({ status: response.status, text })),
      ),
      Effect.mapError((error) => OperatorUnavailableError.make({ message: error.message })),
    );
  const toolkit = operatorToolkit(tools, call);
  const called = new Set<string>();
  const read = (name: string, params: Schema.Json) =>
    callTool(toolkit, name, params).pipe(
      Effect.tap(() => Effect.sync(() => called.add(name))),
      Effect.map(({ text }) => text),
    );
  const succeeded = (name: string, params: Schema.Json) =>
    callTool(toolkit, name, params).pipe(
      Effect.tap(({ failed, text }) =>
        Effect.sync(() => {
          assert.isFalse(failed, `${name} failed: ${text}`);
          called.add(name);
        }),
      ),
      Effect.map(({ text }) => text),
    );
  const sizes: Record<string, number> = {};
  const largest = (key: string, text: string) => {
    sizes[key] = Math.max(sizes[key] ?? 0, bytes(text));
  };

  const overviewText = yield* succeeded("overview", {});
  const summary = yield* decodeOverview(overviewText);
  sizes.overviewFull = bytes(full.overviewText);
  sizes.overviewSummary = bytes(overviewText);
  const [fullProject] = full.overview.projects;
  assert(fullProject !== undefined);
  assert.isUndefined(summary.projects[0]?.runs);
  assert.deepStrictEqual(
    summary.projects[0]?.board.lanes.map(({ id, items, totalItems }) => [id, items, totalItems]),
    fullProject.board.lanes.map(({ id, items }) => [id, [], items.length]),
  );
  const projectText = yield* succeeded("project", { project });
  sizes.projectSummary = bytes(projectText);

  for (const lane of fullProject.board.lanes) {
    const cards: Array<BoardTaskView> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const text: string = yield* succeeded("boardLaneItems", { project, lane: lane.id, offset });
      largest("lanePageLargest", text);
      const page = yield* decodeLanePage(text);
      cards.push(...page.items);
      offset = page.nextOffset;
    }
    assert.deepStrictEqual(
      cards.map(({ itemKey }) => itemKey),
      lane.items.map(({ itemKey }) => itemKey),
      lane.id,
    );
    largest("laneFullLargest", jsonKey(lane.items));
  }

  const task = { owner: "basaltbytes", repository: "usine", item: BUSY_ITEM };
  sizes.taskFull = bytes(full.taskText);
  const taskText = yield* succeeded("task", task);
  sizes.taskSummary = bytes(taskText);
  const taskSummary = yield* decodeTask(taskText);
  assert.strictEqual(taskSummary.runsTotal, BUSY_RUNS);
  assert.isBelow(taskSummary.runs.length, BUSY_RUNS);
  assert.isUndefined(taskSummary.comments);
  yield* succeeded("projectTask", { project, item: BUSY_ITEM, repository });
  const runIds = taskSummary.runs.map(({ id }) => id);
  let runOffset: number | null = runIds.length;
  while (runOffset !== null) {
    const text: string = yield* succeeded("taskRuns", { ...task, offset: runOffset });
    largest("runsPageLargest", text);
    const page = yield* decodeRunsPage(text);
    runIds.push(...page.runs.map(({ id }) => id));
    runOffset = page.nextOffset;
  }
  assert.deepStrictEqual(
    runIds,
    (yield* decodeTask(full.taskText)).runs.map(({ id }) => id),
  );

  const texts: Array<string> = [];
  let cursor: { readonly entry: number; readonly offset: number } | null = {
    entry: 0,
    offset: 0,
  };
  let item: ItemView | undefined;
  while (cursor !== null) {
    const text: string = yield* succeeded("item", { ...task, ...cursor });
    largest("itemPageLargest", text);
    item = yield* decodeItem(text);
    for (const entry of item.entries) texts[entry.entry] = (texts[entry.entry] ?? "") + entry.text;
    cursor = item.next;
  }
  assert(item !== undefined);
  sizes.itemPayload = bytes(jsonKey(issue(BUSY_ITEM).payload));
  assert.strictEqual(item.entriesTotal, 1 + COMMENTS);
  assert.strictEqual(item.omitted, 35 - COMMENTS);
  assert.deepStrictEqual(texts, [
    longBody,
    ...Array.from({ length: COMMENTS }, (_, comment) => commentBody(comment)),
  ]);

  sizes.detailFull = bytes(full.detailText);
  const briefText = yield* succeeded("detail", { runId });
  sizes.detailBrief = bytes(briefText);
  const brief = yield* decodeBrief(briefText);
  assert.strictEqual(brief.run.id, runId);
  assert.strictEqual(brief.task.length, longTask.length);
  assert.isTrue(longTask.startsWith(brief.task.text));
  const [attempt] = brief.run.attempts;
  assert(attempt !== undefined);

  // A model reads the newest entries first, and follows `next` into older ones.
  const entries: Array<{ readonly sequence: number; readonly kind: string; text: string }> = [];
  let transcriptCursor: Schema.Json = { runId, attempt: attempt.id };
  let pages = 0;
  while (true) {
    const text: string = yield* succeeded("runTranscript", transcriptCursor);
    largest("transcriptPageLargest", text);
    pages += 1;
    const page = yield* decodeTranscriptPage(text);
    assert.strictEqual(page.attemptId, attempt.id);
    for (const entry of page.entries) {
      const previous = entries.at(-1);
      if (previous?.sequence === entry.sequence) previous.text += entry.text;
      else {
        assert.strictEqual(entry.offset, 0);
        entries.push({ sequence: entry.sequence, kind: entry.kind, text: entry.text });
      }
    }
    if (page.next === null) break;
    const next = yield* encodeCursor(page.next);
    transcriptCursor = { runId, ...next };
  }
  sizes.transcriptPages = pages;
  assert.strictEqual(entries.length, 1 + TRANSCRIPT_STEPS * 3);
  assert.deepStrictEqual(
    entries.map(({ sequence }) => sequence),
    entries.map(({ sequence }) => sequence).sort((left, right) => right - left),
  );
  assert.strictEqual(entries.at(-1)?.kind, "Started");
  assert.strictEqual(entries[0]?.kind, "ToolFinished");
  const longEntry = entries.find(({ text }) => text.includes("retries once"));
  assert(longEntry !== undefined);
  assert.include(longEntry.text, jsonKey(longOutput).slice(1, -1));

  for (const [part, whole] of [
    ["task", longTask],
    ["event", jsonKey(issue(1).payload)],
    ["result", ""],
    ["report", ""],
  ] as const) {
    let text = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const pageText: string = yield* succeeded("runText", { runId, part, offset });
      largest("runTextPageLargest", pageText);
      const page = yield* decodeTextPage(pageText);
      text += page.text;
      offset = page.nextOffset;
    }
    assert.strictEqual(text, whole, part);
  }

  sizes.configurationFull = bytes(full.configurationText);
  const configurationText = yield* succeeded("configuration", {});
  sizes.configurationSummary = bytes(configurationText);
  const configurationSummary = yield* decodeConfigurationSummary(configurationText);
  assert.deepStrictEqual(
    configurationSummary.loops.map(({ name }) => name),
    loops.map(({ name }) => name),
  );

  const selection = { project, repository, item: BUSY_ITEM, scope: "PullRequestFiles" };
  const paths: Array<string> = [];
  let fileOffset: number | null = 0;
  while (fileOffset !== null) {
    const text: string = yield* succeeded("pullRequestFiles", {
      ...selection,
      base: "b".repeat(40),
      head: "a".repeat(40),
      offset: fileOffset,
    });
    largest("filesPageLargest", text);
    const page = yield* decodeFiles(text);
    assert.strictEqual(page.total, PULL_REQUEST_FILES);
    paths.push(...page.files.map(({ path }) => path));
    fileOffset = page.nextOffset ?? null;
  }
  assert.lengthOf(paths, PULL_REQUEST_FILES);
  sizes.filesFull = bytes(jsonKey(pullRequestChanges.files));

  const deskText = yield* succeeded("desk", {});
  sizes.desk = bytes(deskText);
  const statisticsText = yield* succeeded("statistics", { window: "all" });
  sizes.statistics = bytes(statisticsText);
  const runStatisticsText = yield* succeeded("runStatistics", { window: "all" });
  sizes.runStatistics = bytes(runStatisticsText);
  yield* succeeded("agents", {});
  yield* succeeded("serverReady", {});
  yield* succeeded("configurationCapabilities", {});
  // Upgrades aren't part of this fixture, so the read fails with a short error.
  yield* read("serverVersion", {});

  const readTools = tools
    .filter(({ permission }) => permission === "read" || permission === "public")
    .map(({ name }) => name);
  assert.deepStrictEqual(
    readTools.filter((name) => !called.has(name) && !NOT_CALLED.has(name)),
    [],
    "Call every read tool, or list it in NOT_CALLED with the reason",
  );
  assert.deepStrictEqual(
    [...NOT_CALLED.keys()].filter((name) => called.has(name) || !readTools.includes(name)),
    [],
  );
  for (const [key, size] of Object.entries(sizes))
    if (key.endsWith("PageLargest")) assert.isAtMost(size, PAGE_BYTES, key);
  yield* Effect.logInfo("Tool result sizes", sizes);
  return sizes;
});

export const checkReads = ({
  initialItems,
  openRuns,
  history,
}: {
  readonly initialItems: number;
  readonly openRuns: number;
  readonly history: boolean;
}) =>
  Effect.gen(function* () {
    const fixtureInstance = yield* instance;
    const startedAt = yield* Clock.currentTimeMillis;
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(undefined, (history ? 512 : 64) * 1024 ** 2),
      prefix: "usine-read-latency-",
    });
    const preparing = yield* Deferred.make<void>();
    // A Worker whose preparation, such as an SSH preflight, lasts until the test ends.
    const slowWorker = Layer.succeed(StepExecutor)({
      workers: Effect.succeed([WorkerName.make("worker")]),
      isLive: () => Effect.succeed(false),
      outcome: () => Effect.succeedNone,
      recover: () => Effect.succeed("found" as const),
      intervene: () => Effect.void,
      interrupt: () => Effect.void,
      reserve: () =>
        Effect.succeed({ worker: WorkerName.make("worker"), kind: "local", release: Effect.void }),
      occupy: (worker) => Effect.succeed({ worker, kind: "local", release: Effect.void }),
      sweep: Effect.void,
      discard: () => Effect.void,
      execute: (execution, io) =>
        Effect.forEach(
          history ? transcriptPayloads() : [],
          (payload, index) =>
            io.append(
              "outbound",
              AttemptChannel.OutboundEnvelope.make({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: execution.attempt.id,
                sequence: AttemptChannel.Sequence.make(index + 1),
                sentAt: DateTime.makeUnsafe("2026-10-21T16:49:00Z"),
                payload,
              }),
            ),
          { discard: true },
        ).pipe(
          Effect.andThen(Deferred.succeed(preparing, undefined)),
          Effect.andThen(Effect.never),
        ),
    });
    const engine = engineLayer(InstanceDirectory.make(root)).pipe(
      Layer.provide(slowWorker),
      Layer.provide(
        Layer.succeed(TriggerCondition)({
          recheck: (submission) =>
            Effect.succeed(TriggerRecheck.Matches({ settings: savedSettings(submission) })),
        }),
      ),
      Layer.provide(CompletionCheck.unverified),
    );
    const observation = Layer.mergeAll(OperatorObservation.layer, OperatorConfiguration.layer).pipe(
      Layer.provide(Layer.mock(ConfigurationStore)({ list: () => Effect.succeed([]) })),
      Layer.provide(Layer.mergeAll(idleTriggersLayer, MarcbachmannCelLayer, WorkerStatus.idle)),
      Layer.provideMerge(engine),
    );
    const measurements = yield* Effect.gen(function* () {
      const items = yield* ItemProjectionWriter;
      const runs = yield* RunEngine;
      const reads = yield* OperatorObservation;
      // Serves the overview and desk from `OperatorObservation`.
      const operator = yield* Effect.provide(
        Operator,
        Layer.mock(Operator)({
          overview: reads.overview,
          desk: reads.desk,
          detail: reads.detail,
          brief: reads.brief,
          runText: reads.runText,
          transcriptPage: reads.transcriptPage,
          task: reads.task,
          item: reads.item,
          statistics: reads.statistics,
          runStatistics: reads.runStatistics,
        }),
      );
      const configuration = yield* OperatorConfiguration;
      const githubFiles = Layer.succeed(GitHubFiles)({
        read: () => Effect.succeed(pullRequestChanges),
      });
      const backend = liveBackendLayer(
        { get: Effect.succeed(fixtureInstance) },
        operator,
        configuration,
      );
      const server = HttpRouter.serve(
        apiRoutes.pipe(HttpRouter.provideRequest(Layer.merge(backend, githubFiles))),
        { disableLogger: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

      return yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        // Measured until the response body has arrived, as the web UI waits for it.
        const read = (path: string, view?: string) =>
          timed(
            client
              .get(path, { headers: view === undefined ? {} : { "x-usine-view": view } })
              .pipe(Effect.flatMap((response) => response.text)),
          );
        for (let number = 1; number <= initialItems; number += 1)
          yield* items.upsert(issue(number));
        yield* runs.submit(started(1));
        yield* Deferred.await(preparing);
        for (let number = 2; number <= openRuns; number += 1)
          yield* runs.submit(Submission.make({ ...started(number), approval: "required" }));
        for (let number = 2; history && number <= SIZE_ITEMS; number += 1) {
          const count = number === BUSY_ITEM ? BUSY_RUNS : number <= 200 ? 3 : 2;
          for (let round = 1; round <= count; round += 1) {
            const submission = started(number);
            // The busy Item's later rounds add Runs to page through, so their text is short.
            const later = round > 3;
            const result = yield* runs.submit(
              Submission.make({
                ...submission,
                task: later ? AttemptTask.make("Review the change again.") : submission.task,
                approval: "required",
                event: Event.make({
                  ...submission.event,
                  payload: later ? { number } : submission.event.payload,
                  id: EventId.make(`event-${number}-${round}`),
                  dedupKey: DedupKey.make(`${firstLoop}/${number}/${round}`),
                }),
              }),
            );
            assert.strictEqual(result._tag, "Claimed");
            if (result._tag === "Claimed") yield* runs.cancel(result.runId);
          }
          const item = issue(number);
          yield* items.upsert(
            ItemProjection.make({
              ...item,
              contentHash: ItemContentHash.make(`issue-${number}-closed`),
              payload: { ...item.payload, state: "CLOSED", closedAt: "2026-11-02T12:00:00Z" },
            }),
          );
        }

        const response = yield* read("/api/overview", "full");
        const overview = yield* decodeOverview(response.value);
        const bytes = (value: string) => new TextEncoder().encode(value).length;
        const responseBytes = bytes(response.value);
        const cards = overview.projects.flatMap(({ board }) =>
          board.lanes.flatMap(({ items }) => items),
        );
        assert.strictEqual(
          cards.filter(({ state }) => state === "issue-closed").length,
          history ? 300 : 0,
        );
        assert.strictEqual(
          cards.reduce((count, card) => count + card.runCount, 0),
          history ? SIZE_RUNS : openRuns,
        );
        assert.strictEqual(
          overview.projects.flatMap(({ board }) => board.lanes.flatMap(({ items }) => items))
            .length,
          initialItems,
        );

        // Reconstruct the previous wire shape to measure duplicated prompts by project and field.
        const withText = (run: RunSummaryView) => ({
          ...run,
          task: longTask,
          resultMessage: null,
          attempts: run.attempts.map((attempt) => ({ ...attempt, task: longTask })),
        });
        const previousProjects = overview.projects.map((project) => ({
          ...project,
          runs: (project.runs ?? []).map(withText),
          board: {
            ...project.board,
            lanes: project.board.lanes.map((lane) => ({
              ...lane,
              items: lane.items.map((task) => ({
                ...task,
                runs: [...task.runContext, ...(task.run === null ? [] : [task.run])].map(withText),
                run: task.run === null ? null : withText(task.run),
              })),
            })),
          },
        }));
        const previous = jsonKey({
          ...overview,
          projects: previousProjects,
        });
        const previousBytes = bytes(previous);
        const measurement = {
          items: initialItems,
          runs: history ? SIZE_RUNS : openRuns,
          previousBytes,
          responseBytes,
          projects: overview.projects.map((project, index) => ({
            repository: project.repository,
            before: Object.fromEntries(
              Object.entries(previousProjects[index] ?? {}).map(([key, value]) => [
                key,
                bytes(jsonKey(value)),
              ]),
            ),
            after: Object.fromEntries(
              Object.entries(project).map(([key, value]) => [key, bytes(jsonKey(value))]),
            ),
          })),
        };
        const sizeSummary = jsonKey(measurement);
        assert.isBelow(responseBytes, SIZE_BUDGET_BYTES, sizeSummary);
        assert.strictEqual(
          overview.projects.flatMap(({ runs }) => runs ?? []).length,
          history ? 51 : openRuns,
        );
        assert.isBelow(responseBytes, previousBytes * 0.1);
        yield* Effect.logInfo("Overview response size", measurement);
        const firstRun = overview.projects
          .flatMap(({ runs }) => runs ?? [])
          .find(({ state }) => state === "Running");
        assert(firstRun !== undefined);
        const detailResponse = yield* read(`/api/runs/${firstRun.id}`, "full");
        const detail = yield* Schema.decodeEffect(Schema.fromJsonString(RunDetailView))(
          detailResponse.value,
        );
        assert.strictEqual(detail.run.task, longTask);
        assert.strictEqual(detail.run.attempts[0]?.task, longTask);
        assert.deepStrictEqual(detail.eventPayload, issue(1).payload);
        const taskResponse = yield* read(`/api/projects/basaltbytes/usine/tasks/1`, "full");
        const task = yield* Schema.decodeEffect(Schema.fromJsonString(TaskView))(
          taskResponse.value,
        );
        assert.strictEqual(task.runs[0]?.id, firstRun.id);
        assert.deepStrictEqual(task.comments, []);
        if (history) {
          const busy = yield* read(`/api/projects/basaltbytes/usine/tasks/${BUSY_ITEM}`, "full");
          const configurationRead = yield* read("/api/configuration", "full");
          yield* checkToolResults(
            {
              overview,
              overviewText: response.value,
              taskText: busy.value,
              detailText: detailResponse.value,
              configurationText: configurationRead.value,
            },
            firstRun.id,
          );
          return [];
        }

        for (let number = initialItems + 1; number <= BOARD_ITEMS; number += 1)
          yield* items.upsert(issue(number));

        // Each round requests the overview and desk together, as the web UI does, while the
        // projection keeps changing. The fastest round measures the read cost independent of
        // machine load.
        const rounds = [];
        for (let round = 1; round <= READS; round += 1) {
          yield* items.upsert(
            ItemProjection.make({
              ...issue(1),
              contentHash: ItemContentHash.make(`issue-1-change-${round}`),
            }),
          );
          const [overview, desk] = yield* Effect.all(
            [read("/api/overview", "full"), read("/api/desk")],
            { concurrency: "unbounded" },
          );
          rounds.push({ overview, desk });
        }

        for (const { overview, desk } of rounds) {
          const decodedOverview = yield* decodeOverview(overview.value);
          const decodedDesk = yield* decodeDesk(desk.value);
          assert.strictEqual(decodedOverview._tag, "Ready");
          assert.deepStrictEqual(
            decodedDesk.running.map(({ item }) => item?.number),
            [ItemNumber.make(1)],
          );
        }
        const measurements = rounds.map(({ overview, desk }) => ({
          overview: overview.millis,
          desk: desk.millis,
        }));
        yield* Effect.logInfo("Operator read latency", { rounds: measurements });
        return measurements;
      }).pipe(Effect.provide(server));
    }).pipe(Effect.provide(observation));

    yield* Effect.logInfo("Operator latency fixture completed", {
      history,
      elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt,
    });
    return measurements;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
