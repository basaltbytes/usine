import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { dayTimeLabel } from "../src/operator-copy.ts";
import { routeTree } from "../src/route-tree.gen.ts";
import { configurationFixture } from "./configuration-fixture.ts";
import "../src/index.css";

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(
    ["overview"],
    new ReadyOverview({ projects: [], loops: [], needsYou: [] }),
  );
  queryClient.setQueryData(["configuration"], configurationFixture());
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

const mount = async (path: string, width: number) => {
  await page.viewport(width, 900);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  await router.load();
  // A tree rendered at the previous width keeps its sidebar mode until the media query's change
  // event arrives, which can be after the assertions on a busy machine.
  flushSync(() => root.render(null));
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await expect.element(page.getByRole("table").last()).toBeVisible();
};

const table = () => page.getByRole("table").last().element();

const visible = <T extends Element>(elements: Iterable<T>) =>
  [...elements].filter((element) => element.checkVisibility());

const headers = () => visible(table().querySelectorAll("th")).map((cell) => cell.textContent);

/** Returns the visible cells of the row whose first cell starts with `name`. */
const cells = (name: string) => {
  const row = [...table().querySelectorAll("tbody tr")].find((candidate) =>
    candidate.querySelector("td")?.textContent.startsWith(name),
  );
  if (row === undefined) throw new Error(`No row for ${name}`);
  return visible(row.querySelectorAll<HTMLTableCellElement>("td"));
};

/** Returns the number of lines the element with exactly `text` takes. */
const lines = (text: string) => {
  const element = page.getByText(text, { exact: true }).element();
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  return Math.round(element.getBoundingClientRect().height / lineHeight);
};

const fitsWithoutScrolling = (element: Element = table()) => {
  const container = element.parentElement;
  expect(container?.scrollWidth).toBeLessThanOrEqual(container?.clientWidth ?? 0);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
};

it("keeps each worker's slot cells on one line, at every width, without scrolling sideways", async () => {
  for (const width of [390, 768, 1024, 1280]) {
    await mount("/configuration/workers", width);
    const column = headers().indexOf("Slots in use");
    const slotLines = ["local", "eu-1", "eu-2", "hz-pool", "boat-pool"].map((worker) => {
      const slots = cells(worker)[column]?.querySelectorAll("[aria-hidden=true] > span") ?? [];
      return new Set([...slots].map((slot) => slot.getBoundingClientRect().top)).size;
    });
    expect(slotLines, `at ${width}px`).toEqual([1, 1, 1, 1, 1]);
    fitsWithoutScrolling();
  }
});

it("keeps the Repositories list within its width on a phone and beside the sidebar", async () => {
  for (const width of [390, 768]) {
    await mount("/configuration/repositories", width);
    fitsWithoutScrolling();
  }
});

it("gives a preflight check's description its own width, and the detail the rest of a wide table", async () => {
  await mount("/configuration/workers/eu-2", 1600);
  expect(headers()).toEqual(["Check", "Result", "Checked", "Detail"]);
  expect(lines("Machine, Git, memory, gateway, credentials, and Docker")).toBeLessThanOrEqual(2);
  expect(lines("Harness installed and logged in")).toBe(1);
  const [check, result, checked, detail] = cells("Worker");
  expect(detail?.textContent).toMatch(/^Docker isn't installed/u);
  const others = [check, result, checked].map((cell) => cell?.getBoundingClientRect().width ?? 0);
  expect(detail?.getBoundingClientRect().width).toBeGreaterThan(Math.max(...others));
});

it("folds a preflight check's time and message into its row on a narrow table, without scrolling sideways", async () => {
  for (const width of [390, 1280]) {
    await mount("/configuration/workers/local", width);
    await expect.poll(headers, { message: `at ${width}px` }).toEqual(["Check", "Result"]);
    const [check, result] = cells("Claude Code");
    expect(check?.innerText).toContain("Claude Code needs a subscription login.");
    expect(result?.innerText).toContain(dayTimeLabel("2026-10-20T09:15:00.000Z"));
    expect(lines("Machine, Git, memory, gateway, and credentials")).toBeLessThanOrEqual(2);
    fitsWithoutScrolling();
  }
});

it("keeps a provisioned worker's Machines table within the main column beside the facts rail", async () => {
  await mount("/configuration/workers/hz-pool", 1024);
  const machines = page.getByRole("table").first().element();
  expect(visible(machines.querySelectorAll("th")).map((cell) => cell.textContent)).toEqual([
    "Machine",
    "State",
    "Age",
    "For",
  ]);
  fitsWithoutScrolling(machines);
});
