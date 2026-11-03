import { QueryClient } from "@tanstack/react-query";
import { ItemNumber } from "@usine/core/item";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { expect, it } from "vitest";
import { fullTask, quietTask, taskRepository } from "~/lib/tasks/fixture";
import { taskHistoryQuery, taskQuery } from "~/lib/tasks/queries";
import { invalidateChanges } from "./changes";

it("refreshes task details and history for every linked item without refreshing unrelated tasks", async () => {
  const client = new QueryClient();
  const task = fullTask();
  const unrelated = quietTask();
  const details = taskQuery(task.repository, task.number);
  const history = taskHistoryQuery(task.repository, task.number);
  const other = taskQuery(unrelated.repository, unrelated.number);
  const pending = taskQuery(taskRepository, ItemNumber.make(999));
  try {
    for (const item of task.items) {
      await client.fetchQuery({ ...details, queryFn: async () => task });
      await client.fetchQuery({ ...history, queryFn: async () => task });
      await client.fetchQuery({ ...other, queryFn: async () => unrelated });
      await client.fetchQuery({ ...pending, queryFn: async () => unrelated });
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
      expect(client.getQueryState(other.queryKey)?.isInvalidated).toBe(false);
      expect(client.getQueryState(pending.queryKey)?.isInvalidated).toBe(false);
    }
  } finally {
    client.clear();
  }
});
