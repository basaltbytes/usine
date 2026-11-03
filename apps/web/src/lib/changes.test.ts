import { ConfigurationEntityId, ConfigurationEntityKey } from "@usine/config/configuration";
import { changes } from "~/lib/query-changes";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { GitHubItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { TaskItemView, TaskView } from "@usine/orchestrator/operator";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { assert, expect, it, vi } from "vitest";
import { fullTask, quietTask, taskRepository } from "~/lib/tasks/fixture";
import { taskHistoryQuery, taskQuery } from "~/lib/tasks/queries";
import { ProjectId } from "@usine/core/project";
import { RunId } from "@usine/core/run";
import { BoardLaneId } from "@usine/orchestrator/operator";
import {
  entityQuery,
  revisionsQuery,
  upgradeQuery,
  workersQuery,
} from "~/features/configuration/queries";
import { statisticsQuery, runStatisticsQuery } from "~/features/overview/queries";
import { laneItemsQuery, loadedLaneItemsQuery, projectQuery } from "~/features/projects/queries";
import { runGitHubChangesQuery } from "~/features/runs/queries";
import { projectTasksQuery, taskRunsQuery } from "~/features/tasks/queries";
import { agentsQuery, configurationQuery } from "~/lib/configuration/queries";
import { deskQuery } from "~/lib/desk/queries";
import { attentionQuery, overviewQuery, searchQuery } from "~/lib/overview";
import { sessionQuery } from "~/lib/permissions";
import { runDetailQuery } from "~/lib/runs/queries";
import { invalidateChanges } from "./changes";

it("uses each query's declared dependencies even when its cache key changes", async () => {
  const client = new QueryClient();
  const project = ProjectId.make("visible");
  const lane = BoardLaneId.make("done");
  const run = RunId.make("run");
  const task = fullTask();
  const queries = {
    board: projectQuery(project),
    lane: laneItemsQuery(project, lane),
    loadedLane: loadedLaneItemsQuery(project, lane),
    tasks: projectTasksQuery(project),
    detail: taskQuery(task.repository, task.number),
    history: taskHistoryQuery(task.repository, task.number),
    runs: taskRunsQuery(task),
    run: runDetailQuery(client, run),
    github: runGitHubChangesQuery({ id: run, attempts: [] }),
    configuration: configurationQuery(),
    agents: agentsQuery(),
    entity: entityQuery(
      new ConfigurationEntityKey({
        kind: "agent",
        identifier: ConfigurationEntityId.make("developer"),
      }),
    ),
    revisions: revisionsQuery(),
    upgrade: upgradeQuery(),
    workers: workersQuery(),
    navigation: overviewQuery(),
    search: searchQuery(),
    attention: attentionQuery(),
    activity: deskQuery(),
    statistics: statisticsQuery("7d"),
    runStatistics: runStatisticsQuery("30d"),
    session: sessionQuery(),
  };
  const entries = Object.entries(queries);
  const cases: ReadonlyArray<{
    readonly changes: ChangeNotice["changes"];
    readonly expected: ReadonlyArray<keyof typeof queries>;
  }> = [
    {
      changes: [{ kind: "project", id: project }],
      expected: ["board", "lane", "loadedLane", "tasks", "search"],
    },
    { changes: [{ kind: "project", id: "other" }], expected: ["search"] },
    {
      changes: [{ kind: "run", id: run }],
      expected: ["run", "github", "statistics", "runStatistics"],
    },
    { changes: [{ kind: "run", id: "other" }], expected: ["statistics", "runStatistics"] },
    { changes: [{ kind: "item", id: task.current }], expected: ["detail", "history", "runs"] },
    { changes: [{ kind: "item", id: "invalid" }], expected: [] },
    { changes: [{ kind: "attempt", id: "other" }], expected: [] },
    {
      changes: [{ kind: "worker", id: "worker" }],
      expected: ["configuration", "workers", "activity"],
    },
    {
      changes: [{ kind: "configuration", id: "instance" }],
      expected: [
        "board",
        "lane",
        "loadedLane",
        "tasks",
        "run",
        "configuration",
        "agents",
        "entity",
        "revisions",
        "upgrade",
        "workers",
        "navigation",
        "search",
      ],
    },
    { changes: [{ kind: "navigation", id: "instance" }], expected: ["navigation", "search"] },
    { changes: [{ kind: "attention", id: "instance" }], expected: ["attention"] },
    {
      changes: [{ kind: "activity", id: "instance" }],
      expected: ["activity", "statistics", "runStatistics"],
    },
  ];
  try {
    for (const { changes: targets, expected } of cases) {
      for (const [name, { meta }] of entries)
        await client.fetchQuery({
          queryKey: ["renamed", name],
          meta: meta ?? {},
          queryFn: async () => 1,
        });
      await invalidateChanges(
        client,
        new ChangeNotice({ revision: 1, reset: false, changes: targets }),
      );
      const invalidated = entries.flatMap(([name]) =>
        client.getQueryState(["renamed", name])?.isInvalidated ? [name] : [],
      );
      expect(invalidated.sort()).toEqual([...expected].sort());
    }
    await invalidateChanges(client, new ChangeNotice({ revision: 2, reset: true, changes: [] }));
    for (const [name] of entries)
      expect(client.getQueryState(["renamed", name])?.isInvalidated).toBe(true);
  } finally {
    client.clear();
  }
});

it("retains a pending refresh when the ongoing read fails", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reads = 0;
  const queryKey = ["project", "one"];
  const observer = new QueryObserver(client, {
    queryKey,
    initialData: 0,
    staleTime: Infinity,
    meta: { refreshLabel: "Board", changes: changes.kind("project") },
    queryFn: async () => {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (reads === 1) throw new Error("Read failed");
      return reads;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const notice = new ChangeNotice({
    revision: 1,
    reset: false,
    changes: [{ kind: "project", id: "one" }],
  });
  try {
    const first = invalidateChanges(client, notice);
    const pending = invalidateChanges(client, notice);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, pending]);
    expect(client.getQueryData(queryKey)).toBe(2);
    expect(reads).toBe(2);
  } finally {
    unsubscribe();
    client.clear();
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "keeps reads updating during sustained notices and refreshes after the final change (reset: %s)",
  async (reset) => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let current = 1;
    let reads = 0;
    const queryKey = ["project", "one"];
    const observer = new QueryObserver(client, {
      queryKey,
      initialData: 0,
      staleTime: Infinity,
      meta: { refreshLabel: "Board", changes: changes.kind("project") },
      queryFn: async () => {
        reads++;
        const snapshot = current;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return snapshot;
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    const refresh = () =>
      invalidateChanges(
        client,
        new ChangeNotice({
          revision: current,
          reset,
          changes: [{ kind: "project", id: "one" }],
        }),
      );
    try {
      const pending = [refresh()];
      let previous = 0;
      for (let tick = 1; tick <= 15; tick++) {
        await vi.advanceTimersByTimeAsync(200);
        current++;
        pending.push(refresh());
        if (tick % 3 === 0) {
          const displayed = client.getQueryData<number>(queryKey) ?? 0;
          expect(displayed).toBeGreaterThan(previous);
          previous = displayed;
        }
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(pending);
      expect(client.getQueryData(queryKey)).toBe(current);
      expect(reads).toBe(8);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reads).toBe(8);
    } finally {
      unsubscribe();
      client.clear();
      vi.useRealTimers();
    }
  },
);

it("refreshes task reads in the changed item's repository without refreshing other repositories", async () => {
  const client = new QueryClient();
  const task = fullTask();
  const unrelated = quietTask();
  const details = taskQuery(RepositoryName.make("BasaltBytes/Usine"), task.number);
  const history = taskHistoryQuery(task.repository, task.number);
  const other = taskQuery(unrelated.repository, unrelated.number);
  const pending = taskQuery(taskRepository, ItemNumber.make(999));
  const foreignRepository = RepositoryName.make("another/repository");
  const foreignItem = new TaskItemView({
    ...unrelated.items[0],
    itemKey: Schema.encodeSync(GitHubItemKey)(["github", foreignRepository, unrelated.number]),
    url: `https://github.com/${foreignRepository}/issues/${unrelated.number}`,
  });
  const foreignTask = new TaskView({
    ...unrelated,
    repository: foreignRepository,
    current: foreignItem.itemKey,
    items: [foreignItem],
  });
  const foreign = taskQuery(foreignTask.repository, foreignTask.number);
  try {
    for (const item of task.items) {
      await client.fetchQuery({ ...details, queryFn: async () => task });
      await client.fetchQuery({ ...history, queryFn: async () => task });
      await client.fetchQuery({ ...other, queryFn: async () => unrelated });
      await client.fetchQuery({ ...pending, queryFn: async () => unrelated });
      await client.fetchQuery({ ...foreign, queryFn: async () => foreignTask });
      await invalidateChanges(
        client,
        new ChangeNotice({
          revision: 1,
          reset: false,
          changes: [{ kind: "item", id: item.itemKey }],
        }),
      );
      expect(client.getQueryState(details.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(history.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(other.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(pending.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(foreign.queryKey)?.isInvalidated).toBe(false);
    }
  } finally {
    client.clear();
  }
});

it("refreshes a PR-only task and its history when an issue outside its cached membership links it", async () => {
  const client = new QueryClient();
  const combined = fullTask();
  const pullRequest = combined.items.find(({ number }) => number === 42);
  const issue = combined.items.find(({ kind }) => kind === "issue");
  assert(pullRequest !== undefined);
  assert(issue !== undefined);
  const standalone = new TaskView({
    ...combined,
    number: pullRequest.number,
    title: pullRequest.title,
    items: [pullRequest],
    runs: combined.runs.filter(({ itemKey }) => itemKey === pullRequest.itemKey),
  });
  const details = taskQuery(standalone.repository, standalone.number);
  const history = taskHistoryQuery(standalone.repository, standalone.number);
  let linked = false;
  const queryFn = async () => (linked ? combined : standalone);
  try {
    await client.fetchQuery({ ...details, queryFn });
    await client.fetchQuery({ ...history, queryFn });
    linked = true;
    await invalidateChanges(
      client,
      new ChangeNotice({
        revision: 1,
        reset: false,
        changes: [{ kind: "item", id: issue.itemKey }],
      }),
    );
    expect(client.getQueryState(details.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(history.queryKey)?.isInvalidated).toBe(true);
    expect(await client.fetchQuery({ ...details, queryFn })).toEqual(combined);
    expect(await client.fetchQuery({ ...history, queryFn })).toEqual(combined);
  } finally {
    client.clear();
  }
});
