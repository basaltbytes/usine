import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProjectNotFound } from "@/components/project-not-found";
import { ProjectBoard } from "../../../../board/board.tsx";
import { deskQuery } from "../../../../desk/query.ts";
import { overviewQuery } from "../../../../overview.ts";
import { useOpenRun } from "../../../../open-run.ts";

const BoardRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const openRun = useOpenRun();
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A refetch after the loader ran can remove the project.
  if (project === undefined) return <ProjectNotFound />;
  return (
    <ProjectBoard
      project={project}
      loops={data.loops}
      stalled={desk.data?.notMoving ?? []}
      disabled={data._tag === "NeedsSetup"}
      openRun={openRun}
    />
  );
};

export const Route = createFileRoute("/projects/$owner/$name/")({ component: BoardRoute });
