import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ProjectView, ReadyOverview } from "@usine/orchestrator/operator";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { overviewQuery } from "~/lib/overview";
import { boardOverview } from "~/lib/projects/fixture";
import { WithRouter } from "~/lib/testing/memory-router";
import { useProjectLinks } from "./use-project-links";

const repository = RepositoryName.make("Other/API");
const Links = () => {
  const links = useProjectLinks();
  return (
    <>
      <Link {...links.board(repository)}>Board</Link>
      <Link {...links.task(repository, "42")}>Task</Link>
      <Link {...links.run(repository, RunId.make("run-42"))}>Run</Link>
      <Link {...links.board(RepositoryName.make("removed/repo"))}>Overview</Link>
    </>
  );
};

it("links a second repository directly to its project and keeps its task identity", () => {
  const [original] = boardOverview().projects;
  if (original === undefined) throw new Error("Missing fixture project");
  const client = new QueryClient();
  client.setQueryData(
    overviewQuery().queryKey,
    new ReadyOverview({
      ...boardOverview(),
      projects: [
        new ProjectView({
          ...original,
          id: ProjectId.make("product"),
          repositories: [original.repository, RepositoryName.make("other/api")],
        }),
      ],
    }),
  );
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <WithRouter>
        <Links />
      </WithRouter>
    </QueryClientProvider>,
  );
  expect(html).toContain('href="/projects/product"');
  expect(html).toContain('href="/projects/product/tasks/42?repository=Other%2FAPI"');
  expect(html).toContain('href="/projects/product/runs/run-42"');
  expect(html).toContain('href="/"');
  client.clear();
});
