import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { ProjectView } from "@usine/orchestrator/operator";
import { expect, it } from "vitest";
import { boardOverview } from "~/lib/projects/fixture";
import { projectForRepository, projectParams } from "./overview";

it("resolves a task route through any project member and rejects unassigned repositories", () => {
  const [original] = boardOverview().projects;
  if (original === undefined) throw new Error("Missing fixture project");
  const second = RepositoryName.make("board-test/second");
  const project = new ProjectView({
    ...original,
    id: ProjectId.make("product"),
    repositories: [original.repository, second],
  });
  expect(projectForRepository([project], second)).toBe(project);
  expect(projectParams([project], RepositoryName.make("Board-Test/Second"))).toEqual({
    project: "product",
  });
  expect(projectParams([project], RepositoryName.make("board-test/unassigned"))).toBeUndefined();
  expect(projectForRepository([project], RepositoryName.make("Board-Test/Second"))).toBe(project);
  expect(projectForRepository([project], original.repository)).toBe(project);
  expect(
    projectForRepository([project], RepositoryName.make("board-test/unassigned")),
  ).toBeUndefined();
});
