import { TurnSource } from "@usine/core/conversation";
import { ItemNumber } from "@usine/core/item";
import { ProjectId } from "@usine/core/project";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { BoardItemLink, BoardTaskView, ProjectView } from "@usine/orchestrator/operator";
import { assert, expect, it } from "vitest";
import { configurationFixture } from "~/lib/configuration/fixture";
import { changeTasks } from "~/lib/projects/fixture";
import {
  type ReferenceData,
  type ReferenceScope,
  referenceProject,
  resolveReference,
} from "~/lib/references/resolve";
import type { Reference } from "~/lib/references/syntax";
import { taskOverview } from "~/lib/tasks/fixture";

const project = ProjectId.make("basaltbytes-usine");
const repository = RepositoryName.make("basaltbytes/usine");
const revision = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const scope: ReferenceScope = {
  project,
  repository: undefined,
  sources: [TurnSource.make({ repository, revision })],
};

const board = (overview = taskOverview()): ProjectView => {
  const view = overview.projects[0];
  assert(view !== undefined);
  return view;
};

const other = RepositoryName.make("acme/web");

/**
 * Returns the board of a project with a second repository, `acme/web`, whose task has items #40
 * and #7 in place of the backlog task #12. `basaltbytes/usine` has #40 too.
 */
const twoRepositories = (): ProjectView => {
  const view = board(
    changeTasks(taskOverview(), (task) =>
      task.number === 12
        ? BoardTaskView.make({
            ...task,
            repository: other,
            title: "Port the reader",
            number: ItemNumber.make(7),
            items: [40, 7].map((number) => {
              const [item] = task.items;
              assert(item !== undefined);
              return BoardItemLink.make({
                ...item,
                number: ItemNumber.make(number),
                url: `https://github.com/${other}/issues/${number}`,
              });
            }),
          })
        : task,
    ),
  );
  return ProjectView.make({ ...view, repositories: [repository, other] });
};

const data = (overrides: Partial<ReferenceData> = {}): ReferenceData => ({
  scope,
  board: board(),
  configuration: configurationFixture(),
  ...overrides,
});

const task = (number: number, from: RepositoryName | null = null): Reference => ({
  _tag: "Task",
  repository: from,
  number: ItemNumber.make(number),
});

const resolvedTask = (reference: Reference, input = data()) => {
  const resolution = resolveReference(reference, input);
  return resolution._tag === "Task" ? resolution.task.number : resolution;
};

it("resolves any item of a task on the board to that task", () => {
  expect(resolvedTask(task(40))).toBe(42);
  expect(resolvedTask(task(41))).toBe(42);
  expect(resolvedTask(task(12, repository))).toBe(12);
});

it("links a number that no card has to GitHub in the project's repository", () => {
  expect(resolveReference(task(999), data())).toEqual({
    _tag: "GitHub",
    url: "https://github.com/basaltbytes/usine/issues/999",
  });
  expect(resolveReference(task(999, RepositoryName.make("acme/app")), data())).toEqual({
    _tag: "Text",
  });
});

it("keeps a task as text until the member can read its project's board", () => {
  expect(resolveReference(task(40), data({ board: undefined }))).toEqual({ _tag: "Text" });
  expect(referenceProject(task(40, RepositoryName.make("acme/app")), scope, [board()])).toBe(
    undefined,
  );
  expect(referenceProject(task(40, repository), { ...scope, project: undefined }, [board()])).toBe(
    project,
  );
});

it("finds a run on the board by its ID", () => {
  const resolution = resolveReference({ _tag: "Run", run: RunId.make("run-again") }, data());
  assert(resolution._tag === "Run");
  expect([resolution.project, resolution.run.loop, resolution.run.state]).toEqual([
    project,
    "fix-ci",
    "Running",
  ]);
});

it("opens the run page of a run ID that the board doesn't show", () => {
  const closed = RunId.make("0f3c9a1b2d4e5f60718293a4b5c6d7e8");
  expect(resolveReference({ _tag: "Run", run: closed }, data())).toEqual({
    _tag: "RunPage",
    project,
    run: closed,
  });
  expect(resolveReference({ _tag: "Run", run: closed }, data({ board: undefined }))).toEqual({
    _tag: "Text",
  });
});

it("resolves a number in the repository it names, or the scope's, and keeps one that two repositories have as text", () => {
  const input = (repositoryScope?: RepositoryName) =>
    data({ board: twoRepositories(), scope: { ...scope, repository: repositoryScope } });
  const named = (reference: Reference, within?: RepositoryName) => {
    const resolution = resolveReference(reference, input(within));
    return resolution._tag === "Task"
      ? [resolution.task.repository, resolution.task.number]
      : resolution;
  };
  expect(named(task(40, repository))).toEqual([repository, 42]);
  expect(named(task(40, other))).toEqual([other, 7]);
  expect(named(task(40), other)).toEqual([other, 7]);
  expect(named(task(40), repository)).toEqual([repository, 42]);
  expect(named(task(40))).toEqual({ _tag: "Text" });
  expect(named(task(7))).toEqual([other, 7]);
  // #7 is only on acme/web's card, so basaltbytes/usine#7 is the issue on GitHub.
  expect(named(task(7, repository))).toEqual({
    _tag: "GitHub",
    url: "https://github.com/basaltbytes/usine/issues/7",
  });
  expect(named(task(7), repository)).toEqual({
    _tag: "GitHub",
    url: "https://github.com/basaltbytes/usine/issues/7",
  });
});

it("looks a name up as a loop, an agent, a worker, a label, then a run", () => {
  const name = (value: string) => resolveReference({ _tag: "Name", name: value }, data());
  expect(name("review-pr")).toEqual({ _tag: "Configuration", kind: "loop", name: "review-pr" });
  expect(name("developer")).toEqual({ _tag: "Configuration", kind: "agent", name: "developer" });
  expect(name("eu-1")).toEqual({ _tag: "Configuration", kind: "worker", name: "eu-1" });
  expect(name("ready-for-review")).toMatchObject({
    _tag: "Label",
    label: { name: "ready-for-review", color: "d93f0b" },
  });
  expect(name("run-approve")).toMatchObject({ _tag: "Run", run: { state: "Waiting" } });
  expect(name("ghost")).toEqual({ _tag: "Text" });
  expect(
    resolveReference({ _tag: "Name", name: "review-pr" }, data({ configuration: undefined })),
  ).toEqual({ _tag: "Text" });
});

it("links a source line under a mounted repository at the commit the turn read", () => {
  const source = (path: string, line = 36, end: number | null = null) =>
    resolveReference({ _tag: "Source", path, line, end }, data());
  expect(source("basaltbytes/usine/packages/executor/src/supervisor/storage.ts")).toEqual({
    _tag: "GitHub",
    url: `https://github.com/basaltbytes/usine/blob/${revision}/packages/executor/src/supervisor/storage.ts#L36`,
  });
  expect(source("/conversation/workspace/BasaltBytes/usine/docs/a b.md", 3, 9)).toEqual({
    _tag: "GitHub",
    url: `https://github.com/basaltbytes/usine/blob/${revision}/docs/a%20b.md#L3-L9`,
  });
  for (const outside of [
    "executor/src/supervisor/storage.ts",
    "acme/app/src/a.ts",
    "basaltbytes/usine/../site/a.ts",
    "basaltbytes/usine/",
  ])
    expect(source(outside)).toEqual({ _tag: "Text" });
  expect(
    resolveReference(
      { _tag: "Source", path: "basaltbytes/usine/a.ts", line: 1, end: null },
      data({ scope: { ...scope, sources: [] } }),
    ),
  ).toEqual({ _tag: "Text" });
});
