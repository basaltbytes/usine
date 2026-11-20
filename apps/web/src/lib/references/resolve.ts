import type { TurnSource } from "@usine/core/conversation";
import type { ProjectId } from "@usine/core/project";
import { canonicalRepositoryName, type RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import {
  type BoardItemLink,
  boardTaskRuns,
  type BoardTaskView,
  type ConfigurationView,
  type LabelView,
  type ProjectView,
  type RunSummaryView,
} from "@usine/orchestrator/operator";
import { projectForRepository, projectId } from "~/lib/overview";
import type { Reference } from "~/lib/references/syntax";

/** Where usine text shows, which decides what its references name. */
export interface ReferenceScope {
  /** The project whose board has the tasks, runs, and labels, or `undefined` for the instance. */
  readonly project: ProjectId | undefined;
  /** The repository of `#<number>`, or `undefined` for any repository of `project`. */
  readonly repository: RepositoryName | undefined;
  /** The source that a supervisor turn read, which source lines link to. */
  readonly sources: ReadonlyArray<TurnSource>;
}

/** The configuration page kinds that a name can open. */
export type ConfigurationKind = "loop" | "agent" | "worker";

/** What a reference opens, or `Text` when usine knows nothing it names. */
export type Resolution =
  /** A task on the board, and its item whose number the text wrote. */
  | {
      readonly _tag: "Task";
      readonly project: ProjectId;
      readonly task: BoardTaskView;
      readonly item: BoardItemLink;
    }
  | { readonly _tag: "Run"; readonly project: ProjectId; readonly run: RunSummaryView }
  /** A run ID that the board doesn't show, such as an older closed run, on its run page. */
  | { readonly _tag: "RunPage"; readonly project: ProjectId; readonly run: RunId }
  | { readonly _tag: "Label"; readonly label: LabelView }
  | { readonly _tag: "Configuration"; readonly kind: ConfigurationKind; readonly name: string }
  /** An issue or pull request that the board doesn't show, or a source line, on GitHub. */
  | { readonly _tag: "GitHub"; readonly url: string }
  | { readonly _tag: "Text" };

/** What usine read for a reference; each value is `undefined` while it loads or can't be read. */
export interface ReferenceData {
  readonly scope: ReferenceScope;
  /** The full view of the project that `referenceProject` returned. */
  readonly board: ProjectView | undefined;
  readonly configuration: ConfigurationView | undefined;
}

const sameRepository = (left: RepositoryName, right: RepositoryName) =>
  canonicalRepositoryName(left) === canonicalRepositoryName(right);

/**
 * Returns the project whose board resolves `reference`: the project of a task's repository among
 * the `projects` the member can read, else the scope's project. A source line needs none.
 */
export const referenceProject = (
  reference: Reference,
  scope: ReferenceScope,
  projects: ReadonlyArray<ProjectView>,
): ProjectId | undefined => {
  if (reference._tag === "Source") return undefined;
  if (reference._tag === "Task" && reference.repository !== null) {
    const project = projectForRepository(projects, reference.repository);
    return project === undefined ? undefined : projectId(project);
  }
  return scope.project;
};

const boardTasks = (board: ProjectView): ReadonlyArray<BoardTaskView> =>
  board.board.lanes.flatMap(({ items }) => items);

const boardRepositories = (board: ProjectView): ReadonlyArray<RepositoryName> =>
  board.repositories.length === 0 ? [board.repository] : board.repositories;

/**
 * Returns the task of `#<number>` on `board`: the one task with that item in the reference's
 * repository, else in the scope's, else in any of the project's. Returns the issue or pull request
 * on GitHub when no card has it and its repository is the project's, and `Text` otherwise.
 */
const resolveTask = (
  { repository, number }: Extract<Reference, { readonly _tag: "Task" }>,
  scope: ReferenceScope,
  board: ProjectView,
): Resolution => {
  const within = repository ?? scope.repository;
  const named = boardTasks(board).flatMap((task) => {
    const item = task.items.find((member) => member.number === number);
    return item !== undefined && (within === undefined || sameRepository(task.repository, within))
      ? [{ task, item }]
      : [];
  });
  const [found] = named;
  if (found !== undefined)
    return named.length === 1
      ? { _tag: "Task", project: projectId(board), ...found }
      : { _tag: "Text" };
  const repositories = boardRepositories(board);
  const on =
    within === undefined
      ? repositories.length === 1
        ? repositories[0]
        : undefined
      : repositories.find((member) => sameRepository(member, within));
  return on === undefined
    ? { _tag: "Text" }
    : { _tag: "GitHub", url: `https://github.com/${on}/issues/${number}` };
};

const boardRun = (board: ProjectView, id: string): RunSummaryView | undefined =>
  [...(board.runs ?? []), ...boardTasks(board).flatMap(boardTaskRuns)].find((run) => run.id === id);

const configurationEntry = (
  configuration: ConfigurationView,
  name: string,
): Resolution | undefined => {
  const kind: ConfigurationKind | undefined = configuration.loops.some((loop) => loop.name === name)
    ? "loop"
    : configuration.agents.some((agent) => agent.name === name)
      ? "agent"
      : configuration.workers.some((worker) => worker.name === name)
        ? "worker"
        : undefined;
  return kind === undefined ? undefined : { _tag: "Configuration", kind, name };
};

/** Returns the path of a file under the source of `repository`, or `undefined` outside it. */
const pathIn = (repository: RepositoryName, path: string): string | undefined => {
  const prefix = `${canonicalRepositoryName(repository)}/`;
  const lower = path.toLowerCase();
  // A path from the working directory starts with the repository; an absolute one has it inside.
  const relative = lower.startsWith(prefix);
  const inside = lower.indexOf(`/${prefix}`);
  if (!relative && inside < 0) return undefined;
  const file = path.slice((relative ? 0 : inside + 1) + prefix.length);
  const segments = file.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? file
    : undefined;
};

/** Returns the GitHub page of a source line at the commit that the turn read. */
const resolveSource = (
  { path, line, end }: Extract<Reference, { readonly _tag: "Source" }>,
  sources: ReadonlyArray<TurnSource>,
): Resolution => {
  for (const { repository, revision } of sources) {
    const file = pathIn(repository, path.replace(/^\.\//u, ""));
    if (file === undefined) continue;
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    const lines = end === null ? `L${line}` : `L${line}-L${end}`;
    return {
      _tag: "GitHub",
      url: `https://github.com/${repository}/blob/${revision}/${encoded}#${lines}`,
    };
  }
  return { _tag: "Text" };
};

/**
 * Returns what `reference` opens with `data`: a task or a run on the board, a source line on
 * GitHub at the commit the turn read, a loop, agent, or worker page, or a repository label. A
 * name is looked up in that order, then as the ID of a run on the board. A run ID that the board
 * doesn't show opens the run page in the board's project.
 */
export const resolveReference = (reference: Reference, data: ReferenceData): Resolution => {
  const { scope, board, configuration } = data;
  if (reference._tag === "Source") return resolveSource(reference, scope.sources);
  if (reference._tag === "Name" && configuration !== undefined) {
    const entry = configurationEntry(configuration, reference.name);
    if (entry !== undefined) return entry;
  }
  if (board === undefined) return { _tag: "Text" };
  switch (reference._tag) {
    case "Task":
      return resolveTask(reference, scope, board);
    case "Run": {
      const run = boardRun(board, reference.run);
      return run === undefined
        ? { _tag: "RunPage", project: projectId(board), run: reference.run }
        : { _tag: "Run", project: projectId(board), run };
    }
    case "Name": {
      const label = board.labels?.find((candidate) => candidate.name === reference.name);
      if (label !== undefined) return { _tag: "Label", label };
      const run = boardRun(board, reference.name);
      return run === undefined ? { _tag: "Text" } : { _tag: "Run", project: projectId(board), run };
    }
  }
};
