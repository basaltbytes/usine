import { QueryClient, QueryClientProvider, queryOptions, useQuery } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { connectChanges, connectionQuery } from "./changes";

class Source extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = () => {};
  open = () => this.onopen?.(new Event("open"));
  fail = () => this.onerror?.(new Event("error"));
  change = (id: string) =>
    this.dispatchEvent(
      new MessageEvent("change", {
        data: JSON.stringify({ revision: 1, reset: false, changes: [{ kind: "project", id }] }),
      }),
    );
}
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let source: Source;
let disconnect: () => void;
const reads = new Map<string, number>();
const board = (id: string) =>
  queryOptions({
    queryKey: ["project", id],
    queryFn: async () => {
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      return count;
    },
    staleTime: Infinity,
    meta: { refreshLabel: "Board" },
  });
const Boards = () => {
  const one = useQuery(board("one"));
  const two = useQuery(board("two"));
  const connection = useQuery(connectionQuery());
  return (
    <p>
      {one.data}:{two.data}:{connection.data}
    </p>
  );
};
beforeEach(() => {
  reads.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  source = new Source();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Boards />
      </QueryClientProvider>,
    ),
  );
  disconnect = connectChanges(client, () => source);
});
afterEach(() => {
  disconnect();
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
});
it("updates only the named board from a server notice", async () => {
  source.open();
  await expect.element(page.getByText("1:1:connected", { exact: true })).toBeVisible();
  source.change("one");
  await expect.element(page.getByText("2:1:connected", { exact: true })).toBeVisible();
});
it("keeps a connected board idle for five minutes and polls every minute only while disconnected", async () => {
  await expect.poll(() => reads.get("one")).toBe(1);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  source.open();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reads.get("one")).toBe(1);
  source.fail();
  await expect.element(page.getByText("1:1:disconnected", { exact: true })).toBeVisible();
  await vi.advanceTimersByTimeAsync(30_000);
  source.fail();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(reads.get("one")).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect.poll(() => reads.get("one")).toBe(2);
  source.open();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(reads.get("one")).toBe(2);
});
