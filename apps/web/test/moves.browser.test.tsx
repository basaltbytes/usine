import { QueryClient, QueryClientProvider, useSuspenseQuery } from "@tanstack/react-query";
import { LabelLaneSource, LaneName } from "@usine/config/board";
import { GitHubLabelName } from "@usine/config/label";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { RepositoryName } from "@usine/core/repository";
import {
  BoardItemLink,
  BoardLaneId,
  BoardTaskView,
  BoardView,
  FactoryOverview,
  ProjectView,
  ReadOnlyBoardLaneView,
  ReadyOverview,
  WritableBoardLaneView,
} from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ProjectBoard } from "../src/board/board.tsx";
import { overviewQuery } from "../src/overview.ts";
import { WithRouter } from "./memory-router.tsx";
import "../src/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    boardResponses: (overview: string, moveStatus: 200 | 503) => Promise<void>;
    delayBoardMove: () => Promise<void>;
    releaseBoardMove: () => Promise<void>;
  }
}

const repository = RepositoryName.make("board-test/repo");
const overview = (
  locations: ReadonlyArray<string> = ["Backlog", "Backlog"],
  revision = "",
  additionalLabels: ReadonlyArray<string> = [],
  projectRepository = repository,
) =>
  new ReadyOverview({
    loops: [],
    needsYou: [],
    projects: [
      new ProjectView({
        repository: projectRepository,
        status: "clear",
        runs: [],
        labels: [],
        preflightFindings: [],
        board: new BoardView({
          failures: [],
          lanes: ["Backlog", "Ready", "In progress"].map((name) => {
            const label = GitHubLabelName.make(name);
            return new WritableBoardLaneView({
              id: BoardLaneId.make(name),
              name: LaneName.make(name),
              sources: [new LabelLaneSource({ label })],
              labels: [label],
              origin: "authored",
              items: locations.flatMap((location, index) => {
                if (location !== name) return [];
                const link = new BoardItemLink({
                  itemKey: ItemKey.make(`${projectRepository}:${index + 1}`),
                  kind: "issue",
                  number: ItemNumber.make(index + 1),
                  title: `Task ${index + 1}${index === 1 ? revision : ""}`,
                  url: `https://github.com/${projectRepository}/issues/${index + 1}`,
                });
                return [
                  new BoardTaskView({
                    ...link,
                    state: "issue-open",
                    labels: [label, ...additionalLabels.map((name) => GitHubLabelName.make(name))],
                    items: [link],
                    pullRequest: null,
                    runs: [],
                    run: null,
                    needsYou: false,
                    conflicting: false,
                    loops: [],
                  }),
                ];
              }),
            });
          }),
        }),
      }),
    ],
  });

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const Board = ({ selected = repository }: { readonly selected?: RepositoryName }) => {
  const { data } = useSuspenseQuery(overviewQuery());
  const project = data.projects.find(({ repository }) => repository === selected);
  if (!project) return null;
  return (
    <ProjectBoard project={project} loops={[]} stalled={[]} disabled={false} openRun={() => {}} />
  );
};
const respond = (data = overview(), status: 200 | 503 = 200) =>
  commands.boardResponses(JSON.stringify(Schema.encodeSync(FactoryOverview)(data)), status);
const lane = (name: string) => page.getByLabelText(`${name} lane`);
const taskIn = (name: string, number = 1) =>
  lane(name).getByRole("link", { name: `Task ${number}`, exact: true });
const actions = (number: number) =>
  page.getByRole("button", { name: `Actions for issue #${number}`, exact: true });
const moveTo = () => page.getByRole("menuitem", { name: "Move to", exact: true });
const move = async (number: number, destination: string) => {
  await actions(number).click();
  await moveTo().click();
  await page.getByRole("menuitem", { name: destination, exact: true }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
};
/** Opens the card's menu to check whether Move to is offered, then closes it. */
const expectMovable = async (number: number, movable: boolean) => {
  await actions(number).click();
  await expect.element(page.getByRole("menu")).toBeVisible();
  const offered = expect.element(moveTo());
  await (movable ? offered.toBeVisible() : offered.not.toBeInTheDocument());
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
};

beforeEach(async () => {
  await page.viewport(1100, 800);
  await respond();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["overview"], overview());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WithRouter>
          <Board />
        </WithRouter>
      </QueryClientProvider>,
    ),
  );
  await expect.element(taskIn("Backlog")).toBeVisible();
});

afterEach(() => {
  flushSync(() => root.unmount());
  queryClient.clear();
  host.remove();
});

it("keeps a saved move in its destination through stale refreshes, then follows newer GitHub state", async () => {
  await move(1, "Ready");
  await expectMovable(2, true);
  await respond(overview(["Backlog", "Backlog"], " after refresh"));
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect
    .element(page.getByRole("link", { name: "Task 2 after refresh", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(taskIn("Ready")).toBeVisible();
  await expect.element(taskIn("Backlog")).not.toBeInTheDocument();
  await expect.element(lane("Ready").getByText("Backlog", { exact: true })).not.toBeInTheDocument();

  await respond(overview(["Backlog", "Backlog"], " after label change", ["bug"]));
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect
    .element(page.getByRole("link", { name: "Task 2 after label change", exact: true }))
    .toBeVisible();
  await expect.element(lane("Ready").getByText("bug", { exact: true })).toBeVisible();

  await respond(overview(["Ready", "Backlog"]));
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expectMovable(1, true);
  await expect.element(taskIn("Ready")).toBeVisible();

  await respond(overview(["In progress", "Backlog"]));
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect.element(taskIn("In progress")).toBeVisible();
});

it("keeps separate saved moves while another card can move, and accepts work that advances past Ready", async () => {
  await move(1, "Ready");
  await expectMovable(2, true);
  await move(2, "Ready");
  await expect.poll(async () => (await lane("Ready").getByRole("status").all()).length).toBe(2);
  await expect.poll(() => queryClient.isMutating()).toBe(0);
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect.poll(() => queryClient.isFetching({ queryKey: ["overview"] })).toBe(0);
  await expect.element(taskIn("Ready", 1)).toBeVisible();
  await expect.element(taskIn("Ready", 2)).toBeVisible();

  await respond(overview(["In progress", "Ready"]));
  await expect.element(taskIn("In progress", 1), { timeout: 5_000 }).toBeVisible();
  await expect.element(taskIn("Ready", 2)).toBeVisible();
  await expectMovable(1, true);
  await expectMovable(2, true);
});

it("finishes an in-flight move in its original project after navigating to another project", async () => {
  const other = RepositoryName.make("board-test/other");
  const data = new ReadyOverview({
    projects: [...overview().projects, ...overview(undefined, "", [], other).projects],
    loops: [],
    needsYou: [],
  });
  await respond(data);
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await commands.delayBoardMove();
  await move(1, "Ready");
  await expectMovable(2, false);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WithRouter>
          <Board selected={other} />
        </WithRouter>
      </QueryClientProvider>,
    ),
  );
  await expect.element(page.getByRole("heading", { name: other })).toBeVisible();
  await expectMovable(2, true);
  await commands.releaseBoardMove();
  await expect.poll(() => queryClient.isMutating()).toBe(0);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WithRouter>
          <Board />
        </WithRouter>
      </QueryClientProvider>,
    ),
  );
  await expect.element(taskIn("Ready")).toBeVisible();
  await expect.element(lane("Ready").getByRole("status")).toHaveTextContent("Saved on GitHub");
});

it("shows move progress even when the destination has no labels or Run details to display yet", async () => {
  const data = overview();
  const singleDestination = new ReadyOverview({
    ...data,
    projects: data.projects.map(
      (project) =>
        new ProjectView({
          ...project,
          board: new BoardView({
            failures: [],
            lanes: project.board.lanes.flatMap((lane) => {
              if (lane.name === "In progress") return [];
              return lane.name === "Backlog"
                ? [
                    new ReadOnlyBoardLaneView({
                      id: lane.id,
                      name: lane.name,
                      origin: "fallback",
                      sources: [],
                      items: lane.items.map((item) => new BoardTaskView({ ...item, labels: [] })),
                    }),
                  ]
                : [lane];
            }),
          }),
        }),
    ),
  });
  await respond(singleDestination);
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect.element(lane("In progress")).not.toBeInTheDocument();
  await move(1, "Ready");
  await expectMovable(2, true);
  await expect.element(lane("Ready").getByRole("status")).toHaveTextContent("Saved on GitHub");
});

it("keeps a saved destination when the project is reopened before GitHub is observed", async () => {
  await move(1, "Ready");
  await expectMovable(2, true);
  flushSync(() => root.render(null));
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <WithRouter>
          <Board />
        </WithRouter>
      </QueryClientProvider>,
    ),
  );
  await expect.element(taskIn("Ready")).toBeVisible();
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect.element(taskIn("Ready")).toBeVisible();
});

it("takes a keyboard drop on an empty lane before a lane with cards", async () => {
  await respond(overview(["Backlog", "In progress"]));
  await queryClient.refetchQueries({ queryKey: ["overview"] });
  await expect.element(taskIn("In progress", 2)).toBeVisible();
  const card = taskIn("Backlog").element().closest("[data-slot=card]");
  if (!(card instanceof HTMLElement)) throw new Error("No card for Task 1");
  card.focus();
  await userEvent.keyboard(" ");
  await userEvent.keyboard("{ArrowRight}");
  await expect.poll(() => lane("Ready").element().classList.contains("bg-muted/40")).toBe(true);
  await userEvent.keyboard(" ");
  await expect.element(taskIn("Ready")).toBeVisible();
  await expect.element(lane("Ready").getByRole("status")).toHaveTextContent("Saved on GitHub");
  await expect.element(taskIn("Backlog")).not.toBeInTheDocument();
});

it("restores the original lane and explains a failed GitHub write", async () => {
  await respond(overview(), 503);
  await move(1, "Ready");
  await expect.element(page.getByText("GitHub is unavailable")).toBeVisible();
  await expect.element(taskIn("Backlog")).toBeVisible();
  await expect.element(taskIn("Ready")).not.toBeInTheDocument();
});
