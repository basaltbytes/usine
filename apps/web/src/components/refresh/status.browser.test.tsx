import { QueryClient, QueryClientProvider, queryOptions, useQuery } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { PageHeading } from "~/components/page";
import { RefreshProvider } from "./provider";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let failing = false;
const start = new Date("2026-10-29T12:00:00Z");
const primary = () =>
  queryOptions({
    queryKey: ["primary"],
    meta: { refreshLabel: "Activity" },
    queryFn: async () => {
      if (failing) throw new Error("Server unavailable");
      return "ready";
    },
    refetchInterval: 60_000,
  });
const secondary = () =>
  queryOptions({
    queryKey: ["secondary"],
    meta: { refreshLabel: "Statistics" },
    queryFn: async () => "ready",
    refetchInterval: 60_000,
  });
const PollingPage = () => {
  useQuery(primary());
  useQuery(secondary());
  return <PageHeading title="Overview" />;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  failing = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RefreshProvider>
          <PollingPage />
        </RefreshProvider>
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
});

it("keeps the last successful time, warns after a minute of failures despite healthy refreshes, and clears on recovery", async () => {
  const status = page.getByLabelText("Last updated", { exact: true });
  await expect
    .poll(() => status.element().querySelector("time")?.dateTime)
    .toBe(start.toISOString());
  vi.setSystemTime(new Date(start.getTime() + 10_000));
  failing = true;
  await client.refetchQueries(primary());
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  vi.setSystemTime(new Date(start.getTime() + 69_000));
  await client.refetchQueries(secondary());
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  vi.setSystemTime(new Date(start.getTime() + 71_001));
  await client.refetchQueries(primary());
  await client.refetchQueries(secondary());
  await expect
    .element(page.getByRole("status"))
    .toMatchTextContent("Refresh failing for over a minute: Activity");
  expect(status.element().querySelector("time")?.dateTime).toBe(
    new Date(start.getTime() + 71_001).toISOString(),
  );
  failing = false;
  await client.refetchQueries(primary());
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect
    .poll(() => status.element().querySelector("time")?.dateTime)
    .toBe(new Date(start.getTime() + 71_001).toISOString());
});

it("excludes cached queries from pages that are no longer mounted", async () => {
  await expect.element(page.getByLabelText("Last updated", { exact: true })).toBeVisible();
  failing = true;
  await client.refetchQueries(primary());
  vi.setSystemTime(new Date(start.getTime() + 90_000));
  const NextPage = () => {
    useQuery(secondary());
    return <PageHeading title="Next page" />;
  };
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RefreshProvider>
          <NextPage />
        </RefreshProvider>
      </QueryClientProvider>,
    ),
  );
  await client.refetchQueries(secondary());
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect
    .poll(
      () =>
        page.getByLabelText("Last updated", { exact: true }).element().querySelector("time")
          ?.dateTime,
    )
    .toBe(new Date(start.getTime() + 90_000).toISOString());
});

it("tracks the newest poll, ignores static and disabled observers, and drops queries that stop polling", async () => {
  const ConditionalPage = () => {
    useQuery({
      ...primary(),
      refetchInterval: (query) => (query.state.data === "finished" ? false : 2_000),
    });
    useQuery({ ...secondary(), refetchInterval: false });
    useQuery({ ...secondary(), enabled: () => false, refetchInterval: 60_000 });
    return <PageHeading title="Run" />;
  };
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RefreshProvider>
          <ConditionalPage />
        </RefreshProvider>
      </QueryClientProvider>,
    ),
  );
  vi.setSystemTime(new Date(start.getTime() + 5_000));
  await client.refetchQueries(primary());
  await expect
    .poll(() => host.querySelector("time")?.dateTime)
    .toBe(new Date(start.getTime() + 5_000).toISOString());
  vi.setSystemTime(new Date(start.getTime() + 10_000));
  client.setQueryData(secondary().queryKey, "static refresh");
  await expect
    .poll(() => host.querySelector("time")?.dateTime)
    .toBe(new Date(start.getTime() + 5_000).toISOString());
  client.setQueryData(primary().queryKey, "finished");
  await expect
    .element(page.getByLabelText("Last updated", { exact: true }))
    .not.toBeInTheDocument();
});
