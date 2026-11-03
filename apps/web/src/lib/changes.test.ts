import { QueryClient } from "@tanstack/react-query";
import { GitHubItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import { TaskItemView, TaskView } from "@usine/orchestrator/operator";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { assert, expect, it } from "vitest";
import { fullTask, quietTask, taskRepository } from "~/lib/tasks/fixture";
import { taskHistoryQuery, taskQuery } from "~/lib/tasks/queries";
import { invalidateChanges } from "./changes";

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
