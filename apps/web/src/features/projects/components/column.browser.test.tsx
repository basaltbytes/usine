import { DndContext } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { administratorPermissions } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { type BoardLaneView, ReadOnlyBoardLaneView } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { BoardColumn } from "~/features/projects/components/column";
import { laneFoldMemory } from "~/features/projects/lib/folds";
import { boardOverview } from "~/lib/projects/fixture";
import { PermissionsContext } from "~/lib/permissions";
import { WithRouter } from "~/lib/testing/memory-router";
import "~/index.css";

let host: HTMLDivElement;
let root: Root | undefined;

const fixtureLane = (name: string): BoardLaneView => {
  const lane = boardOverview()
    .projects.flatMap(({ board }) => board.lanes)
    .find((candidate) => candidate.name === name);
  if (lane === undefined) throw new Error(`No ${name} lane`);
  return lane;
};

/** Renders `lane` in the mounted column, as the board does when it refreshes or switches project. */
const show = (lane: BoardLaneView, project = ProjectId.make("board-test")) => {
  const mounted = root ?? createRoot(host);
  root = mounted;
  flushSync(() =>
    mounted.render(
      <PermissionsContext.Provider value={administratorPermissions}>
        <QueryClientProvider client={new QueryClient()}>
          <WithRouter>
            <DndContext>
              <div className="flex h-200">
                <BoardColumn
                  project={project}
                  lane={lane}
                  lanes={[lane]}
                  flow={undefined}
                  catalog={new Map()}
                  targeted={false}
                  pending={false}
                  readOnly={false}
                  moves={[]}
                  stallOf={() => null}
                  openRun={() => undefined}
                  onMove={() => undefined}
                />
              </div>
            </DndContext>
          </WithRouter>
        </QueryClientProvider>
      </PermissionsContext.Provider>,
    ),
  );
};

/** Renders `lane` in a new column. */
const render = (lane: BoardLaneView, project = ProjectId.make("board-test")) => {
  flushSync(() => root?.unmount());
  root = undefined;
  show(lane, project);
};

const withItems = (lane: BoardLaneView, items: BoardLaneView["items"]) =>
  ReadOnlyBoardLaneView.make({
    id: lane.id,
    name: lane.name,
    sources: lane.sources,
    origin: lane.origin,
    items,
  });

const rail = (name: string, count: number) =>
  page.getByRole("button", { name: `${name} ${count}`, exact: true });
const foldButton = (name: string) =>
  page.getByRole("button", { name: `Fold ${name}`, exact: true });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = undefined;
  host.remove();
});

it("starts the Unmapped lane open when it holds an open Item, with its cards visible", async () => {
  render(fixtureLane("Unmapped"));
  await expect.element(page.getByRole("heading", { name: "Unmapped 1" })).toBeVisible();
  await expect
    .element(page.getByLabelText("Unmapped cards").getByText(/^Investigate the reader/u))
    .toBeVisible();
  await expect.element(foldButton("Unmapped")).toHaveAttribute("aria-expanded", "true");
});

it("starts a lane that holds only closed Items folded to a rail with its count", async () => {
  render(fixtureLane("Done"));
  await expect.element(rail("Done", 1)).toHaveAttribute("aria-expanded", "false");
  render(withItems(fixtureLane("Unmapped"), fixtureLane("Done").items));
  await expect.element(rail("Unmapped", 1)).toHaveAttribute("aria-expanded", "false");
});

it("opens the Unmapped lane when an open Item arrives while the board is open", async () => {
  const unmapped = fixtureLane("Unmapped");
  show(withItems(unmapped, fixtureLane("Done").items));
  await expect.element(rail("Unmapped", 1)).toBeVisible();
  show(withItems(unmapped, [...fixtureLane("Done").items, ...unmapped.items]));
  await expect.element(page.getByRole("heading", { name: "Unmapped 2" })).toBeVisible();
  await expect.element(foldButton("Unmapped")).toHaveAttribute("aria-expanded", "true");
});

it("keeps a lane open when a saved choice folds a lane that the operator can't fold", async () => {
  const pullRequests = fixtureLane("Pull requests");
  laneFoldMemory(() => localStorage).write(ProjectId.make("board-test"), pullRequests.id, true);
  render(pullRequests);
  await expect.element(page.getByRole("heading", { name: "Pull requests 2" })).toBeVisible();
  expect(page.getByRole("button", { name: /^Fold /u }).elements()).toHaveLength(0);
});

it("remembers the operator's fold choice for each lane in this browser", async () => {
  render(fixtureLane("Unmapped"));
  await foldButton("Unmapped").click();
  await expect.element(rail("Unmapped", 1)).toBeVisible();
  render(fixtureLane("Unmapped"));
  await expect.element(rail("Unmapped", 1)).toBeVisible();

  render(fixtureLane("Done"));
  await rail("Done", 1).click();
  await expect.element(foldButton("Done")).toBeVisible();
  render(fixtureLane("Done"));
  await expect.element(foldButton("Done")).toBeVisible();

  // Another project's Unmapped lane keeps its default.
  render(fixtureLane("Unmapped"), ProjectId.make("other-project"));
  await expect.element(foldButton("Unmapped")).toBeVisible();
});

it("shows each project's own fold choice when the same column switches project", async () => {
  const unmapped = fixtureLane("Unmapped");
  show(unmapped, ProjectId.make("alpha"));
  await foldButton("Unmapped").click();
  await expect.element(rail("Unmapped", 1)).toBeVisible();

  show(unmapped, ProjectId.make("beta"));
  await expect.element(foldButton("Unmapped")).toHaveAttribute("aria-expanded", "true");

  show(unmapped, ProjectId.make("alpha"));
  await expect.element(rail("Unmapped", 1)).toBeVisible();
});

it("shows each lane's own fold choice when the same column shows another lane", async () => {
  const done = fixtureLane("Done");
  laneFoldMemory(() => localStorage).write(ProjectId.make("board-test"), done.id, false);
  show(fixtureLane("Unmapped"));
  await foldButton("Unmapped").click();
  await expect.element(rail("Unmapped", 1)).toBeVisible();

  show(done);
  await expect.element(foldButton("Done")).toHaveAttribute("aria-expanded", "true");
});
