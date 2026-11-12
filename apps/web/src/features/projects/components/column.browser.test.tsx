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

const render = (lane: BoardLaneView, project = ProjectId.make("board-test")) => {
  root?.unmount();
  root = createRoot(host);
  flushSync(() =>
    root?.render(
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
  const unmapped = fixtureLane("Unmapped");
  render(
    ReadOnlyBoardLaneView.make({
      id: unmapped.id,
      name: unmapped.name,
      sources: unmapped.sources,
      origin: unmapped.origin,
      items: fixtureLane("Done").items,
    }),
  );
  await expect.element(rail("Unmapped", 1)).toHaveAttribute("aria-expanded", "false");
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
