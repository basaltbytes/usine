import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vitest";
import { DeskNeedsYou } from "../src/desk/desk.tsx";
import { LastOutcomes } from "../src/desk/last-outcomes.tsx";
import { NotMoving } from "../src/desk/not-moving.tsx";
import { RunningNow } from "../src/desk/running-now.tsx";
import { WorkersLine } from "../src/desk/workers-line.tsx";
import { routeTree } from "../src/route-tree.gen.ts";
import { deskFixture } from "./desk-fixture.ts";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const { desk, empty, overview } = deskFixture(now);

/** Renders `node` to static HTML inside a router and query client. */
const render = (node: ReactNode) => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>{node}</RouterContextProvider>
    </QueryClientProvider>,
  );
};

const text = (html: string) =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("Desk", () => {
  it("says nothing needs attention and when polling last checked", () => {
    const html = text(render(<DeskNeedsYou needs={[]} polls={desk.polls} now={now} />));
    assert.include(html, "Needs attention");
    assert.include(html, "Nothing needs attention");
    assert.include(html, "Last checked 2m ago");
  });

  it("lists the Needs attention entries with their actions", () => {
    const html = text(
      render(<DeskNeedsYou needs={overview.needsYou} polls={desk.polls} now={now} />),
    );
    assert.include(html, "start-dev: approval needed");
    assert.include(html, "Question from start-dev");
    assert.include(html, "Cycle budget exhausted");
    assert.include(html, "Reset cycle budget");
    assert.notInclude(html, "Nothing needs attention");
  });

  it("says nothing is running and how many worker slots are free", () => {
    const html = text(render(<RunningNow running={[]} workers={empty.workers} now={now} />));
    assert.strictEqual(html, "Nothing running, 3 of 3 worker slots free");
  });

  it("lists each Attempt in flight with its Worker, last activity, and open warnings", () => {
    const html = render(<RunningNow running={desk.running} workers={desk.workers} now={now} />);
    const visible = text(html);
    assert.include(html, 'title="Issue #403, open"');
    assert.include(visible, "Operator desk replaces the Projects home");
    assert.include(visible, "hz-worker-1");
    assert.include(visible, "1m ago");
    assert.include(visible, "local silent since");
    assert.include(visible, "researcher: provider unreachable, 27 retries since");
    assert.include(html, 'href="/projects/basaltbytes/usine/runs/run-desk-403"');
  });

  it("says nothing is stalled, or that no poll has finished yet", () => {
    assert.strictEqual(
      text(render(<NotMoving stalled={[]} now={now} readOnly={false} polled />)),
      "Nothing stalled",
    );
    assert.strictEqual(
      text(render(<NotMoving stalled={[]} now={now} readOnly={false} polled={false} />)),
      "Not checked yet",
    );
  });

  it("gives each stalled Item its reason and only the action that moves it", () => {
    const html = render(<NotMoving stalled={desk.notMoving} now={now} readOnly={false} polled />);
    const visible = text(html);
    for (const sentence of [
      "Waiting for approval",
      "Question from the agent",
      "Cycle budget used, 3 rounds",
      "Failed 3h ago: Agent failure",
      "Canceled 9h ago, unchanged since",
      "review-fix paused",
      "Waiting for a free worker slot, behind 2 runs",
      "Waiting for the next poll",
    ]) {
      assert.include(visible, sentence);
    }
    const buttons = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/gu)].map(
      ([, label]) => label,
    );
    assert.deepStrictEqual(buttons, [
      "Approve",
      "Mark answered",
      "Reset cycle budget",
      "Retry",
      "Run again",
      "Run again",
      "Run again",
      "Resume",
    ]);
    assert.include(html, 'href="/projects/basaltbytes/usine/runs/run-canceled-345"');
  });

  it("offers no action on stalled Items while the factory needs setup", () => {
    const html = render(<NotMoving stalled={desk.notMoving} now={now} readOnly polled />);
    assert.notInclude(html, "<button");
  });

  it("says there are no recent runs", () => {
    assert.strictEqual(text(render(<LastOutcomes outcomes={[]} now={now} />)), "No recent runs");
  });

  it("lists the Runs that closed last with their outcome and pull request", () => {
    const html = render(<LastOutcomes outcomes={desk.lastOutcomes} now={now} />);
    const visible = text(html);
    assert.include(visible, "Succeeded");
    assert.include(visible, "Failed");
    assert.include(visible, "Canceled");
    assert.include(html, 'href="https://github.com/basaltbytes/usine/pull/402"');
    assert.include(visible, "#402");
    assert.include(html, 'href="/projects/basaltbytes/usine/runs/run-done-399"');
  });

  it("shows each Worker's slots in use and its last preflight", () => {
    const visible = text(render(<WorkersLine workers={desk.workers} now={now} />));
    assert.include(visible, "local 1 of 2 slots in use Preflight passed 7h ago");
    assert.include(visible, "hz-worker-1 1 of 1 slot in use Preflight failed 6h ago");
  });
});
