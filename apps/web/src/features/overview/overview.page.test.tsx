import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterContextProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerName } from "@usine/core/worker";
import {
  DegradedCheckView,
  PassedCheckView,
  PreflightCheckView,
  QueuedForWorkerView,
  StalledItemView,
  WorkerSlotsView,
  WorkerView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { assert, describe, it } from "vitest";
import { DeskNeedsYou } from "~/features/overview/overview.page";
import { LastOutcomes } from "~/features/overview/components/last-outcomes";
import { NotMoving } from "~/features/overview/components/not-moving";
import { RunningNow } from "~/features/overview/components/running-now";
import { WorkersLine } from "~/features/overview/components/workers-line";
import { nextCreationLine } from "~/lib/strings";
import { routeTree } from "~/route-tree.gen";
import { deskFixture } from "~/lib/desk/fixture";
import { machineFixture, pauseFixture } from "~/lib/runs/machine-fixture";

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
      "Waiting for attempt 1 to stop on local",
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

  it("shows a Worker that runs attempts without containers as degraded, not failed", () => {
    const degraded = new WorkerView({
      name: WorkerName.make("hz-worker-2"),
      slots: new WorkerSlotsView({ capacity: 1, leased: 0 }),
      preflight: new DegradedCheckView({
        checkedAt: "2026-10-20T04:00:00.000Z",
        message: "Docker isn't installed, so attempts run as the SSH user",
      }),
    });
    const html = render(<WorkersLine workers={[degraded]} now={now} />);
    assert.include(text(html), "hz-worker-2 0 of 1 slot in use Preflight degraded 6h ago");
    assert.include(html, "Docker isn&#x27;t installed");
    assert.notInclude(html, "text-destructive");
  });

  it("counts a provisioned Worker's machines and says when machine creation is paused", () => {
    const pause = pauseFixture();
    const provisioned = new WorkerView({
      name: WorkerName.make("hz-pool"),
      slots: new WorkerSlotsView({ capacity: 3, leased: 2 }),
      preflight: new PassedCheckView({ checkedAt: "2026-10-20T08:00:00.000Z" }),
      machines: [
        machineFixture({ state: "ready", id: "52341896", attemptId: "attempt-1" }),
        machineFixture({ runId: "run-other" }),
      ],
      provisioning: pause,
    });
    const html = render(<WorkersLine workers={[provisioned]} now={now} />);
    assert.include(
      text(html),
      `hz-pool 2 of 3 slots in use, 2 machines Preflight passed 2h ago Machine creation failed: no capacity. ${nextCreationLine(pause, now)}`,
    );
    assert.include(html, "Hetzner Cloud has no cx33 servers in nbg1 right now");
    const resumed = new WorkerView({
      ...provisioned,
      machines: [],
      provisioning: pauseFixture({ blocked: false }),
    });
    assert.strictEqual(
      text(render(<WorkersLine workers={[resumed]} now={now} />)),
      "Workers hz-pool 2 of 3 slots in use Preflight passed 2h ago",
    );
  });

  it("shows harness checks deferred to a provisioned Worker's first machine", () => {
    const deferred = new WorkerView({
      name: WorkerName.make("boat-pool"),
      slots: new WorkerSlotsView({ capacity: 2, leased: 0 }),
      preflight: Schema.decodeUnknownSync(PreflightCheckView)({
        _tag: "Deferred",
        checkedAt: "2026-10-20T09:00:00.000Z",
        message: "Checked on the worker's first machine each day",
      }),
    });
    const html = render(<WorkersLine workers={[deferred]} now={now} />);
    assert.include(text(html), "boat-pool 0 of 2 slots in use Preflight deferred 1h ago");
    assert.include(html, "Checked on the worker&#x27;s first machine each day");
    assert.notInclude(html, "text-destructive");
  });

  it("says a queued Run's machine is being created instead of waiting for a slot", () => {
    const queued = desk.notMoving.find(({ reason }) => reason._tag === "QueuedForWorker");
    if (queued?.reason._tag !== "QueuedForWorker") throw new Error("Expected a queued Run");
    const creating = new StalledItemView({
      ...queued,
      reason: new QueuedForWorkerView({
        run: queued.reason.run,
        ahead: 0,
        creating: machineFixture({ since: "2026-10-20T09:58:00.000Z" }),
      }),
    });
    const visible = text(
      render(<NotMoving stalled={[creating]} now={now} readOnly={false} polled />),
    );
    assert.include(visible, "Creating a Hetzner machine, started 2m ago");
    assert.notInclude(visible, "worker slot");
  });
});
